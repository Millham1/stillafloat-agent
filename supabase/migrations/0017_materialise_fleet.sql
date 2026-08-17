-- 0017_materialise_fleet.sql
-- Give every ship its own cabins, and delete the request-time class lookup.
--
-- WHY (Mark, 2026-08-17): "every one of these issues should have been resolved
-- by writing the data to the ship's table in the DB." He is right, and this is
-- the gap that caused the worst bug found so far.
--
-- The 2026-07-27 design was: build cabin data once per hull CLASS, reuse across
-- sisters with number swaps. The first half shipped — 45 class reps got grids.
-- The second half never did, so no sister ever got rows of its own. Instead,
-- buildFleet() resolved a ship to a rep at REQUEST TIME by matching class NAME:
--
--     repByClass.set(r.class.toLowerCase(), ...)   -- last write wins
--     const rep = repByClass.get(className.toLowerCase())
--
-- Class names are not unique across lines. Carnival and Norwegian both have a
-- "Spirit" class; Carnival (ex-P&O) and Princess both have a "Grand". NCL loaded
-- last, so five Carnival ships were served Norwegian Spirit's cabins, and two
-- more got Grand Princess's. Carnival Spirit and Norwegian Spirit share ZERO
-- cabin numbers, so a visitor picking Carnival Spirit was shown 41 recommended
-- cabins of which 0 exist on that ship. Nothing could catch it, because no row
-- anywhere asserted what Carnival Spirit's cabins actually are.
--
-- Sisters genuinely do share numbering (measured on the pairs we hold grids for:
-- World Europa/Asia 99%, America/Asia 98%, Prima Plus Aqua/Luna 99.7%), so
-- copying a rep's grid to its sisters is sound. What was unsound was doing it by
-- string match, invisibly, on every request.
--
-- After this migration every ship in the picker owns its rows, and provenance is
-- data you can query rather than something inferred from a name.

-- Where a ship's cabin data came from. NULL = researched for this hull directly.
ALTER TABLE public.cabin_ships
  ADD COLUMN IF NOT EXISTS derived_from       text REFERENCES public.cabin_ships(slug),
  -- has anyone confirmed the numbering actually matches the rep for THIS hull?
  -- false is the honest default for a copy: sisters agree 93-99%, not 100%.
  ADD COLUMN IF NOT EXISTS numbering_verified boolean NOT NULL DEFAULT false,
  -- the class name as fleet.json spells it, which is not always how cabin_ships
  -- spells it (Norwegian Spirit is "Leo" in one and "Spirit" in the other).
  ADD COLUMN IF NOT EXISTS fleet_class        text,
  ADD COLUMN IF NOT EXISTS in_fleet           boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.cabin_ships.derived_from IS
  'Class rep this ship''s cabin rows were copied from. NULL = own research. Never resolve this by class name at request time.';
COMMENT ON COLUMN public.cabin_ships.numbering_verified IS
  'FALSE means the copy is unconfirmed for this hull — say so rather than implying certainty.';

ALTER TABLE public.cabins
  ADD COLUMN IF NOT EXISTS derived_from text;
COMMENT ON COLUMN public.cabins.derived_from IS
  'Slug of the class rep this row was copied from. NULL = extracted for this ship.';

CREATE INDEX IF NOT EXISTS cabin_ships_derived_idx ON public.cabin_ships(derived_from);
CREATE INDEX IF NOT EXISTS cabin_ships_fleet_idx   ON public.cabin_ships(in_fleet);

-- Existing 45 rows are all directly researched and all in the fleet spine.
UPDATE public.cabin_ships SET numbering_verified = true WHERE derived_from IS NULL;
