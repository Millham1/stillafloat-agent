-- 0002_storm_sailings_detail.sql
-- Storm-alert v2: itinerary-level (date + region aware) ship matching, plus the
-- detail-page fields. Apply DEV FIRST, then PROD after sign-off.
--
-- Why: region-tag ship matching was too coarse (a Miami sailing isn't affected by
-- an ABC-islands storm). A ship is impacted only if a sailing's regions overlap the
-- storm's grounds AND its dates overlap the forecast window.

CREATE TABLE IF NOT EXISTS public.sailings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ship_name   text NOT NULL,
  cruise_line text NOT NULL,
  depart_port text,
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  regions     text[] NOT NULL DEFAULT '{}'::text[],
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sailings_dates_idx ON public.sailings USING btree (start_date, end_date);
ALTER TABLE public.sailings ENABLE ROW LEVEL SECURITY; -- service-role only

-- storm_alerts: detail-page content + forecast window + graphics
ALTER TABLE public.storm_alerts
  ADD COLUMN IF NOT EXISTS detail_md        text,
  ADD COLUMN IF NOT EXISTS cruise_line_info jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{line, note, url}]
  ADD COLUMN IF NOT EXISTS cone_url         text,
  ADD COLUMN IF NOT EXISTS satellite_url    text,
  ADD COLUMN IF NOT EXISTS window_start     date,
  ADD COLUMN IF NOT EXISTS window_end       date;
