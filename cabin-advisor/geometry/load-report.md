# Fleet-geometry load — QC report (DEV, 2026-08-13)

Loaded by `load-geometry.mjs` (this directory) into the DEV Supabase project
(`vmbysqjvwfzmsrwgubib`). PROD was not touched. All numbers below are from the
pre-write QC pass and post-write verification against dev.

## What was loaded

- **17 existing ships** (Carnival + NCL vision-line reps): x/y updated on all
  matched cabins by `(ship_slug, cabin_num)`; `fill` set to the vision color
  name only where `fill` was null. category / section / side / moat columns
  never touched (verified: conquest 6452 kept category+section+side; 23 moat
  `view` rows unchanged).
- **2 top-up ships** (mardi-gras, carnival-vista): geometry-only cabins
  INSERTed as the missing-grid top-up.
- **5 new ships**: norwegian-aqua, norwegian-luna (Prima Plus),
  msc-world-america / -asia / -atlantic (World). Full cabin_ships + cabins.
- Ship rows refreshed: total_cabins, decks, deck_count, category_counts
  (recount of non-null categories), notes.geometry.

## QC table

| ship (db slug) | geometry | DB before | matched | % of DB | inserted | DB after | x/y coverage |
|---|---|---|---|---|---|---|---|
| carnival-conquest | 1490 | 1468 | 1464 | 99.7% | 0 | 1468 | 99.7% |
| carnival-dream | 1822 | 1807 | 1797 | 99.4% | 0 | 1807 | 99.4% |
| carnival-elation | 1095 | 1044 | 1042 | 99.8% | 0 | 1044 | 99.8% |
| carnival-spirit | 1068 (resolved) | 1068 | 1067 | 99.9% | 0 | 1068 | 99.9% |
| carnival-splendor | 1505 | 1482 | 1477 | 99.7% | 0 | 1482 | 99.7% |
| carnival-sunshine | 1501 | 1439 | 1438 | 99.9% | 0 | 1439 | 99.9% |
| carnival-vista | 1962 | 1725 | 1552 | 90.0% | 410 (37 categorized) | 2135 | 91.9% |
| mardi-gras | 2628 | 1555 | 1535 | 98.7% | 1093 (233 categorized) | 2648 | 99.2% |
| norwegian-breakaway | 1732 | 2023 | 1725 | 85.3% | 0 | 2023 | 85.3% |
| norwegian-dawn | 1166 | 1177 | 1153 | 98.0% | 0 | 1177 | 98.0% |
| norwegian-epic | 2122 | 2114 | 2103 | 99.5% | 0 | 2114 | 99.5% |
| norwegian-escape | 2171 | 2180 | 2162 | 99.2% | 0 | 2180 | 99.2% |
| norwegian-jewel | 1206 | 1198 | 1188 | 99.2% | 0 | 1198 | 99.2% |
| norwegian-prima | 1613 | 1606 | 1536 | 95.6% | 0 | 1606 | 95.6% |
| norwegian-sky | 995 | 1010 | 755 | 74.8% | 0 | 1010 | 74.8% |
| norwegian-spirit | 1025 | 1012 | 445 | 44.0% | 0 | 1012 | 44.0% |
| pride-of-america | 1106 | 1095 | 1069 | 97.6% | 0 | 1095 | 97.6% |
| norwegian-aqua (NEW) | 1776 | — | — | — | 1776 (962 categorized) | 1776 | 100% |
| norwegian-luna (NEW) | 1808 | — | — | — | 1808 (1005 categorized) | 1808 | 100% |
| msc-world-america (NEW) | 2457 | — | — | — | 2457 (0 categorized) | 2457 | 100% |
| msc-world-asia (NEW) | 2581 | — | — | — | 2581 (0 categorized) | 2581 | 100% |
| msc-world-atlantic (NEW) | 2384 | — | — | — | 2384 (0 categorized) | 2384 | 100% |

Post-load verification: ship_row total_cabins == SELECT count for all 22 ships;
15/15 random spot-checks (5 per line) matched geometry x/y exactly; fills that
pre-existed (old vision pass) were preserved, not overwritten.

## carnival-spirit-master-combo resolution

The "Master Combo" PDF contains **every deck twice** — 12 deck entries for 6
decks (1,4,5,6,7,8), 2136 cabin reads = exactly 2× Spirit's 1068. The two runs
are the *same deck plan rendered with two different color legends* (every
shared cabin's color differs between runs; positions shift slightly because
the two renders crop differently). Per-deck: decks 1/4/6/7 have 100% identical
cabin-number sets between runs; deck 5's second run has symbol-suffixed junk
reads (`5122★`, `5126■`); deck 8's second run is missing 8213.

**Resolution: kept the FIRST run only** (clean numbers, includes 8213):
1068 cabins, of which 1067 match the DB grid (99.9%). 1 geometry-only
(not inserted — Spirit is not a top-up ship), 1 DB-only.

## Cabin-number matching rules (and the symbol caveat)

Matching is exact string on `(ship_slug, cabin_num)` after **stripping
trailing deck-plan legend symbols** (`★ ■ † • * + = ➤` etc.) that the vision
pass captured as part of the number — e.g. NCL marks hundreds of cabins
`10222+` (footnote marker). No digit corrections of any kind were applied.
Symbol-stripped counts per ship are in the QC data (biggest: aqua 534,
dawn 503, prima 484). Duplicate numbers after stripping: first occurrence
wins (breakaway had a double-read deck-12 panel → 320 dropped dups; MSC ships
9–13 each).

## Unmatched stories (honest, not "fixed")

- **norwegian-spirit 44%** (580 geometry-only / 567 DB-only): the DB grid
  (deckmaps) uses a different, letter-suffixed numbering (`4580A`, `4578A`, …)
  from a different plan era than the current official PDF (plain `10558`
  style). Two numbering schemes for the same ship — only the 445 shared
  numbers were updated. Needs a decision (likely: rebuild Spirit's grid from
  the PDF), not a heuristic.
- **norwegian-sky 74.8%**: the PDF pass emitted a bogus "deck 0" with 239
  zero-padded numbers (`0063`, `0062`, …) — almost certainly a bad read of the
  deck-10 strip (DB-only is 238 cabins on deck 10). Left unmatched.
- **norwegian-breakaway 85.3%**: geometry simply under-read 298 DB cabins
  (dense inner blocks); everything it did read matched 99.6%.
- **carnival-vista**: 410 geometry-only inserted = deck 1 (277) + deck 14 (40)
  — decks the old grid never had — plus 93 scattered. 173 DB-only remain,
  mostly a deck-10 block (10299–10309 etc.) from the old vision pass.
  **Caveat:** DB total is now 2135 vs ~1964 published; the overshoot (~171)
  ≈ the DB-only count, so part of that old deck-10 block is suspect. Flagged,
  not deleted (out of scope).
- **mardi-gras**: 1093 inserted; DB now 2648 vs ~2641 published — the old
  58.9%-complete grid is now effectively full. 20 DB-only remain.

## Category mapping for inserted cabins

Empirical color→category tables built from each ship's own matched pairs
(threshold: top category ≥90% consistent, n≥10):

- mardi-gras: red→Balcony (95.6%), blue→Interior (95.9%), salmon→Balcony
  (100%), white→Family Harbor (100%) → 233/1093 categorized, 860 null.
- carnival-vista: gold→Ocean View (94.7%), purple→Ocean View (100%) →
  37/410 categorized, 373 null. (This PDF's palette differs from the old
  stored color_legend — empirical pairs were trusted, not the legend.)
- norwegian-aqua / norwegian-luna: Prima's empirical map (same line/PDF
  language, ≥90%, n≥20): blue/teal/green/mint→Balcony, tan→The Haven →
  962/1776 and 1005/1808 categorized.
- MSC World ships: **all category null** — the World Europa legend is
  hex-based and near-identical greens map to different categories
  (Balcony vs Promenade Balcony), so color names aren't confident. Raw
  color kept in `fill` for a later pass.

Uncategorized counts are recorded in each ship row's `notes.uncategorized`.

## Geometry ships NOT loaded (no DB row — class-rep model), reported only

carnival-breeze (1845), carnival-celebration (2634, Excel — rep is
mardi-gras), carnival-firenze (2063), carnival-freedom (1487), carnival-glory
(1490), carnival-horizon (1976), carnival-jubilee (2621, Excel rep),
carnival-legend-us (1067 — carnival-legend has NO dev DB row; verified),
carnival-liberty (1487), carnival-luminosa-1 (1129 — not in DB; verified),
carnival-magic (1842), carnival-miracle (1066), carnival-panorama (2000),
carnival-paradise (1054), carnival-pride (1064), carnival-radiance (1492),
carnival-sunrise (1492), carnival-valor (1489), carnival-venezia (2045).

These are ready if/when the fleet moves off the class-rep model.

## Known data caveats carried into the DB

- x/y are normalized 0..1 **within each deck strip image**; where a deck was
  split across multiple PDF panels (e.g. conquest deck 1 = 3 panels), the
  panels are separately normalized — renderers must treat x/y per-strip, or a
  future pass should stitch panels. Noted in each ship's `notes.geometry`.
- carnival-elation geometry has deck=null on all entries (harmless — updates
  match by cabin_num; no inserts for elation).
- side/section left null on all inserted cabins (no validated heuristic).

## PROD re-run (mechanical)

1. `export SUPABASE_URL=... SUPABASE_SERVICE_KEY=...` (prod), `export ALLOW_PROD=1`
   (script hard-refuses the prod project id without it).
2. `node load-geometry.mjs` — dry-run; compare its summary to the table above.
   Expect similar matched counts IF prod's cabin grids mirror dev; investigate
   any big deltas before writing.
3. `node load-geometry.mjs --write`.
4. Re-verify (counts + spot checks): `scratchpad/verify.mjs` logic, or re-run
   step 2 — matched should equal DB-with-x/y and inserted should be 0
   (idempotent: re-runs upsert the same values and skip existing numbers).

Requires only Node + the persistent runtime at
`~/Desktop/Claude Local/saf-runtime/node/node_modules` (path is baked into the
script via createRequire; no npm install).
