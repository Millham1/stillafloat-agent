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

const byArchetype = doc.byArchetype || {};
const rows = Object.entries(byArchetype).map(([archetype_id, v]) => ({
  ship_slug: slug,
  archetype_id,
  label: v.label || null,
  recommendations: v.recommendations || [],
  steer_clear: v.steerClear || v.steer_clear || [],
  model: doc.model || null,
}));

if (!rows.length) { console.log(`${slug}: no archetypes in ${file} — nothing to load`); process.exit(0); }

if (!globalThis.WebSocket) globalThis.WebSocket = ws;   // Node < 22
const db = createClient(url, key, { auth: { persistSession: false } });

const { error } = await db.from("cabin_advice").upsert(rows, { onConflict: "ship_slug,archetype_id" });
if (error) { console.error(`${slug}: load failed —`, error.message); process.exit(1); }

const recs = rows.reduce((n, r) => n + (r.recommendations?.length || 0), 0);
console.log(`${slug}: ${rows.length} archetypes, ${recs} cabin recommendations loaded (model: ${doc.model || "?"})`);
