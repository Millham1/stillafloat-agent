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
  shipTypeInventory, classifyCategory, zonesForCabin,
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

async function pageAll(table, select, filter) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(select).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

console.log("loading the fleet from Supabase...");
const ships = await pageAll("cabin_ships", "slug,ship,line,category_counts,derived_from,numbering_verified",
  (q) => q.eq("in_fleet", true));
const advice = await pageAll("cabin_advice", "ship_slug,archetype_id,recommendations");
const zonesAll = await pageAll("cabin_context_zones",
  "rep_slug,factor,decks,sections,sides,what,effect,matters_to,severity,confidence,source");
const ctxShips = await pageAll("cabin_context_ships", "ship_slug,rep_slug");
const cabins = await pageAll("cabins", "ship_slug,cabin_num,deck,category,section,side");

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
    severity: z.severity, confidence: z.confidence, source: z.source });
  zonesByRep.set(z.rep_slug, arr);
}

const ARCHETYPE_ROWS = [...new Set(advice.map((a) => a.archetype_id))].map((archetype_id) => ({ archetype_id }));

let cases = 0;
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

  const pool = [];
  for (const r of rows) {
    for (const rec of r.recommendations ?? []) {
      const num = String(rec.cabin);
      const f = grid.get(num);
      pool.push({ cabin: num, rank: rec.rank ?? null, archetypeId: r.archetype_id,
        category: f?.category ?? null, deck: f?.deck ?? null, section: f?.section ?? null, side: f?.side ?? null });
    }
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
        if (classifyCategory(dbCat) !== sel.asked) {
          note(`${s.slug}: asked ${sel.asked}, served ${p.cabin} which the DB calls "${dbCat}"`);
        }
      }
    } else if (sel.outcome !== "no-request" && !selectionNote(sel, s.ship, "en")) {
      // 3. a substitution the visitor is not told about is the original bug
      note(`${s.slug}: outcome ${sel.outcome} with no explanation`);
    }
    // 4. seasickness is answered by placement, not by archetype
    if (answers.seasick && sel.picks.length > 1 && zones.length) {
      const moves = (p) => zonesForCabin(
        { deck: p.deck, section: p.section, side: p.side, category: p.category }, zones)
        .some((z) => z.factor === "motion");
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
if (failures.length) {
  console.log(`\n${failures.length}+ FAILURES:`);
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
console.log("\nno failures.");
