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

/**
 * Read every row, 1000 at a time, IN A STABLE ORDER.
 *
 * The order argument is not optional decoration. Without an ORDER BY, Postgres
 * makes no promise about row order between queries, so paging with .range()
 * silently drops some rows and repeats others. This ran unordered until
 * 2026-08-18 and the fixture was missing **85,306 of 225,924 cabins — 38% of the
 * fleet**. Worse than the gap: cabins the advice named but the paging had lost
 * were then written to the fixture as "not on this ship", so the sweep was
 * quietly asserting the phantom-cabin guard against rooms that DO exist
 * (Carnival Splendor's two suites, 7438 and 7447, among them).
 *
 * Order by a UNIQUE key — cabins is unique on (ship_slug, cabin_num).
 */
async function pageAll(table, select, order, filter) {
  const out = [];
  const seen = new Set();
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(select).range(from, from + 999);
    for (const col of order) q = q.order(col);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const row of data ?? []) {
      // Belt and braces: if ordering is ever lost again, fail loudly rather than
      // hand the test suite a quietly wrong fleet.
      const key = order.map((c) => row[c]).join("\u0000");
      if (seen.has(key)) throw new Error(`${table}: duplicate row across pages (${key}) — pagination is not stable`);
      seen.add(key);
      out.push(row);
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

const ships = await pageAll("cabin_ships", "slug,ship,line,category_counts,derived_from", ["slug"], (q) => q.eq("in_fleet", true));
const advice = await pageAll("cabin_advice", "ship_slug,archetype_id,recommendations,steer_clear", ["ship_slug","archetype_id"]);
const cabins = await pageAll("cabins", "ship_slug,cabin_num,deck,category,section,side,above_kind,below_kind,noise_nearby", ["ship_slug","cabin_num"]);

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

// THE POOL IS THE WHOLE SHIP, exactly as routes/cabins.ts now builds it.
//
// It used to be the union of the archetypes' pre-written picks, which meant the
// 1.3M-case sweep was exercising ~45 cabins per ship while production served the
// same 45 — fine, until production changed. On 2026-08-18 candidates became every
// room on the hull ("no preset lists for the advisor"), and a fixture still built
// from the stored corpus would have gone on reporting a confident green about a
// code path nobody was running. Coverage is the output surface: the fixture's
// input has to be production's input.
//
// Pool row: [cabin, archetypeId|null, rank|null, category, deck, section, side, isOnShip, aboveKind, belowKind, noiseNearby]
// archetypeId/rank are the stored reasoning where it exists — a tie-break, not a gate.
// isOnShip is explicit: a real cabin may legitimately have a null category, so
// "has facts" cannot stand in for "exists on this hull".
const out = {};
for (const s of ships) {
  const g = grid.get(s.slug) ?? new Map();
  const rows = bySlug.get(s.derived_from ?? s.slug) ?? [];
  const storedBy = new Map(), steer = [];
  for (const r of rows) {
    for (const rec of r.recommendations ?? []) {
      const n = String(rec.cabin);
      if (!storedBy.has(n)) storedBy.set(n, [r.archetype_id, rec.rank ?? null]);
    }
    for (const sc of r.steer_clear ?? []) {
      if (sc?.cabin) steer.push([String(sc.cabin), r.archetype_id, g.has(String(sc.cabin))]);
    }
  }
  const pool = [];
  for (const [n, f] of g) {
    const st = storedBy.get(n) ?? [null, null];
    pool.push([n, st[0], st[1], f.category ?? null, f.deck ?? null, f.section ?? null, f.side ?? null, 1, f.above_kind ?? null, f.below_kind ?? null, f.noise_nearby ?? null]);
  }
  // Cabins the corpus names that are NOT on this hull must still reach the sweep —
  // dropping them would hide the phantom-cabin guard the filter exists to enforce.
  for (const n of storedBy.keys()) {
    if (!g.has(n)) pool.push([n, storedBy.get(n)[0], storedBy.get(n)[1], null, null, null, null, 0, null, null, null]);
  }
  out[s.slug] = {
    ship: s.ship, line: s.line, derivedFrom: s.derived_from,
    categoryCounts: s.category_counts ?? {}, gridSize: g.size,
    pool, steer,
  };
}
process.stdout.write(JSON.stringify({ ships: out }));
