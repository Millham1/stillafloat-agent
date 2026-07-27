// load-cabins.mjs — load one ship's cabin data into Supabase (cabin_ships + cabins).
//
// Usage:  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node load-cabins.mjs <ship-slug>
//   reads  data/cabins/<slug>-full.json   (DeckMaps base grid — required)
//   merges data/cabins/<slug>.json        (curated moat layer — optional)
//
// Idempotent: replaces the ship's cabins each run. Service-role key required
// (RLS is service-role-only on these tables). Apply the migration first
// (supabase/migrations/0007_cabin_advisor.sql), and load DEV before PROD.
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const slug = process.argv[2];
if (!slug) { console.error("usage: node load-cabins.mjs <ship-slug>"); process.exit(1); }

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required"); process.exit(1); }

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "cabins");
const full = JSON.parse(fs.readFileSync(path.join(dir, `${slug}-full.json`)));
const curPath = path.join(dir, `${slug}.json`);
const cur = fs.existsSync(curPath) ? JSON.parse(fs.readFileSync(curPath)) : { cabins: [] };

const sb = createClient(url, key, { realtime: { transport: ws }, auth: { persistSession: false } });

const { error: se } = await sb.from("cabin_ships").upsert({
  slug, ship: full.ship, line: full.line, class: full.class, source: full.source,
  source_detail: full.sourceDetail, svg_version: full.svgVersion, extracted_on: full.extractedOn,
  deck_count: full.deckCount, total_cabins: full.totalCabins, decks: full.decks,
  category_counts: full.categoryCounts, color_legend: full.colorLegend, notes: full.notes,
  updated_at: new Date().toISOString(),
});
if (se) { console.error("cabin_ships upsert error", se); process.exit(1); }

await sb.from("cabins").delete().eq("ship_slug", slug);
const rows = full.cabins.map((c) => ({
  ship_slug: slug, cabin_num: String(c.num), deck: c.deck, category: c.category,
  section: c.section, side: c.side, x: c.x, y: c.y, fill: c.fill, obstructed: !!c.obstructed,
}));
for (let i = 0; i < rows.length; i += 500) {
  const { error } = await sb.from("cabins").insert(rows.slice(i, i + 500));
  if (error) { console.error("cabins insert error @", i, error); process.exit(1); }
}

let moat = 0;
for (const c of (cur.cabins || [])) {
  const { error } = await sb.from("cabins").update({
    view: c.view, real_ocean: c.realOcean, hump: c.hump, steady: c.steady,
    obstruction: c.obstruction, flagged_by_line: c.flaggedByLine, sleeps: c.sleeps,
    tour: c.tour, tier: c.tier, note: c.note,
  }).eq("ship_slug", slug).eq("cabin_num", String(c.id));
  if (!error) moat++;
}

const { count } = await sb.from("cabins").select("*", { count: "exact", head: true }).eq("ship_slug", slug);
console.log(`${slug}: loaded ${count} cabins, ${moat} moat rows enriched`);
process.exit(0);
