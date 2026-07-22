-- 0006_storm_lifecycle.sql — storm lifecycle: tracked ships, death detection,
-- gated all-clear, and cruise-line intel bookkeeping (task 3c349235 follow-on).
-- Apply dev first, then prod (with the dev→main promotion).

-- Lifecycle columns on storm_alerts.
ALTER TABLE public.storm_alerts
  ADD COLUMN IF NOT EXISTS missing_scans integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ended_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS all_clear_headline text,
  ADD COLUMN IF NOT EXISTS all_clear_body_md text,
  ADD COLUMN IF NOT EXISTS all_clear_sent_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS all_clear_sent_count integer,
  ADD COLUMN IF NOT EXISTS all_clear_skipped_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS intel_state jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Ships pinned to an alert for the storm's lifetime: the impacted-sailings
-- match resolved to concrete ships, with an AIS destination baseline so
-- diversions can be flagged. Rows are kept after the storm ends (history).
CREATE TABLE IF NOT EXISTS public.storm_tracked_ships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES public.storm_alerts(id) ON DELETE CASCADE,
  ship_name text NOT NULL,
  cruise_line text,
  mmsi text,
  baseline_destination text,
  changes jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{at, from, to, raw}]
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (alert_id, ship_name)
);
CREATE INDEX IF NOT EXISTS storm_tracked_ships_alert_idx
  ON public.storm_tracked_ships (alert_id);

-- Backend-only table: RLS on, no public policies (service role bypasses).
ALTER TABLE public.storm_tracked_ships ENABLE ROW LEVEL SECURITY;
