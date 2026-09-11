-- 0034 — planned sailings (operator itineraries) + stored water routes per port pair.
--
-- Mark, 2026-09-11: "the itinerary data is there to build the route, and then
-- the api data you ping at the request gives lat and long to print it on the
-- route" and "shouldn't that come from the operators? that way we can build
-- out planned itineraries years in the future". Itineraries come from the
-- OPERATORS (first load: the July Widgety archive, MSC + NCL, to Nov 2028);
-- tracks only detect deviations. Apply DEV FIRST, then PROD.

CREATE TABLE IF NOT EXISTS public.planned_sailings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source      text NOT NULL,                 -- 'widgety-archive' | 'rapidapi-cruise' | 'msc-book' | 'manual'
  ref         text NOT NULL UNIQUE,          -- provider sailing code, e.g. MSCMR20281021SOUSOU
  ship_name   text NOT NULL,                 -- registry name when matched, else the provider's
  mmsi        text,                          -- registry MMSI when matched
  operator    text,
  start_date  date NOT NULL,
  end_date    date,                          -- next sailing's start when the provider gives no length
  from_code   text,
  to_code     text,
  ports       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ordered [{name, slug|null, lat|null, lon|null}]
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS planned_sailings_ship_date_idx ON public.planned_sailings (ship_name, start_date);
CREATE INDEX IF NOT EXISTS planned_sailings_mmsi_date_idx ON public.planned_sailings (mmsi, start_date);
ALTER TABLE public.planned_sailings ENABLE ROW LEVEL SECURITY;  -- service-role only

-- One water route per ordered port pair, computed once (lib/sea-route.ts) and
-- assembled into a sailing's line at request time.
CREATE TABLE IF NOT EXISTS public.port_routes (
  from_slug   text NOT NULL,
  to_slug     text NOT NULL,
  points      jsonb NOT NULL,                -- [[lat, lon], ...] from -> to
  nm          numeric,
  source      text NOT NULL DEFAULT 'searoute-js',
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_slug, to_slug)
);
ALTER TABLE public.port_routes ENABLE ROW LEVEL SECURITY;  -- service-role only
