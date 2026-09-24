-- 0038 — planned_sailings on PROD.
--
-- The storm course-change detector inferred a ship's normal run from the ports
-- terrestrial AIS happened to hear her at, and filed 25 false diversions in
-- three days (2026-09-19..21) — every one a scheduled port. It now classifies
-- against the operator's published itinerary and stays silent without one, so
-- prod needs the table dev has carried since migration 0034.
--
-- Table definition is 0034's, minus port_routes (route drawing is not part of
-- this fix). Rows are copied from dev rather than re-fetched: the Cruise API
-- bills per call and the data is identical.
CREATE TABLE IF NOT EXISTS public.planned_sailings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source      text NOT NULL,                 -- 'widgety-archive' | 'rapidapi-cruise' | 'msc-book' | 'manual'
  ref         text NOT NULL UNIQUE,          -- provider sailing code
  ship_name   text NOT NULL,                 -- registry name when matched, else the provider's
  mmsi        text,
  operator    text,
  start_date  date NOT NULL,
  end_date    date,
  from_code   text,
  to_code     text,
  ports       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ordered [{name, slug|null, lat|null, lon|null}]
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS planned_sailings_ship_date_idx ON public.planned_sailings (ship_name, start_date);
CREATE INDEX IF NOT EXISTS planned_sailings_mmsi_date_idx ON public.planned_sailings (mmsi, start_date);
ALTER TABLE public.planned_sailings ENABLE ROW LEVEL SECURITY;  -- service-role only
