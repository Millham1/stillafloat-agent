# Room Engine — verified state of record

Written 2026-08-10 late night, after a day that lost time to unrecorded decisions.
Every claim below was verified against the repo, dev Supabase, or a run log on the
date shown — nothing here is from memory. Update this file in the same commit as
any change that alters it. DESIGN.md holds the locked design; this file holds
what actually exists.

## What exists and is verified working

| Piece | State | Verified |
|---|---|---|
| Layer 1 grids | 40 classes / 61,505 cabins loaded in dev Supabase (`cabins`, `cabin_ships`) | 2026-08-10, SQL count |
| Reasoning engine | `generate-advice.mjs` + `voice-guide.md`; 12 archetypes; cliffnotes model (generate once, store, serve free) | 2026-08-10, output read |
| Stored advice | Wonder only: 12 archetypes in `cabin_advice` (dev) + `advice/wonder-of-the-seas.json` | 2026-08-10, SQL + file |
| Fixture | `data/cabins/wonder-of-the-seas.json` — 23 hand-researched cabins. TEST DATA the engine was built against. Carries the moat fields (notes, hump, graded obstruction, tours) that the full grids do NOT have | 2026-08-10 |
| Full-grid capability | Engine now accepts full grids (`FULL_GRID=1`); writes to `advice/<slug>-fullgrid.json` so fixture output can't be overwritten | 2026-08-10, run below |
| Full-grid proof run | Wonder, 2,886 cabins, 12/12 archetypes, **$1.39**. Motion/position reasoning held; **moat reasoning absent** (no noise/hump/obstruction facts in grids) | 2026-08-10 |
| Layer 2 zones | `context/*.json` — 40 classes, 370 zones, 100% cabin coverage, $1.32. **Uncommitted quality: hump wrong on Oasis twice; 8/9 other hump calls correct; not yet wired into any prompt** | 2026-08-10 |
| UI | `server/public/cabin-finder.html`, rebuilt to brand guide, Mark's 6 review points addressed, **his further review incomplete** — this was the actual task | preview: `preview-server.py 8899` |

## What does NOT exist

- Per-cabin moat facts for anything beyond Wonder's 23 fixture cabins
  (61,482 cabins have deck/category/section/side/obstructed-flag only).
- Advice for any class except Wonder.
- Any venue/machinery geometry (extraction kept only `.cabinShape[data-cabin]`),
  so true proximity analysis ("what's within 50 ft") is not yet computable.
  20 of 40 classes have cabin x/y; the 20 Carnival-PDF classes have none.

## Money actually spent on API today (this project)

- Layer 2 zone batch (40 classes): **$1.32** — not requested by Mark
- Layer 2 single-class proofs (2 Oasis runs): **~$0.11**
- Wonder full-grid advice test: **$1.39**
- An earlier attempted full-grid run failed on an exhausted Anthropic balance
  (drained by the zone batch) and briefly overwrote the fixture advice file —
  restored from backup within a minute; dev Supabase rows never touched.

## Cost to complete advice generation, measured (not estimated)

4.16M prompt tokens across 40 classes × 12 archetypes on Haiku:
- as the code stands: **~$54**
- with prompt caching added to `generate-advice.mjs`: **~$13**
- Wonder actual came in ~45% under the uncached estimate, so these are ceilings.

## The quality gap, stated plainly

Full-grid advice (proven) = sound motion/position/category reasoning, real cabin
numbers, Mark's voice. Fixture advice (the bar) = all of that PLUS the moat:
"pool deck directly above", "juts past the lifeboats", "RC doesn't label it
obstructed but a steel wall blocks the view", tour links. The moat came from
per-cabin facts, not from the model. **The engine is only as honest as the facts
it is fed.** Options priced for Mark, decision his:

1. Fleet as-is (~$13 cached): position-level advice everywhere, no moat.
2. Wire the already-paid-for Layer 2 zones into the prompt, re-test Wonder
   (~$1.40), then fleet: recovers noise/lifeboat/hump reasoning, not per-cabin
   trivia or tours. Zone quality itself needs the Oasis hump fix first.
3. Build real proximity facts from venue geometry (needs re-extraction; only
   possible for the 20 classes with x/y today).
4. UI first (costs nothing, was tonight's actual request), decide the rest later.

## Standing decisions (from Mark, today)

- Ideas welcome, but HE decides; no silent scope changes, no end-runs.
- Untested claims must be labelled as untested.
- Decisions get written to the repo when made, not reconstructed later.
