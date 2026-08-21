// e2e-sweep.mjs — every possible combination of answers, against the REAL database.
//
// Mark, 2026-08-17: "before you promote to PROD id like you to do another end to
// end test of the feature, including every possible combination of responses and
// verify the results are accurate."
//
// The unit sweep (server/src/lib/cabin-match.test.ts) runs the same combinations
// against a fixture built from local JSON files. That fixture turned out to be
// MORE OPTIMISTIC than the database — it reported 88.8% exact where the data
// supports 87.7% — so a green unit sweep was not evidence about production. This
// script closes that gap: it pulls the real rows, runs the real decision layer,
// and checks every result against the database independently.
//
// Run on the dev box (the service key lives there, never in a transcript):
//   /tmp/ctxload/run.sh e2e-sweep.mjs
//
// Checks, per case:
//   1. every cabin shown EXISTS on the ship shown (the Carnival-Spirit failure)
//   2. an "exact" outcome really is the requested type, per the DB's own category
//   3. any non-exact outcome carries a visitor-facing explanation
//   4. a seasick visitor is never LED with a cabin the research says moves
//   5. no dead ends, except ships we hold nothing for — which must show nothing

import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import {
  normalizeAnswers, pickArchetype, selectCabins, selectionNote,
  shipTypeInventory, classifyCategory, zonesForCabin, satisfies,
} from "./cabin-match.mjs";

if (!globalThis.WebSocket) globalThis.WebSocket = ws;
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// The questionnaire, exactly as room-concierge.html asks it.
const PARTY = ["couple", "family", "solo", "solo-group", "group"];
const ROOM = ["inside", "oceanview", "balcony", "suite", "balcony"];  // 5 options, "no idea" -> balcony
const PRIORITY = ["ocean", "quiet", "action", "space"];
const BUDGET = ["lean", "middle", "treat", "sky"];
const MOTION = [true, false, false];                                   // 3 options, 2 meanings
const DESTINATIONS = 8;   // does not affect cabin selection; multiplies the case count

// `order` is REQUIRED. Paging with .range() and no ORDER BY gives no stable row
// order, so pages drop and repeat rows — it cost the unit fixture 85,306 of
// 225,924 cabins on 2026-08-18. This sweep is meant to corroborate that fixture
// against live rows, so the same bug here would have made the two agree while
// both were wrong.
async function pageAll(table, select, order, filter) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    // Paging 226k rows trips Supabase's statement timeout now and then — twice on
    // 2026-08-19, which killed a 20-minute sweep both times. A harness that dies at random
    // teaches you to re-run until it is green, which is how a false green gets believed.
    let data, error;
    for (let attempt = 0; attempt < 4; attempt++) {
      let q = db.from(table).select(select).range(from, from + 999);
      for (const col of order ?? []) q = q.order(col);
      if (filter) q = filter(q);
      ({ data, error } = await q);
      if (!error) break;
      if (attempt === 3) break;
      console.log(`  ${table} rows ${from}-${from + 999}: ${error.message} — retry ${attempt + 1}/3`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

console.log("loading the fleet from Supabase...");
const ships = await pageAll("cabin_ships", "slug,ship,line,category_counts,derived_from,numbering_verified",
  ["slug"], (q) => q.eq("in_fleet", true));
const advice = await pageAll("cabin_advice", "ship_slug,archetype_id,recommendations", ["ship_slug","archetype_id"]);
const zonesAll = await pageAll("cabin_context_zones",
  "rep_slug,factor,decks,sections,sides,what,effect,matters_to,severity,sign,confidence,source", ["rep_slug","factor"]);
const ctxShips = await pageAll("cabin_context_ships", "ship_slug,rep_slug", ["ship_slug"]);
const cabins = await pageAll("cabins",
  "ship_slug,cabin_num,deck,category,section,side,above_kind,below_kind,noise_nearby,real_ocean,obstruction",
  ["ship_slug","cabin_num"]);

console.log(`  ${ships.length} ships, ${cabins.length.toLocaleString()} cabins, ${advice.length} advice rows, ${zonesAll.length} zones`);

const gridByShip = new Map();
for (const c of cabins) {
  let m = gridByShip.get(c.ship_slug);
  if (!m) gridByShip.set(c.ship_slug, (m = new Map()));
  m.set(String(c.cabin_num), c);
}
const adviceBySlug = new Map();
for (const a of advice) {
  const arr = adviceBySlug.get(a.ship_slug) ?? [];
  arr.push(a);
  adviceBySlug.set(a.ship_slug, arr);
}
const repByShip = new Map(ctxShips.map((r) => [r.ship_slug, r.rep_slug]));
const zonesByRep = new Map();
for (const z of zonesAll) {
  const arr = zonesByRep.get(z.rep_slug) ?? [];
  arr.push({ factor: z.factor, decks: z.decks ?? [], sections: z.sections ?? [], sides: z.sides ?? [],
    what: z.what, effect: z.effect, mattersTo: z.matters_to,
    severity: z.severity, sign: z.sign ?? "penalty", confidence: z.confidence, source: z.source });
  zonesByRep.set(z.rep_slug, arr);
}

const ARCHETYPE_ROWS = [...new Set(advice.map((a) => a.archetype_id))].map((archetype_id) => ({ archetype_id }));

let cases = 0;
let upgrades = 0;   // room satisfies the ask but its primary label is a pricier type
const outcomes = {};
const failures = [];
const note = (m) => { if (failures.length < 40) failures.push(m); };

console.log(`sweeping ${(PARTY.length*ROOM.length*PRIORITY.length*BUDGET.length*MOTION.length*DESTINATIONS).toLocaleString()} answer sets x ${ships.length} ships...`);

for (const s of ships) {
  const grid = gridByShip.get(s.slug) ?? new Map();
  const known = new Set(grid.keys());
  const inventory = shipTypeInventory(s.category_counts);
  const zones = zonesByRep.get(repByShip.get(s.slug)) ?? [];
  const rows = adviceBySlug.get(s.derived_from ?? s.slug) ?? [];

  // THE POOL IS THE WHOLE SHIP — the same as routes/cabins.ts. Until 2026-08-19 this sweep
  // built its pool from the stored recommendation lists, which production stopped doing when
  // Mark said "no preset lists for the advisor". So the sweep went green against a candidate
  // set the live endpoint never sees: it could not exercise an uncurated cabin winning, and
  // it never loaded noise_nearby / above_kind / below_kind at all.
  const storedByCabin = new Map();
  for (const r of rows) {
    for (const rec of r.recommendations ?? []) {
      const num = String(rec.cabin);
      if (!storedByCabin.has(num)) {
        storedByCabin.set(num, { archetypeId: r.archetype_id, rank: rec.rank ?? null });
      }
    }
  }
  const pool = [];
  for (const [num, f] of grid) {
    const stored = storedByCabin.get(num);
    pool.push({
      cabin: num, rank: stored?.rank ?? null, archetypeId: stored?.archetypeId ?? null,
      category: f.category ?? null, deck: f.deck ?? null, section: f.section ?? null,
      side: f.side ?? null,
      aboveKind: f.above_kind ?? null, belowKind: f.below_kind ?? null,
      noiseNearby: f.noise_nearby ?? null,
      // Added 2026-08-19 with the columns themselves. A sweep whose pool is missing a field
      // the live endpoint passes is testing a different program — the exact reason this
      // script's pool was rebuilt from the whole grid earlier the same day.
      realOcean: f.real_ocean ?? null, obstruction: f.obstruction ?? null,
    });
  }

  for (const party of PARTY)
  for (const room of ROOM)
  for (const priority of PRIORITY)
  for (const budget of BUDGET)
  for (const motion of MOTION) {
    const answers = normalizeAnswers({ party, room, priority, budget, motion });
    const chosen = pickArchetype(ARCHETYPE_ROWS, answers);
    const sel = selectCabins({ pool, chosenArchetypeId: chosen, answers, zones, knownCabins: known, inventory });
    cases += DESTINATIONS;
    outcomes[sel.outcome] = (outcomes[sel.outcome] ?? 0) + DESTINATIONS;

    // 1. nothing shown may be off-ship — verified against the DB, not against the pool
    for (const p of sel.picks) {
      if (!grid.has(p.cabin)) note(`${s.slug}: showed cabin ${p.cabin}, which is not on that ship`);
    }
    // 2. "exact" must really be exact, judged by the DB's own category string
    if (sel.outcome === "exact") {
      for (const p of sel.picks) {
        const dbCat = grid.get(p.cabin)?.category ?? null;
        // Judge by the rule the CODE uses — satisfies(), which is attribute-based — not by
        // classifyCategory(), which returns one best label for wording. "Ocean View Balcony"
        // has BOTH attributes, so serving it to an ocean-view asker is correct: the room does
        // have an ocean view. Asserting on the single label instead flagged thousands of those
        // and would have buried any real failure underneath them.
        if (satisfies(dbCat, sel.asked) && classifyCategory(dbCat) !== sel.asked) upgrades++;
        if (!satisfies(dbCat, sel.asked)) {
          note(`${s.slug}: asked ${sel.asked}, served ${p.cabin} which the DB calls "${dbCat}"`);
        }
      }
    } else if (sel.outcome !== "no-request" && !selectionNote(sel, s.ship, "en")) {
      // 3. a substitution the visitor is not told about is the original bug
      note(`${s.slug}: outcome ${sel.outcome} with no explanation`);
    }
    // 4. seasickness is answered by placement, not by archetype
    if (answers.seasick && sel.picks.length > 1 && zones.length) {
      // `factor` is the TOPIC; `sign` is the verdict (migration 0025). Six motion zones read
      // "midship cabins feel the least motion" / "less motion than higher decks, recommended
      // pick" — checking the factor alone marked the advisor wrong for leading with exactly the
      // room the research recommends (msc-magnifica 5063). Only a PENALTY zone is an indictment.
      const moves = (p) => zonesForCabin(
        { deck: p.deck, section: p.section, side: p.side, category: p.category }, zones)
        .some((z) => z.factor === "motion" && (z.sign ?? "penalty") === "penalty");
      if (moves(sel.picks[0]) && sel.picks.some((p) => !moves(p))) {
        note(`${s.slug}: seasick visitor led with ${sel.picks[0].cabin}, which sits in a motion zone`);
      }
    }
    // 5. no dead ends, unless we hold nothing — then showing nothing is right
    if (!sel.picks.length && sel.outcome !== "no-data") note(`${s.slug}: zero picks (${sel.outcome})`);
  }
}

console.log(`\nswept ${cases.toLocaleString()} cases across ${ships.length} ships`);
console.log("outcomes:", outcomes);
const exact = outcomes.exact ?? 0;
console.log(`exact: ${(100 * exact / cases).toFixed(2)}%`);
console.log(`served a room that satisfies the ask but is labelled a pricier type: ${upgrades.toLocaleString()}` +
            ` (${(100 * upgrades / Math.max(exact, 1)).toFixed(1)}% of exact answers)` +
            ` — correct per satisfies(), but worth Mark seeing: an ocean-view asker shown a balcony room`);
if (failures.length) {
  console.log(`\n${failures.length}+ FAILURES:`);
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
console.log("\nno failures.");
