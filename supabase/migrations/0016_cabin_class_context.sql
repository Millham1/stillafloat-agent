-- 0016_cabin_class_context.sql
-- The MOAT LAYER, finally given somewhere to live.
--
-- Background (2026-08-17). `cabin-advisor/research-class-context.mjs` was run
-- across the fleet on 2026-08-13/14 and produced 41 hull-class research files —
-- 478 obstruction zones, every one carrying its source URL, plus 330 named-cabin
-- leads. Mark paid for that run. It was then wired to NOTHING: no table, no
-- loader, and `generate-advice.mjs` never reads it (grep: zero references), so
-- the 540-row advice corpus was written blind to it.
--
-- The cost of that gap is measurable. The advice generator asks the model to
-- "list 2-3 cabins you would steer them clear of" while handing it grids where
-- only 411 of 63,344 cabins carry any obstruction fact — 0.6%. With nothing to
-- reason from it produced plausible cabin numbers, and 10 of 1,506 stored
-- steer-clear cabins do not exist on their ship. This table is where the facts
-- that should have answered that question go.
--
-- Design notes:
--   • Research is per HULL CLASS, not per ship — that is the build unit. The
--     inheritance is materialised in cabin_context_ships rather than inferred at
--     query time, so "which research is this ship using" is a row you can read,
--     not logic you have to trust. `class` alone is NOT unique (Carnival and NCL
--     both have a "Spirit"), and the line name is not consistent in cabin_ships
--     ("Royal Caribbean" vs "Royal Caribbean International"), so the loader
--     resolves on a normalised line + class and writes the result down.
--   • ZONES are area facts (deck + section). LEADS are named-cabin claims from
--     aggregators — weaker evidence, kept separate on purpose so a lead can
--     never be served with the confidence of a sourced zone.
--   • Nothing here is visitor-facing text. Severity/confidence drive how firmly
--     the tool speaks, and per Mark (8/16) the confidence value is INTERNAL and
--     never rendered.
--
-- RLS service-role-only, same as the rest of the cabin layer.

CREATE TABLE IF NOT EXISTS public.cabin_class_context (
  rep_slug       text PRIMARY KEY REFERENCES public.cabin_ships(slug) ON DELETE CASCADE,
  class_label    text,                 -- the research's own words for the class
  line           text,
  ship_name      text,
  sister_ships   text[]  NOT NULL DEFAULT '{}',
  total_cabins   integer,
  cabins_touched integer,              -- the research's own coverage claim
  model          text,
  web_searches   integer,              -- grounding: 0 means it was NOT grounded
  cost_usd       numeric(10,6),
  unknowns       jsonb   NOT NULL DEFAULT '[]'::jsonb,  -- what it could NOT establish
  researched_on  date,
  loaded_at      timestamptz NOT NULL DEFAULT now()
);

-- Which ship uses which class research. One row per ship, written by the loader.
CREATE TABLE IF NOT EXISTS public.cabin_context_ships (
  ship_slug   text PRIMARY KEY REFERENCES public.cabin_ships(slug) ON DELETE CASCADE,
  rep_slug    text NOT NULL REFERENCES public.cabin_class_context(rep_slug) ON DELETE CASCADE,
  inherited   boolean NOT NULL,        -- false = this ship IS the researched rep
  note        text                     -- why, when inherited
);
CREATE INDEX IF NOT EXISTS cabin_context_ships_rep_idx ON public.cabin_context_ships(rep_slug);

-- The area facts. A zone applies to cabins on its decks within its sections.
CREATE TABLE IF NOT EXISTS public.cabin_context_zones (
  id          bigserial PRIMARY KEY,
  rep_slug    text NOT NULL REFERENCES public.cabin_class_context(rep_slug) ON DELETE CASCADE,
  factor      text NOT NULL,           -- lifeboat|above|below|engine|elevator|i95|hump|taper|motion|connecting|accessible|other
  decks       integer[] NOT NULL DEFAULT '{}',
  sections    text[]    NOT NULL DEFAULT '{}',   -- normalised: forward|mid|aft
  sides       text[]    NOT NULL DEFAULT '{}',   -- empty = both
  what        text,                    -- what is physically there
  effect      text,                    -- what it does to the cabin
  matters_to  text,                    -- who should care (and who shouldn't)
  severity    text NOT NULL,           -- minor|moderate|significant
  confidence  text NOT NULL,           -- low|medium|high  (INTERNAL — never rendered)
  source      text NOT NULL            -- required: no unsourced zone gets loaded
);
CREATE INDEX IF NOT EXISTS cabin_context_zones_rep_idx    ON public.cabin_context_zones(rep_slug);
CREATE INDEX IF NOT EXISTS cabin_context_zones_factor_idx ON public.cabin_context_zones(rep_slug, factor);

-- Named-cabin claims from aggregator guides. LEADS, not findings: medium
-- confidence at best, and they may name cabins that do not exist — which is
-- exactly why they are quarantined here instead of being merged into cabins.
CREATE TABLE IF NOT EXISTS public.cabin_context_leads (
  id          bigserial PRIMARY KEY,
  rep_slug    text NOT NULL REFERENCES public.cabin_class_context(rep_slug) ON DELETE CASCADE,
  cabin_nums  text[] NOT NULL DEFAULT '{}',  -- parsed from the research's free text
  raw_cabins  text,                          -- kept verbatim for audit
  claim       text,
  source      text,
  confidence  text,
  verified    boolean                        -- null = not yet checked against the grid
);
CREATE INDEX IF NOT EXISTS cabin_context_leads_rep_idx ON public.cabin_context_leads(rep_slug);

ALTER TABLE public.cabin_class_context  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cabin_context_ships  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cabin_context_zones  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cabin_context_leads  ENABLE ROW LEVEL SECURITY;
