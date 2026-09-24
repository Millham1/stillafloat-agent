-- 0039 — remember which CruiseMapper page belongs to each ship.
--
-- The id is resolved OFFLINE by IMO (see the itineraries memo and
-- build_mmsi_index.py), never by name. Names are wrong constantly: in one pass
-- across 315 ships there were 2 renames and 17 ships whose published MMSI was a
-- stale flag. IMO never changes, so the mapping it produces stays correct through
-- a rename or a reflagging.
--
-- Storing the id rather than re-deriving it each run also means the monthly
-- refresh is one page fetch per ship instead of a 1,534-page crawl.
--
-- ⛔ The slug in /ships/<Slug>-<id> is IGNORED by CruiseMapper — only the number
-- is real, and a wrong number silently serves a DIFFERENT ship's itinerary.
-- Never populate this column from a guessed or hand-built URL.

alter table public.ships
  add column if not exists cruisemapper_id text;

comment on column public.ships.cruisemapper_id is
  'CruiseMapper numeric ship-page id, resolved by IMO. Null = no itinerary refresh for this ship.';

-- Partial index: the refresh job only ever asks for ships that HAVE an id.
create index if not exists ships_cruisemapper_id_idx
  on public.ships (cruisemapper_id)
  where cruisemapper_id is not null;
