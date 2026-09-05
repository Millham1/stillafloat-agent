-- 0028_storm_diversions.sql — REAL course-change detection for storm-pinned ships
-- (Mark, 2026-09-05). Apply DEV FIRST, then PROD with the dev→main promotion.
--
-- Why: the first detector flagged every AIS destination change as a diversion,
-- so scheduled port rotation produced 22 of 22 nudges (see storm-diversion.ts).
-- The rebuilt classifier needs to know WHEN a destination was declared (to tell
-- "arrived, then declared the next port" from "changed course mid-leg"), and
-- ship pins must release per storm when it dissipates. Events live in their own
-- table so one ship movement is ONE nudge whichever storms the ship sits in.

ALTER TABLE public.storm_tracked_ships
  ADD COLUMN IF NOT EXISTS baseline_declared_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS released_at          timestamp with time zone;
CREATE INDEX IF NOT EXISTS storm_tracked_ships_live_idx
  ON public.storm_tracked_ships (alert_id) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS public.storm_diversion_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedup_key     text NOT NULL UNIQUE,            -- ship|from|to|YYYY-MM-DD
  ship_name     text NOT NULL,
  cruise_line   text,
  mmsi          text,
  kind          text NOT NULL,                   -- reroute | new_port | order_change
  from_slug     text,
  to_slug       text NOT NULL,
  raw           text,                            -- AIS destination as typed by the crew
  reason        text,                            -- classifier's one-line justification
  detected_at   timestamp with time zone NOT NULL DEFAULT now(),
  alert_ids     uuid[] NOT NULL DEFAULT '{}'::uuid[],
  storm_names   text[] NOT NULL DEFAULT '{}'::text[],
  intel         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{line, note, url}] operator/news at detection
  status        text NOT NULL DEFAULT 'pending',  -- pending | published | ignored
  published_at  timestamp with time zone,
  ignored_at    timestamp with time zone,
  CONSTRAINT storm_diversion_events_kind_check
    CHECK (kind = ANY (ARRAY['reroute','new_port','order_change'])),
  CONSTRAINT storm_diversion_events_status_check
    CHECK (status = ANY (ARRAY['pending','published','ignored']))
);
CREATE INDEX IF NOT EXISTS storm_diversion_events_status_idx
  ON public.storm_diversion_events (status, detected_at DESC);
CREATE INDEX IF NOT EXISTS storm_diversion_events_alerts_idx
  ON public.storm_diversion_events USING gin (alert_ids);

-- Backend-only table: RLS on, no public policies (service role bypasses).
ALTER TABLE public.storm_diversion_events ENABLE ROW LEVEL SECURITY;
