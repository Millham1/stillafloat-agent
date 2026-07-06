-- 0003_unified_actions.sql
-- Brief v2: ONE pipeline for everything that needs Mark's attention.
-- Every agent (storm alerts, calendar conflicts, future) inserts a row here
-- instead of emailing/pushing ad hoc. Exactly one notification is sent per row
-- (see the notify dispatcher), and the brief renders pending rows with working
-- inline buttons. Apply DEV FIRST, then PROD after Mark's sign-off.

CREATE TABLE IF NOT EXISTS public.actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL,                      -- storm_alert | calendar_conflict | generic
  title       text NOT NULL,
  body        text,
  -- Inline buttons the brief renders: [{"label","method","path","style"}]
  -- path is a main-site API path; the brief adds the auth token client-side.
  buttons     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'pending',    -- pending | done | dismissed | expired
  source_ref  text,                               -- e.g. storm_alerts.id / conflict key (dedup)
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT actions_status_check CHECK (status = ANY (ARRAY['pending','done','dismissed','expired']))
);
CREATE INDEX IF NOT EXISTS actions_status_idx ON public.actions (status);
CREATE UNIQUE INDEX IF NOT EXISTS actions_source_ref_pending_key
  ON public.actions (type, source_ref) WHERE status = 'pending';
ALTER TABLE public.actions ENABLE ROW LEVEL SECURITY;  -- service-role only
