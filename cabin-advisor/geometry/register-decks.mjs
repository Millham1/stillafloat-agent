#!/usr/bin/env node
// register-decks.mjs — put a vision-read hull's per-deck image coordinates into ONE frame,
// then derive pos_along / pos_across, section, side, above_kind and below_kind from it.
//
// WHY. load-geometry.mjs stores x/y normalised 0..1 WITHIN EACH DECK IMAGE, and the
// operator's images are cropped differently deck by deck. On Norwegian Aura (2026-09-14)
// deck 12's image ends at the forward cabins, deck 14's carries 10% of empty bow beyond
// them, and deck 9's is a third the width. Reading x as "position along the ship" made
// forward rooms "aft", and above/below compared rooms that are nowhere near each other.
// The advice then told a guest two forward inside cabins were "starboard aft".
//
// HOW. NCL (and most lines) number cabins by frame: the same suffix stacks deck to deck
// (5100, 9100, 12100, 14100 are all the forward-most cabin). So each deck is fitted to a
// full-hull REFERENCE deck by least squares on shared suffixes, x_ref = a*x + b. A deck is
// only registered when >= MIN_MATCHES suffixes match and r^2 >= MIN_R2; otherwise its
// rooms get NULL positions — "unknown" costs less than a confident wrong side of the ship.
//
// Orientation is an input, not a guess: --bow right|left says which end of the images is
// the bow (Aura: right; the rounded stern with the Haven hot tubs is on the left). Side is
// decided within each deck: plans are drawn from above, so with the bow to the right the
// top of the image is PORT. Rooms within 6% of the deck's centre line are "center".
//
// Usage:  set -a && . /tmp/.devenv && set +a
//         node geometry/register-decks.mjs --ship norwegian-aura --ref-deck 12 --bow right [--write]
// Prod:   ALLOW_PROD=1 with prod creds.
import { createRequire } from "module";
const require = createRequire(process.env.HOME + "/Desktop/Claude Local/saf-runtime/node/node_modules/x.js");
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : d; };
const SHIP = opt("--ship"), REF = Number(opt("--ref-deck")), BOW = opt("--bow"), WRITE = argv.includes("--write");
if (!SHIP || !Number.isFinite(REF) || !["right", "left"].includes(BOW)) {
  console.error("usage: node register-decks.mjs --ship <slug> --ref-deck <n> --bow right|left [--write]"); process.exit(1);
}
const MIN_MATCHES = 25, MIN_R2 = 0.99, MIN_INLIER_SHARE = 0.5;
const SECTION_FWD = 0.34, SECTION_AFT = 0.67, CENTER_BAND = 0.06;
const ABOVE_SAME = 0.012, ABOVE_OPEN = 0.02;

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY required"); process.exit(1); }
if (url.includes("gbjfrnrkkjnutmogdzln") && process.env.ALLOW_PROD !== "1") { console.error("PROD detected and ALLOW_PROD!=1 — aborting."); process.exit(1); }
const sb = createClient(url, key, { realtime: { transport: ws }, auth: { persistSession: false } });
console.log(`target: ${url.replace(/^https:\/\/([a-z]{6}).*/, "$1…")}  mode: ${WRITE ? "WRITE" : "dry-run"}`);

const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("cabins").select("id,cabin_num,deck,x,y").eq("ship_slug", SHIP).order("id").range(from, from + 999);
  if (error) throw new Error(error.message);
  rows.push(...data); if (data.length < 1000) break;
}
const suffix = (r) => (/^\d+$/.test(r.cabin_num) && r.cabin_num.startsWith(String(r.deck))) ? r.cabin_num.slice(String(r.deck).length) : null;
const byDeck = new Map();
for (const r of rows) { if (r.x == null) continue; (byDeck.get(r.deck) ?? byDeck.set(r.deck, []).get(r.deck)).push(r); }
if (!byDeck.has(REF)) { console.error(`reference deck ${REF} has no geometry`); process.exit(1); }
const refX = new Map(byDeck.get(REF).map((r) => [suffix(r), Number(r.x)]).filter(([s]) => s));

// Consensus fit (RANSAC, deterministic). Cabin numbers only stack where both decks carry
// standard-width rooms. Where one deck has wide suites (Aura's aft Haven on 13-15) the
// suffixes run out of step, and a least-squares fit absorbs that as a tilt: deck 14's stern
// landed at 0.19 of the hull. Measured by hand: deck 14's suffixes 100-206 sit on
// x12 = x14 + 0.10 to within 0.01 and only the Haven suffixes leave that line. So every pair
// of well-separated matches proposes a line, the line most matches agree with (within
// INLIER_TOL) wins, and it is refitted on those inliers. The inlier share is gated.
const INLIER_TOL = 0.012;
function robustFit(pairs) {
  let best = null;
  const step = Math.max(1, Math.floor(pairs.length / 60));
  for (let i = 0; i < pairs.length; i += step) for (let j = i + 1; j < pairs.length; j += step) {
    const [x1, y1] = pairs[i], [x2, y2] = pairs[j];
    if (Math.abs(x2 - x1) < 0.2) continue;
    const a = (y2 - y1) / (x2 - x1), b = y1 - a * x1;
    if (a < 0.5 || a > 2) continue;                      // decks of one ship are drawn at similar scales
    const inl = pairs.filter(([x, y]) => Math.abs(a * x + b - y) <= INLIER_TOL);
    if (!best || inl.length > best.length) best = inl;
  }
  if (!best || best.length < 3) return { ...fit(pairs), inliers: 0, of: pairs.length };
  return { ...fit(best), inliers: best.length, of: pairs.length };
}
function fit(pairs) {
  const n = pairs.length, mx = pairs.reduce((a, p) => a + p[0], 0) / n, my = pairs.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  const a = sxy / sxx, b = my - a * mx;
  return { a, b, r2: (sxy * sxy) / (sxx * syy), n };
}

const reg = new Map(); // id -> {along, across, deck}
for (const [deck, list] of [...byDeck].sort((p, q) => p[0] - q[0])) {
  const pairs = list.map((r) => [Number(r.x), refX.get(suffix(r))]).filter(([, y]) => y != null);
  const f = deck === REF ? { a: 1, b: 0, r2: 1, n: list.length, inliers: list.length, of: list.length } : pairs.length >= 3 ? robustFit(pairs) : { a: NaN, b: NaN, r2: 0, n: pairs.length, inliers: 0, of: pairs.length };
  const ok = deck === REF || (f.inliers >= MIN_MATCHES && f.r2 >= MIN_R2 && f.inliers / f.of >= MIN_INLIER_SHARE);
  const ys = list.map((r) => Number(r.y)), ymin = Math.min(...ys), ymax = Math.max(...ys);
  console.log(`deck ${String(deck).padStart(2)}: ${String(list.length).padStart(4)} rooms, ${String(f.inliers).padStart(3)}/${String(f.of).padStart(3)} suffix matches kept, x_ref = ${f.a.toFixed(3)}x ${f.b >= 0 ? "+" : "-"} ${Math.abs(f.b).toFixed(3)}, r2 ${f.r2.toFixed(4)}  ${ok ? "REGISTERED" : "left NULL"}`);
  if (!ok) continue;
  for (const r of list) {
    const xr = Math.min(1, Math.max(0, f.a * Number(r.x) + f.b));
    const along = BOW === "right" ? 1 - xr : xr;                    // 0 = forward-most cabins, 1 = aft
    const across = ymax > ymin ? (Number(r.y) - ymin) / (ymax - ymin) : 0.5;
    reg.set(r.id, { deck, along, across });
  }
}

const decksReg = new Map();
for (const [id, p] of reg) (decksReg.get(p.deck) ?? decksReg.set(p.deck, []).get(p.deck)).push(p.along);
const nearest = (deck, along) => { const l = decksReg.get(deck); if (!l) return null; let m = Infinity; for (const a of l) m = Math.min(m, Math.abs(a - along)); return m; };
const kind = (deck, along) => { const d = nearest(deck, along); return d == null ? "unknown" : d <= ABOVE_SAME ? "cabins" : d > ABOVE_OPEN ? "open" : "unknown"; };

const updates = [];
for (const r of rows) {
  const p = reg.get(r.id);
  if (!p) { updates.push({ id: r.id, pos_along: null, pos_across: null, section: null, side: null, above_kind: null, below_kind: null }); continue; }
  // top of the image is port when the bow points right, starboard when it points left
  const topSide = BOW === "right" ? "port" : "starboard", bottomSide = topSide === "port" ? "starboard" : "port";
  updates.push({
    id: r.id, pos_along: Math.round(p.along * 1e4) / 1e4, pos_across: Math.round(p.across * 1e4) / 1e4,
    section: p.along < SECTION_FWD ? "forward" : p.along > SECTION_AFT ? "aft" : "mid",
    side: Math.abs(p.across - 0.5) < CENTER_BAND ? "center" : p.across < 0.5 ? topSide : bottomSide,
    above_kind: kind(p.deck + 1, p.along), below_kind: kind(p.deck - 1, p.along),
  });
}
const tally = {};
for (const u of updates) { const k = `${u.section ?? "null"}/${u.side ?? "null"}`; tally[k] = (tally[k] ?? 0) + 1; }
console.log("section/side:", JSON.stringify(tally));
if (!WRITE) { console.log("(dry run — pass --write)"); process.exit(0); }
for (let i = 0; i < updates.length; i += 200) {
  const chunk = updates.slice(i, i + 200);
  await Promise.all(chunk.map(({ id, ...cols }) => sb.from("cabins").update(cols).eq("id", id).then(({ error }) => { if (error) throw new Error(`${id}: ${error.message}`); })));
}
const note = `register-decks.mjs ${new Date().toISOString().slice(0, 10)}: decks fitted to deck ${REF} by stacked cabin-number suffix (consensus fit within ${INLIER_TOL}, r2>=${MIN_R2}, >=${MIN_MATCHES} inliers, >=${MIN_INLIER_SHARE * 100}% kept); bow ${BOW}; pos_along 0=forward-most cabins; section thirds; side from image top (${BOW === "right" ? "port" : "starboard"}); unregistered decks NULL.`;
const { data: sr } = await sb.from("cabin_ships").select("notes").eq("slug", SHIP).maybeSingle();
await sb.from("cabin_ships").update({ geometry_frame: "x-along", notes: { ...(sr?.notes ?? {}), position: note }, updated_at: new Date().toISOString() }).eq("slug", SHIP);
console.log(`wrote ${updates.length} rooms`);
