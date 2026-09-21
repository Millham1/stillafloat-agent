// load-geometry.mjs — load the 2026-08 fleet-geometry pass (per-deck PDF x/y)
// into the cabin database (cabin_ships + cabins).
//
// Usage:
//   set -a && source /tmp/.devenv && set +a          # DEV creds
//   node load-geometry.mjs                            # dry summary of planned writes
//   node load-geometry.mjs --write                    # perform the writes
//
// PROD re-run: point SUPABASE_URL/SUPABASE_SERVICE_KEY at prod AND set
// ALLOW_PROD=1 (the script refuses the prod project id without it), then
// `node load-geometry.mjs --write`. Everything is idempotent:
//  - x/y updates are upserts keyed on (ship_slug, cabin_num) — safe to re-run.
//  - top-up/new-ship inserts skip cabin_nums already present.
//  - ship-level counters are recomputed from the DB each run.
//
// What it does (mirrors the 2026-08-13 dev load — see load-report.md):
//  1. UPDATE x/y (+ fill where fill is null) for matched cabins on the 17
//     existing vision-line ships (Carnival + NCL reps). Never touches
//     category/section/side/moat columns.
//  2. INSERT geometry-only cabins for mardi-gras and carnival-vista only
//     (missing-grid top-up). Category from the ship's own empirically derived
//     color→category table (conf>=90%, n>=10), else null.
//  3. INSERT new ships: norwegian-aqua, norwegian-luna (Prima Plus),
//     msc-world-america/asia/atlantic (World). NCL categories via the
//     Norwegian Prima empirical color map (same-line PDF legend, conf>=90%,
//     n>=20); MSC categories null (no confident name-color legend).
//  4. Refresh cabin_ships total_cabins / decks / deck_count / category_counts
//     / notes.geometry for every ship it touched.
//
// Deliberately NOT loaded (see load-report.md): geometry-only cabins on other
// existing ships (may be non-cabin number reads), and the 19 geometry ships
// with no DB row (class-rep model) incl. carnival-celebration / carnival-jubilee /
// carnival-breeze / carnival-legend-us / carnival-luminosa-1 etc.

import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const require = createRequire(process.env.HOME + "/Desktop/Claude Local/saf-runtime/node/node_modules/x.js");
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const WRITE = process.argv.includes("--write");
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
const TODAY = new Date().toISOString().slice(0, 10);

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY required"); process.exit(1); }
if (url.includes("gbjfrnrkkjnutmogdzln") && process.env.ALLOW_PROD !== "1") {
  console.error("PROD project detected and ALLOW_PROD!=1 — aborting."); process.exit(1);
}
const sb = createClient(url, key, { realtime: { transport: ws }, auth: { persistSession: false } });
console.log(`target: ${url}  mode: ${WRITE ? "WRITE" : "dry-run"}`);

// ---------- fleet plan ----------
// existing DB ships that get x/y updates: geometry file -> db slug
const UPDATE_SHIPS = {
  "carnival-conquest-4": "carnival-conquest",
  "carnival-dream": "carnival-dream",
  "carnival-elation": "carnival-elation",
  "carnival-spirit-master-combo": "carnival-spirit",
  "carnival-splendor-master": "carnival-splendor",
  "carnival-sunshine-1": "carnival-sunshine",
  "carnival-vista": "carnival-vista",
  "mardi-gras": "mardi-gras",
  "norwegian-breakaway": "norwegian-breakaway",
  "norwegian-dawn": "norwegian-dawn",
  "norwegian-epic": "norwegian-epic",
  "norwegian-escape": "norwegian-escape",
  "norwegian-jewel": "norwegian-jewel",
  "norwegian-prima": "norwegian-prima",
  "norwegian-sky": "norwegian-sky",
  "norwegian-spirit": "norwegian-spirit",
  "pride-of-america": "pride-of-america",
};
const TOPUP_SHIPS = new Set(["mardi-gras", "carnival-vista"]); // geometry-only cabins inserted
const NEW_SHIPS = {
  "norwegian-aqua":     { slug: "norwegian-aqua",     ship: "Norwegian Aqua",     line: "Norwegian Cruise Line", class: "Prima Plus", catFrom: "ncl" },
  "norwegian-luna-ship":{ slug: "norwegian-luna",     ship: "Norwegian Luna",     line: "Norwegian Cruise Line", class: "Prima Plus", catFrom: "ncl" },
  "msc-world-america":  { slug: "msc-world-america",  ship: "MSC World America",  line: "MSC Cruises",           class: "World",      catFrom: null },
  "msc-world-asia":     { slug: "msc-world-asia",     ship: "MSC World Asia",     line: "MSC Cruises",           class: "World",      catFrom: null },
  "msc-world-atlantic": { slug: "msc-world-atlantic", ship: "MSC World Atlantic", line: "MSC Cruises",           class: "World",      catFrom: null },
};

// ---------- helpers ----------
// strip TRAILING deck-plan legend symbols (★ ■ † • * + = ➤ …) — these are
// footnote markers the vision pass captured, not part of the cabin number.
// No digit corrections are ever applied.
const stripSym = n => { const m = String(n).match(/^([0-9A-Za-z]+?)[^0-9A-Za-z]+$/); return m ? m[1] : String(n); };

// carnival-spirit-master-combo PDF contains each deck TWICE (two color-legend
// variants of the same plan). Keep the FIRST run of each deck number: it is the
// clean variant (no symbol-suffixed numbers, includes 8213) and matches the DB
// grid 1067/1068.
function resolveSpiritCombo(decks) {
  const seen = new Set(), first = [];
  for (const dk of decks) { if (seen.has(dk.deck)) continue; seen.add(dk.deck); first.push(dk); }
  return first;
}

function flatten(geom, gslug) {
  let decks = geom.decks;
  if (gslug === "carnival-spirit-master-combo") decks = resolveSpiritCombo(decks);
  const map = new Map(); // cleanNum -> {deck,x,y,color}
  for (const dk of decks) for (const c of dk.cabins) {
    const num = stripSym(c.num);
    if (!map.has(num)) map.set(num, { deck: dk.deck, x: c.x, y: c.y, color: c.color ?? null });
  }
  return map;
}

async function fetchDbCabins(slug) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("cabins")
      .select("id,cabin_num,deck,category,x,y,fill").eq("ship_slug", slug).range(from, from + 999);
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

async function upsertChunks(rows, cols) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("cabins").upsert(rows.slice(i, i + 500), { onConflict: "ship_slug,cabin_num" });
    if (error) throw new Error(`upsert (${cols}) @${i}: ${error.message}`);
  }
}
async function insertChunks(rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("cabins").insert(rows.slice(i, i + 500));
    if (error) throw new Error(`insert @${i}: ${error.message}`);
  }
}

// empirical color→category from matched pairs of ONE ship
function colorMap(gmap, dbRows, minConf, minN) {
  const byNum = new Map(dbRows.map(r => [String(r.cabin_num), r]));
  const tally = {};
  for (const [num, g] of gmap) {
    const r = byNum.get(num);
    if (!r || !g.color || !r.category) continue;
    (tally[g.color] ??= {})[r.category] = (tally[g.color][r.category] || 0) + 1;
  }
  const out = {};
  for (const [color, cats] of Object.entries(tally)) {
    const tot = Object.values(cats).reduce((a, b) => a + b, 0);
    const [top, n] = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
    if (tot >= minN && 100 * n / tot >= minConf) out[color] = top;
  }
  return out;
}

async function refreshShipRow(slug, extraNotes) {
  const db = await fetchDbCabins(slug);
  const decks = [...new Set(db.map(r => r.deck).filter(d => d != null))].sort((a, b) => a - b);
  const counts = {};
  for (const r of db) if (r.category) counts[r.category] = (counts[r.category] || 0) + 1;
  const uncat = db.filter(r => !r.category).length;
  const { data: cur } = await sb.from("cabin_ships").select("notes").eq("slug", slug).single();
  const notes = { ...(cur?.notes || {}), ...extraNotes };
  if (uncat) notes.uncategorized = `${uncat} cabins have category null (geometry insert, no confident color mapping).`;
  const { error } = await sb.from("cabin_ships").update({
    total_cabins: db.length, decks, deck_count: decks.length,
    category_counts: counts, notes, updated_at: new Date().toISOString(),
  }).eq("slug", slug);
  if (error) throw error;
  return db.length;
}

const geom = {};
for (const f of fs.readdirSync(OUT_DIR).filter(f => f.endsWith(".json")))
  geom[f.replace(/\.json$/, "")] = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f)));

const GEOM_NOTE = `x/y loaded ${TODAY} from official per-deck PDF geometry pass; normalized 0..1 within each deck strip image (strips of the same deck are separately normalized). fill = vision color name.`;

// ---------- 1+2: existing ships ----------
const summary = [];
for (const [gslug, slug] of Object.entries(UPDATE_SHIPS)) {
  const gmap = flatten(geom[gslug], gslug);
  const db = await fetchDbCabins(slug);
  const byNum = new Map(db.map(r => [String(r.cabin_num), r]));

  const updFill = [], updNoFill = [];
  for (const [num, g] of gmap) {
    const r = byNum.get(num);
    if (!r) continue;
    if (r.fill == null && g.color) updFill.push({ ship_slug: slug, cabin_num: num, x: g.x, y: g.y, fill: g.color });
    else updNoFill.push({ ship_slug: slug, cabin_num: num, x: g.x, y: g.y });
  }

  let inserts = [];
  if (TOPUP_SHIPS.has(slug)) {
    const cmap = colorMap(gmap, db, 90, 10); // this ship's own empirical mapping
    for (const [num, g] of gmap) {
      if (byNum.has(num)) continue;
      inserts.push({
        ship_slug: slug, cabin_num: num, deck: g.deck,
        category: (g.color && cmap[g.color]) || null,
        x: g.x, y: g.y, fill: g.color, obstructed: false,
      });
    }
  }

  if (WRITE) {
    await upsertChunks(updFill, "x,y,fill");
    await upsertChunks(updNoFill, "x,y");
    if (inserts.length) await insertChunks(inserts);
    const total = await refreshShipRow(slug, { geometry: GEOM_NOTE });
    summary.push({ slug, matched: updFill.length + updNoFill.length, inserted: inserts.length, total });
  } else {
    summary.push({ slug, matched: updFill.length + updNoFill.length, inserted: inserts.length, total: db.length + inserts.length });
  }
  console.log(`${slug}: matched=${updFill.length + updNoFill.length} inserted=${inserts.length}` +
    (inserts.length ? ` (categorized ${inserts.filter(i => i.category).length}, null ${inserts.filter(i => !i.category).length})` : ""));
}

// ---------- 3: new ships ----------
// NCL Prima-Plus categories via the Norwegian Prima empirical map (same line,
// same deck-plan color language). MSC: null (europa legend is hex-based and
// near-identical greens map to different categories — not confident).
const primaMap = colorMap(flatten(geom["norwegian-prima"], "norwegian-prima"), await fetchDbCabins("norwegian-prima"), 90, 20);
console.log("prima-derived NCL color map:", JSON.stringify(primaMap));

for (const [gslug, meta] of Object.entries(NEW_SHIPS)) {
  const g = geom[gslug];
  const gmap = flatten(g, gslug);
  const cmap = meta.catFrom === "ncl" ? primaMap : {};
  const existing = new Set((await fetchDbCabins(meta.slug)).map(r => String(r.cabin_num)));
  const rows = [];
  for (const [num, c] of gmap) {
    if (existing.has(num)) continue;
    rows.push({
      ship_slug: meta.slug, cabin_num: num, deck: c.deck,
      category: (c.color && cmap[c.color]) || null,
      x: c.x, y: c.y, fill: c.color, obstructed: false,
    });
  }
  if (WRITE) {
    const { error } = await sb.from("cabin_ships").upsert({
      slug: meta.slug, ship: meta.ship, line: meta.line, class: meta.class,
      source: "Official deck-plan PDF, geometry pass (vision-read, 2026-08)",
      source_detail: `source_pdf: ${g.source_pdf}`, extracted_on: TODAY,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    if (rows.length) await insertChunks(rows);
    const total = await refreshShipRow(meta.slug, {
      geometry: GEOM_NOTE,
      category: meta.catFrom === "ncl"
        ? "Partial: derived from the Norwegian Prima empirical color legend (>=90% consistent colors only); rest null."
        : "null — MSC color-name mapping not confident; fill keeps the raw color for a later pass.",
    });
    console.log(`${meta.slug}: NEW ship, inserted=${rows.length} total=${total} (categorized ${rows.filter(r => r.category).length})`);
  } else {
    console.log(`${meta.slug}: NEW ship, would insert ${rows.length} (categorized ${rows.filter(r => r.category).length})`);
  }
  summary.push({ slug: meta.slug, matched: 0, inserted: rows.length, total: rows.length + existing.size, isNew: true });
}

console.log("\nSUMMARY"); for (const s of summary) console.log(JSON.stringify(s));
process.exit(0);
