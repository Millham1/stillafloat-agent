-- 0009_cabin_advice.sql — where the advisor's pre-written reasoning lives.
--
-- The cost architecture (Mark, 2026-07-26): the agent does the reasoning ONCE,
-- up front, per ship per traveller archetype, on a cheap model. It is stored
-- here and served free. Nothing calls an LLM when a customer uses the finder,
-- so a traffic spike costs the same as a quiet day.
--
-- Runtime = deterministic cabin selection from the visitor's answers, matched to
-- the nearest archetype, then serve that archetype's pre-written reasoning
-- joined to the live cabin facts in public.cabins.
--
-- Regenerate only when cabin data changes (cabin-advisor/generate-advice.mjs →
-- cabin-advisor/load-advice.mjs).

CREATE TABLE IF NOT EXISTS public.cabin_advice (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ship_slug       text NOT NULL,
  archetype_id    text NOT NULL,
  label           text,                                   -- human name of the archetype
  recommendations jsonb NOT NULL DEFAULT '[]'::jsonb,     -- [{cabin, rank, reason}]
  steer_clear     jsonb NOT NULL DEFAULT '[]'::jsonb,     -- [{cabin|area, reason}]
  model           text,                                   -- which model wrote it
  generated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ship_slug, archetype_id)
);

CREATE INDEX IF NOT EXISTS cabin_advice_ship_idx ON public.cabin_advice (ship_slug);

ALTER TABLE public.cabin_advice ENABLE ROW LEVEL SECURITY; -- service-role only
