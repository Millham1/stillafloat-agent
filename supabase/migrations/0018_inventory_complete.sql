-- 0018 — stop asserting a ship hasn't got a cabin type when we simply never mapped one.
--
-- `selectCabins` chose between "this ship hasn't got balconies, that's how it was
-- built" and "it has them, I haven't done the room-by-room work" purely on whether
-- cabin_ships.category_counts held any of that type. But category_counts is built
-- from whatever our grid extraction captured, so a zero there means "we mapped
-- none", never "the ship has none". Measured on dev 2026-08-18, that turned into a
-- confident falsehood on ~20 ship/type pairs:
--
--   ocean view  → six Royal-class Princess hulls (Royal, Regal, Majestic,
--                 Enchanted, Discovery, Sky) plus Norwegian Aqua and Luna
--   suites      → Carnival Breeze / Dream / Magic / Elation / Paradise and
--                 MSC Magnifica / Musica / Orchestra / Poesia
--
-- Every one of those ships sells the room we were denying. It is the same failure
-- that took the concierge off production on 8/16 — a visitor asked for a balcony
-- and was told a ship that has them hadn't got any.
--
-- THE FIX IS A SOURCE, NOT A FLAG. `line_types` holds the cabin kinds the LINE
-- ITSELF says it sells on this hull, taken from the per-deck category legend the
-- operator publishes (cabin-advisor/extract-deck-legends.mjs, loaded by
-- load-line-types.mjs). Deliberately NOT counts: we know WHICH kinds exist from
-- the legend but not how many, and writing a made-up number into category_counts
-- to force a boolean would be exactly the fabrication this tool must not do.
--
-- How selectCabins reads it when nothing of the asked type survived:
--   line_types IS NULL          → "type-not-mapped": we mapped none and cannot
--                                 say whether the ship has any. Never claims.
--   asked IS IN line_types      → "none-researched": it has them, we haven't
--                                 done the room-by-room work.
--   asked NOT IN line_types     → "ship-has-none": the line's own deck plan does
--                                 not list that kind anywhere on this ship.
--
-- Only populated where the legend covers every deck our grid holds cabins on —
-- a legend missing a deck could otherwise manufacture a false absence.

alter table public.cabin_ships
  add column if not exists line_types text[];

comment on column public.cabin_ships.line_types is
  'Cabin kinds (inside/oceanview/balcony/suite) the LINE''s own published deck plan lists for this ship. NULL = we have no such statement, and the concierge must not claim the ship lacks anything. Not derived from our grid — that is category_counts.';

-- Superseded before use: the boolean could only say "trust category_counts",
-- which is the very thing that was wrong. Dropped rather than left to confuse.
alter table public.cabin_ships drop column if exists inventory_complete;
