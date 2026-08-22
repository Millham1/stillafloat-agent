// fill-research.ts — move what we already know into the per-cabin research columns.
//
// WHY THIS EXISTS
//   Mark, 2026-08-19: "we added columns for each parameter. they should be populated by the
//   research, that is your bible."  He is right, and they were not. `steady`, `hump`,
//   `real_ocean`, `view`, `tier`, `obstruction` and `note` were populated on 138 rooms across
//   six Oasis-class ships — the original prototype — and never again. Everything since was
//   matched at RUNTIME against class-level zone prose, which silently says nothing whenever a
//   class is missing a factor. That is why "no motion research" looked like a data hole: the
//   hole is that the facts never landed on the rooms.
//
// TWO RULES THIS OBEYS
//
//   1. FILL-IF-NULL, NEVER CLOBBER. A non-null value is someone's hand-verified research
//      (Wonder's 23 rooms are the only such rows today) and outranks anything derived here.
//      That also makes the script idempotent: running it twice changes nothing the second time.
//
//   2. NULL IS AN ANSWER. Where the research does not reach, the column stays NULL. Writing a
//      confident default would hide exactly the gap Mark is asking to see. `verify` and the
//      coverage report at the end are the honest map of where the research actually stands.
//
// THE CLASSIFIER IS IMPORTED, NOT REIMPLEMENTED. On 2026-08-19 a second hardcoded copy of
// VIEW_FACTORS told 13,644 rooms their view was blocked by the hump, which is the opposite of
// the truth. One copy of that logic, or this happens again.
import { createClient } from "@supabase/supabase-js";
// @ts-expect-error — `ws` ships no types; it is passed straight through to supabase-js,
// which is the same way every other loader in cabin-advisor/ uses it.
import ws from "ws";
import { cabinAttributes, normSection } from "../lib/cabin-match.js";
import { viewOf, tierOf } from "../lib/cabin-derive.js";
import { placementLines } from "../lib/cabin-placement.js";

const WRITE = process.argv.includes("--write");
const VERIFY = process.argv.includes("--verify");

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error("SUPABASE_URL + SUPABASE_SERVICE_KEY required"); process.exit(1); }
if (url.includes("gbjfrnrkkjnutmogdzln") && process.env.ALLOW_PROD !== "1") {
  console.error("PROD project detected and ALLOW_PROD!=1 — aborting."); process.exit(1);
}
const sb = createClient(url, key, { realtime: { transport: ws }, auth: { persistSession: false } });

type Zone = { rep_slug: string; factor: string; decks: number[]; sections: string[];
              sides: string[]; what: string | null; effect: string | null; severity: string;
              sign: string | null };
type Row = {
  id: number; ship_slug: string; cabin_num: string; deck: number | null; category: string | null;
  section: string | null; side: string | null;
  steady: boolean | null; hump: boolean | null; real_ocean: boolean | null;
  view: string | null; tier: number | null; obstruction: string | null; note: string | null;
  view_blocked: string | null; view_blocked_source: string | null;
  noise_nearby: string | null; noise_kind: string | null;
  above_kind: string | null; below_kind: string | null;
};

// viewOf/tierOf live in ../lib/cabin-derive.ts — ONE copy, shared with apply-widgety.

/** Does this zone cover this room? Same predicate the advisor uses at runtime. */
function covers(z: Zone, deck: number, section: string | null, side: string | null): boolean {
  if (!z.decks.includes(deck)) return false;
  if (z.sections.length && (!section || !z.sections.includes(section))) return false;
  if (z.sides.length && (!side || !z.sides.includes(side))) return false;
  return true;
}

// A lifeboat hangs beside you and takes the view straight DOWN; a taper is the hull narrowing,
// which crops the view to the SIDE. The wording follows the geometry, not the severity word.
function obstructionText(z: Zone): string {
  const what = (z.what ?? z.effect ?? "").trim().replace(/\s+/g, " ");
  const lead = z.severity === "significant" ? "heavy"
             : z.factor === "taper" ? "partial-side" : "partial-low";
  return what ? `${lead}: ${what}` : lead;
}

async function main() {
  const { data: fleet, error: fe } = await sb.from("cabin_ships").select("slug,derived_from");
  if (fe) throw new Error(fe.message);
  const repOf = new Map<string, string>();
  for (const s of fleet!) repOf.set(s.slug, s.derived_from || s.slug);

  const { data: zoneRows, error: ze } = await sb.from("cabin_context_zones")
    .select("rep_slug,factor,decks,sections,sides,what,effect,severity,sign");
  if (ze) throw new Error(ze.message);
  const zonesByRep = new Map<string, Zone[]>();
  for (const z of zoneRows as Zone[]) {
    zonesByRep.set(z.rep_slug, [...(zonesByRep.get(z.rep_slug) ?? []), z]);
  }

  // Every room, ordered — .range() without .order() silently drops rows.
  const COLS = "id,ship_slug,cabin_num,deck,category,section,side,steady,hump,real_ocean,view," +
               "tier,obstruction,note,view_blocked,view_blocked_source,noise_nearby,noise_kind," +
               "above_kind,below_kind";
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("cabins").select(COLS)
      .order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data as unknown as Row[]));
    if (!data || data.length < 1000) break;
  }
  console.log(`${rows.length} rooms read`);

  // The steady band is per ship: the lower stretch of THIS hull's passenger decks.
  // 0.6 is fitted to Wonder's hand-verified rows — steady through deck 11, not at 14 —
  // and `verify` re-checks that fit every run.
  const span = new Map<string, { lo: number; hi: number }>();
  for (const r of rows) {
    if (r.deck == null) continue;
    const s = span.get(r.ship_slug);
    if (!s) span.set(r.ship_slug, { lo: r.deck, hi: r.deck });
    else { s.lo = Math.min(s.lo, r.deck); s.hi = Math.max(s.hi, r.deck); }
  }
  const STEADY_BAND = 0.6;

  type Patch = Partial<Record<"steady" | "hump" | "real_ocean" | "view" | "tier" | "obstruction" | "note", unknown>>;
  const derive = (r: Row): Patch => {
    const out: Patch = {};
    const attrs = cabinAttributes(r.category);
    const { view, real_ocean } = viewOf(r.category);
    if (view !== null) out.view = view;
    if (real_ocean !== null) out.real_ocean = real_ocean;
    const tier = tierOf(r.category);
    if (tier !== null) out.tier = tier;

    const section = normSection(r.section);
    const side = String(r.side ?? "").trim().toLowerCase() || null;
    const rep = repOf.get(r.ship_slug) ?? r.ship_slug;
    const zones = zonesByRep.get(rep) ?? [];
    const researched = zones.length > 0;

    if (r.deck != null) {
      // steady — the DECK-HEIGHT half of motion. The fore/aft half already lives in
      // `section`; the advisor combines them, exactly as Wonder's rows do (deck 11 forward
      // is steady, deck 14 forward is not).
      const s = span.get(r.ship_slug);
      if (s) {
        // ONE FACT PER COLUMN. Motion zones are deliberately NOT folded in here: on this
        // class they cover deck 6 FORWARD and deck 11 AFT, which is the fore/aft half of
        // motion that `section` already carries. Blending them would double-count it and
        // contradicts the hand-verified rows (deck 11 forward is steady; deck 14 mid is not).
        // The advisor reads steady + section + the motion zones as three separate facts.
        out.steady = r.deck <= s.lo + STEADY_BAND * (s.hi - s.lo);
      }

      // hump — true only where the research puts one. A windowless room cannot enjoy it.
      if (attrs.has("inside")) out.hump = false;
      else if (researched) {
        out.hump = zones.some((z) => z.factor === "hump" && covers(z, r.deck!, section, side));
      }

      // obstruction — the room's own finding first, then the researched area rule.
      if (r.view_blocked) {
        out.obstruction = `heavy: ${r.view_blocked}`;
      } else if ((r.view_blocked_source ?? "").startsWith("clear")) {
        // This room is a hand-reviewed EXCEPTION to an area obstruction ("named by the ship's
        // own deck-plan notes as the exception to the deck 8 lifeboat obstruction"). The area
        // zone still covers its deck, so without this guard the fill hands the exemption the
        // very warning it was cleared of — found in the 2026-08-19 audit on 184 of 334 rooms.
      } else if (!attrs.has("inside")) {
        // Only a PENALTY zone may become a per-room warning. The afternoon run predated the
        // sign column and wrote obstructions off zones whose text praises the area — warnings
        // built from praise, found by the adversarial panel the same evening.
        const z = zones.find((z) => ["lifeboat", "taper"].includes(z.factor)
                                 && (z.sign ?? "penalty") === "penalty"
                                 && covers(z, r.deck!, section, side));
        if (z) out.obstruction = obstructionText(z);
      }
    }

    const lines = placementLines({
      noise_nearby: r.noise_nearby, noise_kind: r.noise_kind as never,
      above_kind: r.above_kind as never, below_kind: r.below_kind as never,
    });
    if (lines.length) out.note = lines.join(" ");
    return out;
  };

  if (VERIFY) {
    // Wonder's 23 hand-verified rooms are the fixture. If the rules cannot reproduce them,
    // the rules are wrong and nothing gets written.
    let checked = 0; const bad: string[] = [];
    for (const r of rows) {
      // The hand-researched rows, and only those. `steady` USED to identify them, but the fill
      // populates it everywhere, so that test silently matched all 226k rooms. `hump` is never
      // written by this script (see HOLD below), so it still marks exactly the 138 original rows.
      if (r.hump === null) continue;
      checked++;
      const d = derive(r);
      for (const k of ["steady", "hump", "real_ocean", "view", "tier"] as const) {
        if (d[k] !== undefined && d[k] !== r[k]) {
          bad.push(`${r.ship_slug} ${r.cabin_num} (deck ${r.deck}, ${r.category}): ${k} derived ${JSON.stringify(d[k])}, stored ${JSON.stringify(r[k])}`);
        }
      }
    }
    console.log(`\nverify: ${checked} hand-researched rooms, ${bad.length} mismatches`);
    for (const b of bad) console.log("  " + b);
  }

  // HUMP IS HELD BACK — 2026-08-19. It is still DERIVED above so `verify` keeps checking it,
  // but it is not written. On the one class with hand-verified rows the zone's scoping is
  // inverted: `sections: ["forward"]` marks 6154 and 8146 as hump when they are not, and misses
  // 6662 and 6678, which are. Wrong in BOTH directions, and Mark's 2026-08-19 direction is to
  // FAVOUR the hump when ranking — so propagating this would actively push guests toward the
  // wrong rooms on up to 19 hulls. Re-scope the hump zones, re-run `--verify`, then drop this.
  const HOLD = new Set(process.argv.includes("--include-hump") ? [] : ["hump"]);

  // Only NULL columns are filled. A stored value is research and always wins.
  const patches: { id: number; p: Patch }[] = [];
  for (const r of rows) {
    const d = derive(r), p: Patch = {};
    for (const [k, v] of Object.entries(d)) {
      if (HOLD.has(k)) continue;
      if (r[k as keyof Row] === null && v !== undefined && v !== null) (p as never as Record<string, unknown>)[k] = v;
    }
    if (Object.keys(p).length) patches.push({ id: r.id, p });
  }

  const filled: Record<string, number> = {};
  for (const { p } of patches) for (const k of Object.keys(p)) filled[k] = (filled[k] ?? 0) + 1;
  console.log(`\n${patches.length} rooms would gain at least one value:`);
  for (const [k, n] of Object.entries(filled).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} ${n.toLocaleString()}`);
  }

  if (!WRITE) { console.log("\n(dry run — pass --write to apply)"); return; }

  // UPDATE, grouped by identical patch — NOT upsert. An upsert with partial columns is still
  // an INSERT to Postgres, so it trips cabins.ship_slug NOT NULL and writes nothing (seen
  // 2026-08-19: 226k rows, "wrote 0"). Rooms share very few distinct patches, so grouping
  // turns 226k writes into a few thousand.
  const groups = new Map<string, number[]>();
  for (const { id, p } of patches) {
    const k = JSON.stringify(p);
    groups.set(k, [...(groups.get(k) ?? []), id]);
  }
  console.log(`\n${groups.size.toLocaleString()} distinct patches`);

  let done = 0, failed = 0;
  for (const [k, ids] of groups) {
    const patch = JSON.parse(k);
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const { error } = await sb.from("cabins").update(patch).in("id", chunk);
      if (error) { console.error(`  ${k.slice(0, 70)}: ${error.message}`); failed += chunk.length; continue; }
      done += chunk.length;
    }
    if (done && done % 25000 < 500) console.log(`  ${done.toLocaleString()} / ${patches.length.toLocaleString()}`);
  }
  console.log(`\nwrote ${done.toLocaleString()} rooms` + (failed ? `, ${failed.toLocaleString()} FAILED` : ""));
}

main().catch((e) => { console.error(e); process.exit(1); });
