# Noise neighbourhood — what's next to each room

Mark, 2026-08-17:

> the room DB holds room numbers, classes, real and perceived obstructions, noise issues
> above, below and a 40 ft radius around the room (elevators, etc)
>
> it doesnt have to be 40 ft. the idea is to have an area around each room that identifies
> noise. that would work with 4 rooms fore and aft of the room and across the corridor
>
> visualize the deck plan, find the elevator lobbies and identify room numbers within 4 rooms
> fore aft and inside then notate the table

This is the fleet-scale version of that. It fills `cabins.noise_nearby` (what a guest in that
room would hear) and `cabins.noise_source` (which plan it came from), and ticks
`deck_read_log` so it is always visible how much of the fleet is actually done.

## The one rule that makes it trustworthy

**No room number ever comes from a model.** A vision read is only ever asked *where the noise
source is* — the lift lobby, the stairwell, the nightclub. The rooms around it are then worked
out in code from the cabin positions the database already holds (`pos_along` / `pos_across`).
So a misread digit cannot put the wrong room number in front of a customer; the worst a bad
read can do is put a lift lobby a few metres off, and the r² gate below catches even that.

## Sources, best first

| How | Lines | What the model does |
|---|---|---|
| Published deck-plan **SVG** | Celebrity | nothing — venue names, lift lobbies and cabin anchors are all text in the file |
| Plan image + **exact anchors** from the deckmaps SVG | Princess | locates noise sources only; anchors are parsed, not read |
| Plan image + **read anchors** | Royal Caribbean, MSC | locates noise sources and reads ~14 cabin numbers per tile purely to register the plan onto the grid |
| Plan image + **anchors from the geometry pass** | Carnival, NCL, MSC World | locates noise sources; the cabin coordinates the 2026-08-12 geometry pass already extracted are reused as anchors |

**Every path registers. None assumes the frame.** The strip coordinates in
`geometry/out/*.json` and the database's `pos_along` look identical and are not: the database
re-normalised each deck to 0..1, while a strip fraction never reaches the ends of the hull.
Measured on Carnival Conquest, 2026-08-19: trusting that frame put features **2 to 13 rooms
out of position**, and the rule only reaches 4 rooms either side — so it would have flagged a
different set of rooms entirely, on the 190 decks that are the largest block of the fleet. The
fits are r² = 1.0, so registering corrects it exactly. `selftest` now asserts the correction is
still happening and fails if registration ever becomes a no-op.

Registration is gated: at least 8 cabin anchors must match the grid, r² ≥ 0.99 along the ship
and ≥ 0.90 across it. A deck that fails is **left alone and reported**, never guessed at. That
gate is what caught Celebrity Millennium decks 6, 9 and 11, whose published plan does not
carry the numbers the grid uses.

## The neighbourhood rule

`neighbourhood()` in `noise-features.py`, ~40 lines, no I/O, unit-tested:

1. Cluster the deck's cabins into corridor rows by `pos_across`.
2. A row hears a feature if the feature is inboard (it opens onto the corridor that serves the
   whole beam) or sits on that row's side of the ship.
3. In each row that hears it, find the cabin nearest the feature along the ship and take the
   4 either side — capped at 9% of the ship's length, because in a sparse row the "4th room"
   can be a third of a ship away and that is not nearby.

## Verifying it

    python3 noise-features.py selftest

Norwegian Breakaway deck 5 was transcribed **by hand** on 2026-08-18 — Medical Centre amidships,
lift bank and stairwell just aft. The selftest asserts the rule reproduces all 12 of those
rooms, flags no room a third of a deck away, and does not simply flag the whole deck. Change
the rule and that test tells you whether you broke it.

## Running it

    # published-SVG lines — no API cost at all
    python3 noise-features.py svg-assemble

    # image lines — Anthropic Message Batches API (50% off, no Claude Code credits)
    python3 noise-features.py plan-prep [--only princess]
    python3 noise-features.py plan-submit [--only princess] [--dry-run]
    python3 noise-features.py poll
    python3 noise-features.py plan-assemble

    # same-frame lines (the fleet-geometry tiles the 2026-08-12 pass already carved)
    python3 noise-features.py submit
    python3 noise-features.py poll
    python3 noise-features.py assemble

    # turn reads into writes
    python3 noise-features.py apply           # -> noise/sql/*.sql + noise/apply.json
    scp noise/apply.json load-noise.mjs saf-dev:/root/saf-full/server/
    ssh saf-dev 'cd /root/saf-full/server && set -a && . /opt/stillafloat/shared.env && set +a \
                 && node load-noise.mjs apply.json --write'

`apply` needs `noise/grid.json` — the cabin positions, exported from the database. Dump it on a
box (the service key stays there) with a short supabase-js script and `scp` it back; the export
must paginate with an explicit `.order()`, or PostgREST's 1000-row cap silently drops most of
the fleet.

Only the class rep is read. Sister ships inherit their rep's rows, the same way the grid does,
so reading Norwegian Escape's 12 decks covers four ships.

## What the guest actually reads

`server/src/lib/cabin-placement.ts` turns these columns into the lines `/cabins/check` shows
when someone types their own room number in — the reason Mark wanted every room right. It is
pure and exhaustively tested (`cabin-placement.test.ts`), because that text is the output
surface.

**Spanish is written, not translated.** `noise_kind` (migration 0023) carries a code —
`lift`, `stairs`, `venue`, `venue-above`, `venue-below` — and each language renders its own
words from it. A lift lobby is *el vestíbulo de ascensores*; a venue name is a proper noun and
stays put in both. The one thing that must never happen is English prose sitting inside the
Spanish page, which is exactly what "Casino on the deck above" was doing until the position
was moved out of the name and into the kind.

## Still open

- **Margaritaville Paradise** — geometry and noise are being read off the official plan now
  (its PDF is drawn, not typed, so the room numbers have to be read and are then filtered
  against the grid — nothing invented). Islander is done: 1,020 rooms positioned from the PDF
  text, which is the first geometry those hulls have ever had. Beachcomber is `in_fleet=false`
  and out of scope.
- **Islander deck 6** — the official plan carries 192 rooms; the grid holds 162, and 36 plan
  rooms have no row at all. A guest typing one of those in gets "I can't find that cabin".
  Inserting rooms is Mark's call, not mine, so it is flagged rather than done.
- ~~Norwegian Breakaway deck 13~~ — **fixed 2026-08-19.** Widgety serves the same file for
  Breakaway decks 12 and 13 (md5 `c28ac443`, confirmed at the source, so it is Widgety's error
  and not a bad download), which is why the 2026-08-12 geometry pass read deck 12 twice and
  deck 13 ended up with 280 rooms and no positions at all. Norwegian Getaway is the class
  sister sharing that grid exactly and *its* deck 13 plan is real and distinct — read cabins
  and noise sources off that one image together, in one frame, no registration needed. 264 of
  the 280 rooms located, every number matched to the grid and none invented; 528 cabin rows of
  missing geometry filled and 82 rooms flagged.
- **Learning module** (task 13a1f629) — capture what guests actually pick and feed it back.
  Not started; deliberately separate from this, which is facts only.
