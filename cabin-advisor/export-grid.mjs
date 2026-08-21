#!/usr/bin/env node
// Write a ship's grid from Supabase to data/cabins/<slug>-full.json.
//
// WHY. generate-advice.mjs reads a LOCAL json, but Supabase is the canonical
// home for cabin data (Mark, 2026-08-14) — local files are loading vehicles only.
// On 2026-08-18 that gap bit: norwegian-aqua's local grid still held the raw
// vision read, with COLOUR NAMES in the category field, so its advice corpus was
// written about cabins whose type was "gray" and told customers, in English and
// Spanish, that "10750 is a teal cabin". Any regeneration must start from a fresh
// export, never from whatever json happens to be on disk.
//
// Usage (on the dev box, where the service key lives):
//   scp export-grid.mjs saf-dev:/tmp/g/
//   ssh saf-dev 'cd /tmp/g && ln -sfn /root/saf-full/server/node_modules node_modules \
//     && set -a && . /opt/stillafloat/shared.env && set +a && node export-grid.mjs <slug>'
//   scp saf-dev:/tmp/g/<slug>-full.json cabin-advisor/data/cabins/

import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { writeFileSync } from "node:fs";

if (!globalThis.WebSocket) globalThis.WebSocket = ws;
const slug = process.argv[2];
if (!slug) { console.error("usage: node export-grid.mjs <ship-slug>"); process.exit(1); }
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY required"); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false } });

const { data: ship, error: se } = await db.from("cabin_ships")
  .select("slug,ship,line,class,derived_from").eq("slug", slug).maybeSingle();
if (se || !ship) { console.error(`no such ship: ${slug} ${se?.message ?? ""}`); process.exit(1); }

// Paged: /cabins caps at 1000 rows and a silent truncation here would quietly
// shrink the candidate set the advice is written from.
const cabins = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("cabins")
    .select("cabin_num,deck,category,section,side,view,real_ocean,hump,steady,obstruction,flagged_by_line,sleeps,note,obstructed")
    .eq("ship_slug", slug).order("deck").order("cabin_num").range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  cabins.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}

const out = {
  ship: ship.ship, line: ship.line, class: ship.class,
  source: `supabase export ${new Date().toISOString().slice(0, 10)}`,
  totalCabins: cabins.length,
  cabins: cabins.map((c) => {
    const o = {
      num: c.cabin_num, deck: c.deck, category: c.category,
      section: c.section, side: c.side, view: c.view, realOcean: c.real_ocean,
      hump: c.hump, steady: c.steady, obstruction: c.obstruction,
      flaggedByLine: c.flagged_by_line, sleeps: c.sleeps, note: c.note,
      obstructed: c.obstructed,
    };
    for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined) delete o[k];
    return o;
  }),
};

const counts = {};
for (const c of out.cabins) counts[c.category ?? "(none)"] = (counts[c.category ?? "(none)"] ?? 0) + 1;
writeFileSync(`${slug}-full.json`, JSON.stringify(out, null, 1));
console.log(`${slug}: ${out.totalCabins} cabins →  ${slug}-full.json`);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(28)} ${v}`);
