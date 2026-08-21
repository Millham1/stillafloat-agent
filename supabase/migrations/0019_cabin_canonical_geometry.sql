-- 0019 — put every cabin's position into ONE frame, so the room data can carry
-- per-room facts instead of area guesses.
--
-- Mark, 2026-08-18, on the architecture: the advisor must be a separate module
-- that CONSUMES an accurate room DB — "the Room DB holds room numbers, classes,
-- real and perceived obstructions, noise issues above, below and a 40 ft radius
-- around the room (elevators, etc)". None of above/below/radius is computable
-- today, because x/y do not mean the same thing on every ship:
--
--   vision-read hulls (NCL, Carnival, MSC World) — x runs ALONG the ship, y
--     across it, normalised 0..1 per deck.            48 ships / 81,182 cabins
--   MSC DeckMaps SVGs — same meaning, but in pixels
--     in a frame shared by all decks.                 44 ships / 70,238 cabins
--   RCL/Celebrity DeckMaps SVGs — every deck is drawn
--     as its own narrow band in ONE stacked image, so
--     x is the DECK axis and Y is the along-ship axis. 42 ships / 71,420 cabins
--
-- Wonder of the Seas deck 3 sits at x 2272-2350 and deck 18 at x 47-140: reading
-- that x as "position along the ship" would have put every room on a deck at the
-- same spot. Any above/below or proximity work done before this would have been
-- confident nonsense on a third of the fleet.
--
-- THE RULE, and it is decided by the data rather than by the source: on a single
-- deck a ship is far longer than it is wide, so THE WIDER PER-DECK AXIS IS THE
-- ALONG-SHIP AXIS. That classifies all three layouts without trusting a source
-- label, and it is recorded per ship so the choice is auditable.
--
-- pos_along / pos_across are 0..1 within a ship, never mixed across ships.
-- They are DERIVED — recompute with cabin-advisor/derive-geometry.mjs whenever
-- x/y change. The raw x/y stay untouched as the source of record.

alter table public.cabins
  add column if not exists pos_along numeric,
  add column if not exists pos_across numeric;

comment on column public.cabins.pos_along is
  'Bow-to-stern position, 0..1 within this ship. Derived from x or y depending on the ship''s geometry_frame — never read x/y directly for this.';
comment on column public.cabins.pos_across is
  'Beam position, 0..1 within this ship (one side to the other). Derived; see cabin_ships.geometry_frame.';

create index if not exists cabins_ship_deck_along_idx
  on public.cabins (ship_slug, deck, pos_along);

alter table public.cabin_ships
  add column if not exists geometry_frame text;

comment on column public.cabin_ships.geometry_frame is
  'Which raw axis runs along this ship: ''x-along'' (per-deck images, vision reads and MSC SVGs) or ''y-along'' (RCL/Celebrity stacked SVGs, where x is the deck axis). Decided by measurement — the wider per-deck axis wins — not by the source name. NULL = not enough positioned cabins to tell.';
