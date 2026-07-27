-- 0008_cabin_widgety.sql
-- Widgety (licensed booking feed) authoritative overlay for the Cabin Advisor.
-- Widgety covers the full MSC + Royal Caribbean fleets with authoritative cabin
-- counts and bookable grade metadata (name, fare code, type, size, occupancy) —
-- but NOT per-cabin numbers (its deckplans are flat images). So it VALIDATES and
-- ENRICHES the DeckMaps grid rather than replacing it. Populated by
-- cabin-advisor/widgety-enrich.mjs. (Trial key, 30 days; facts retained.)
ALTER TABLE public.cabin_ships
  ADD COLUMN IF NOT EXISTS widgety_cabin_count integer,   -- authoritative bookable stateroom total
  ADD COLUMN IF NOT EXISTS widgety_deck_count  integer,
  ADD COLUMN IF NOT EXISTS widgety_grades      jsonb,     -- [{name,codes,type,min_size,max_size,min_occ,max_occ,accessible}]
  ADD COLUMN IF NOT EXISTS widgety_checked_at  timestamptz;
