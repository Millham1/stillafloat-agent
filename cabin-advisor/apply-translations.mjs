// apply-translations.mjs — write the reviewed Spanish zone prose (migration 0026).
// Source: cabin-advisor/data/zone-translations.json — written by the zone-spanish workflow
// (10 writers + 2-agent QC sample; the 2 QC findings were hand-patched before this ran).
// Fill-if-null is NOT used here: translations are derived from what/effect, so a re-run with a
// better rendering SHOULD replace the old one. The EN columns are never touched.
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
const rows = JSON.parse(fs.readFileSync("zone-translations.json", "utf8"));
let done = 0, failed = 0;
for (const r of rows) {
  if (!WRITE) continue;
  const { error } = await sb.from("cabin_context_zones")
    .update({ what_es: r.what_es ?? null, effect_es: r.effect_es ?? null }).eq("id", r.id);
  if (error) { console.error(`id ${r.id}: ${error.message}`); failed++; continue; }
  done++;
}
console.log(WRITE ? `wrote ${done}, failed ${failed}` : `(dry run) ${rows.length} rows ready`);
