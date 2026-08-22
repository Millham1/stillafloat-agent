// apply-widgety.mjs — turn the Widgety deck-plan reads into categories, self-calibrated.
//
// Input: widgety-reads.json from widgety-categories.py — per ship|deck, every room number the
// operator's own plan shows, with its block colour. No legend exists on those images, so the
// calibration is the deck's own labeled rooms: learn colour->category from rooms the grid
// already knows, then apply to the rooms it doesn't — through the same gate as the empirical
// fill (a colour speaks only when >=95% of >=5 labeled rooms agree).
//
// The Atlantic quirk is handled by construction: Widgety serves World AMERICA's images under
// Atlantic's entry. Room numbers that don't exist on Atlantic simply never join, and the
// calibration runs against Atlantic's own labeled rooms, so a layout drift between sisters
// can only shrink coverage, never write a wrong room.
//
// Usage (on a box): node apply-widgety.mjs [--write]
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import fs from "fs";

const WRITE = process.argv.includes("--write");
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error("env missing"); process.exit(1); }
if (url.includes("gbjfrnrkkjnutmogdzln") && process.env.ALLOW_PROD !== "1") {
  console.error("PROD detected and ALLOW_PROD!=1 — aborting."); process.exit(1);
}
const sb = createClient(url, key, { realtime: { transport: ws }, auth: { persistSession: false } });
const reads = JSON.parse(fs.readFileSync("widgety-reads.json", "utf8"));

const rgb = (hex) => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
// Anti-aliasing sprays one block colour across nearby hexes, so matching needs tolerance —
// but on NCL plans white and light-grey are DIFFERENT categories sitting ~10 apart, so the
// tolerance must shrink with chroma or the merge invents a mixed colour that fails purity.
const chroma = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
const tol = (c) => (chroma(c) < 24 ? 12 : 36);

// ANCHORS POOL PER SHIP, NOT PER DECK. The palette belongs to the operator's plan set, so a
// deck whose unlabeled rooms are all one category (aqua deck 10: 139 unlabeled balconies)
// still calibrates from the labeled instances of that colour on OTHER decks.
const anchorsByShip = new Map();   // ship -> [{c:[r,g,b], cat}]
const gridByKey = new Map();       // ship|deck -> Map(num -> row)
for (const key2 of Object.keys(reads)) {
  const [ship, deckS] = key2.split("|");
  const { data: grid, error } = await sb.from("cabins")
    .select("id,cabin_num,category,view").eq("ship_slug", ship).eq("deck", Number(deckS));
  if (error) { console.error(`${key2}: ${error.message}`); continue; }
  gridByKey.set(key2, new Map(grid.map((r) => [r.cabin_num, r])));
}
for (const [key2, rooms] of Object.entries(reads)) {
  const ship = key2.split("|")[0];
  const byNum = gridByKey.get(key2); if (!byNum) continue;
  for (const r of rooms) {
    const g = byNum.get(r.num);
    if (!g || !g.category) continue;
    if (!anchorsByShip.has(ship)) anchorsByShip.set(ship, []);
    anchorsByShip.get(ship).push({ c: rgb(r.hex), cat: g.category });
  }
}

let totalApplied = 0;
for (const [key2, rooms] of Object.entries(reads)) {
  const ship = key2.split("|")[0];
  const byNum = gridByKey.get(key2); if (!byNum) continue;
  const anchors = anchorsByShip.get(ship) ?? [];

  // NEAREST-NEIGHBOUR, NOT EXACT HEX. The PNGs anti-alias, so one block colour samples as a
  // spray of nearby hexes; exact matching scattered aqua deck 10 into 130 singleton colours
  // and calibrated 1. Distance 36 is the same tolerance the Carnival chip matcher uses.
  const table = new Map();
  const tableFor = (hex) => {
    if (table.has(hex)) return table.get(hex);
    const c = rgb(hex);
    const m = new Map();
    const t36 = tol(c);
    for (const a of anchors) if (dist(a.c, c) <= Math.min(t36, tol(a.c))) m.set(a.cat, (m.get(a.cat) ?? 0) + 1);
    const tot = [...m.values()].reduce((x, y) => x + y, 0);
    let out = null;
    if (tot >= 5) {
      const [cat, top] = [...m.entries()].sort((x, y) => y[1] - x[1])[0];
      if (top / tot >= 0.95) out = { cat, top, tot };
    }
    table.set(hex, out);
    return out;
  };

  // apply to the rooms the grid can't name
  let applied = 0, unmatchedColour = 0, notInGrid = 0;
  for (const r of rooms) {
    const g = byNum.get(r.num);
    if (!g) { notInGrid++; continue; }
    if (g.category !== null || g.view !== null) continue;
    const t = tableFor(r.hex);
    if (!t) { unmatchedColour++; continue; }
    if (WRITE) {
      const { error: ue } = await sb.from("cabins").update({
        category: t.cat,
        category_source: `operator plan colour (Widgety asset), calibrated against ${t.top}/${t.tot} labeled rooms on this deck`,
      }).eq("id", g.id);
      if (ue) { console.error(`  ${ship} ${r.num}: ${ue.message}`); continue; }
    }
    applied++;
  }
  totalApplied += applied;
  console.log(`${key2}: ${rooms.length} read, ${anchors.length} ship anchors, ${applied} rooms ${WRITE ? "written" : "resolvable"}${unmatchedColour ? `, ${unmatchedColour} colour uncalibrated` : ""}${notInGrid ? `, ${notInGrid} numbers not in grid` : ""}`);
}
console.log(`\n${WRITE ? "wrote" : "would write"} ${totalApplied} rooms`);
