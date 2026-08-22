// load-advice.mjs — load one ship's pre-written advisor reasoning into Supabase.
//
// Usage:  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node load-advice.mjs <ship-slug>
//   reads advice/<slug>.json  (output of generate-advice.mjs)
//
// The agent reasons ONCE, up front, per ship per traveller archetype. This puts
// that output where the site can serve it, so nothing calls an LLM when a
// customer uses the finder. Idempotent: upserts on (ship_slug, archetype_id),
// so re-running after a regeneration replaces cleanly.
//
// Apply supabase/migrations/0009_cabin_advice.sql first. DEV before PROD.
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const slug = process.argv[2];
if (!slug) { console.error("usage: node load-advice.mjs <ship-slug>"); process.exit(1); }

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required"); process.exit(1); }

const dir = process.env.ADVICE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "advice");
const file = path.join(dir, `${slug}.json`);
if (!fs.existsSync(file)) { console.error(`no advice file: ${file}`); process.exit(1); }
const doc = JSON.parse(fs.readFileSync(file));

// The Spanish half, if it has been translated (translate-advice.mjs).
//
// This MUST travel with the English. The route serves Spanish visitors
// `recommendations_es ?? recommendations` — the ES rows wholesale, cabin numbers
// included — so loading regenerated English on top of an older Spanish set sends
// Spanish visitors to rooms nobody picked for them. Loading one without the other
// is a silent ES regression, which is why it lives in the same script rather than
// a second one somebody can forget to run.
const esFile = path.join(dir, `${slug}.es.json`);
const esByArchetype = fs.existsSync(esFile)
  ? (JSON.parse(fs.readFileSync(esFile)).byArchetype || {})
  : null;
if (!esByArchetype) {
  console.warn(
    `${slug}: no ${slug}.es.json — the Spanish columns will be CLEARED so the ES site\n` +
    `  falls back to this English text rather than serving the previous set's cabins.\n` +
    `  Run: node translate-advice.mjs ${slug}`,
  );
}

const byArchetype = doc.byArchetype || {};
const rows = Object.entries(byArchetype).map(([archetype_id, v]) => {
  const es = esByArchetype?.[archetype_id];
  return {
    ship_slug: slug,
    archetype_id,
    label: v.label || null,
    recommendations: v.recommendations || [],
    steer_clear: v.steerClear || v.steer_clear || [],
    model: doc.model || null,
    // Explicit nulls, not omission: an upsert that omits these would leave the
    // stale translation in place, which is the failure this guards against.
    label_es: es?.label_es ?? null,
    recommendations_es: es?.recommendations_es ?? null,
    steer_clear_es: es?.steer_clear_es ?? null,
  };
});

// A translation may never move anyone to a different room.
for (const r of rows) {
  if (!r.recommendations_es) continue;
  const en = r.recommendations.map((x) => String(x.cabin)).join(",");
  const es = r.recommendations_es.map((x) => String(x.cabin)).join(",");
  if (en !== es) { console.error(`${slug}/${r.archetype_id}: ES cabins differ from EN — refusing to load`); process.exit(1); }
}

if (!rows.length) { console.log(`${slug}: no archetypes in ${file} — nothing to load`); process.exit(0); }

if (!globalThis.WebSocket) globalThis.WebSocket = ws;   // Node < 22
const db = createClient(url, key, { auth: { persistSession: false } });

const { error } = await db.from("cabin_advice").upsert(rows, { onConflict: "ship_slug,archetype_id" });
if (error) { console.error(`${slug}: load failed —`, error.message); process.exit(1); }

const recs = rows.reduce((n, r) => n + (r.recommendations?.length || 0), 0);
console.log(`${slug}: ${rows.length} archetypes, ${recs} cabin recommendations loaded (model: ${doc.model || "?"})`);
