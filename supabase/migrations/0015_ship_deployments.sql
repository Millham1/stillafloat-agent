-- 0015_ship_deployments.sql — forward-looking seasonal deployments per ship.
--
-- The gap this closes (Mark, 2026-08-15): storm matching only knew the CURRENT
-- AIS-derived sailing, and the Room Concierge was destination-blind. Cruise
-- lines publish seasonal deployments openly; captured per ship (browser/fetch-
-- assisted like the Conga ratings, quarterly refresh), stored here, and used by:
--   • storm-sailings.ts — forward matching: region overlap + date inside season
--   • cabins.ts suggest-ships — destination-aware ship suggestions
-- Region tags EXTEND the existing sailings vocabulary (snake_case):
--   bahamas bermuda e_caribbean w_caribbean s_caribbean gulf mexican_riviera
--   us_east_coast us_west_coast alaska hawaii mediterranean n_europe
--   canada_ne panama_canal transatlantic asia australia_nz s_america world
CREATE TABLE IF NOT EXISTS public.ship_deployments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ship_slug     text NOT NULL,
  ship_name     text NOT NULL,
  cruise_line   text,
  region        text NOT NULL,
  season_start  date NOT NULL,
  season_end    date NOT NULL,
  homeport      text,
  source_url    text,
  captured_at   timestamptz NOT NULL DEFAULT now(),
  captured_by   text,
  notes         text
);
CREATE INDEX IF NOT EXISTS ship_deployments_ship_idx   ON public.ship_deployments (ship_slug);
CREATE INDEX IF NOT EXISTS ship_deployments_region_idx ON public.ship_deployments (region, season_start, season_end);
ALTER TABLE public.ship_deployments ENABLE ROW LEVEL SECURITY;  -- service-role only
