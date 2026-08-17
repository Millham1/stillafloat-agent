// dump-fixture.mjs — build the unit-test fixture FROM THE DATABASE.
//
// The fixture used to be generated from the local JSON grids, and it disagreed
// with the database: it reported 88.8% exact where the data supports 88.41%, so
// a green unit sweep was not evidence about what production would serve. The
// fixture is derived data; its source must be the same rows the API reads.
//
// Run on the dev box:  /tmp/ctxload/run.sh dump-fixture.mjs > cabin-pool.fixture.json

import { createClient } from "@supabase/supabase-js";
import ws from "ws";
if (!globalThis.WebSocket) globalThis.WebSocket = ws;
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

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

const ships = await pageAll("cabin_ships", "slug,ship,line,category_counts,derived_from", (q) => q.eq("in_fleet", true));
const advice = await pageAll("cabin_advice", "ship_slug,archetype_id,recommendations,steer_clear");
const cabins = await pageAll("cabins", "ship_slug,cabin_num,deck,category,section,side");

const grid = new Map();
for (const c of cabins) {
  let m = grid.get(c.ship_slug);
  if (!m) grid.set(c.ship_slug, (m = new Map()));
  m.set(String(c.cabin_num), c);
}
const bySlug = new Map();
for (const a of advice) {
  const arr = bySlug.get(a.ship_slug) ?? [];
  arr.push(a);
  bySlug.set(a.ship_slug, arr);
}

const out = {};
for (const s of ships) {
  const g = grid.get(s.slug) ?? new Map();
  const rows = bySlug.get(s.derived_from ?? s.slug) ?? [];
  const pool = [], steer = [], placement = {};
  for (const r of rows) {
    for (const rec of r.recommendations ?? []) {
      const n = String(rec.cabin), f = g.get(n);
      pool.push([n, r.archetype_id, rec.rank ?? null, f?.category ?? null, g.has(n)]);
      if (f) placement[n] = [f.deck, f.section, f.side];
    }
    for (const sc of r.steer_clear ?? []) {
      if (sc?.cabin) steer.push([String(sc.cabin), r.archetype_id, g.has(String(sc.cabin))]);
    }
  }
  out[s.slug] = {
    ship: s.ship, line: s.line, derivedFrom: s.derived_from,
    categoryCounts: s.category_counts ?? {}, gridSize: g.size,
    pool, steer, placement,
  };
}
process.stdout.write(JSON.stringify({ ships: out }));
