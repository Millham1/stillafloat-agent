-- 0075 — the Vacation Genie: one row per single-booking interview.
--
-- The Genie is the non-group front door (Mark, 2026-11-24): a visitor gives their email, answers the
-- interview, is shown the ship, the room and the fare for a sailing, and the file is handed to Mark to
-- call them, finalize the quote and book. Unlike concierge_sessions (anonymous by construction) this row
-- IS a person: it starts with their email, on purpose, so Mark can follow up.
--
-- Service-role only, like every table holding a person. The page reaches it only through routes/genie.ts,
-- with the row's own access key.

CREATE TABLE IF NOT EXISTS public.genie_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Random, handed to the page once at the start; every later call must carry it.
  access_key      text NOT NULL,

  email           text NOT NULL,
  first_name      text NOT NULL,
  last_name       text NOT NULL,
  phone           text,
  lang            text NOT NULL DEFAULT 'en' CHECK (lang IN ('en','es')),

  -- The trip facts as checked by lib/genie-interview.ts parseTrip (adults, child ages, rooms, dates,
  -- nights, destination, room type, priority, budget, seasick, first cruise, occasion, mobility, notes).
  trip            jsonb,
  -- One answer index per question about them, in the order asked, and the same answers in words.
  choices         integer[],
  answers_words   jsonb,
  -- traits = the profile the answers add up to (lib/genie-interview.ts genieProfile): where they sit on
  -- each ship virtue, how much each counts, how many answers touched it and how far apart they were.
  -- axes = the five labels the "I picked them because" line was worded from.
  traits          jsonb,
  axes            jsonb,

  -- The ships put in front of them, and the one they went on with.
  suggested_ships text[],
  ship_slug       text,
  ship_name       text,
  ship_line       text,

  -- The sailing they picked {start, end, nights, ports[]} and the fares shown for it (lib/genie-pricing.ts).
  sailing         jsonb,
  fares           jsonb,
  price_lookups   integer NOT NULL DEFAULT 0,

  -- Cabin numbers they picked from the room list.
  cabins          text[],
  -- When they would like Mark to call, in their words.
  call_when       text,

  -- started  = gave their email, still answering
  -- finished = sent the file to Mark
  -- then Mark's own steps, set from the dashboard
  status          text NOT NULL DEFAULT 'started'
                  CHECK (status IN ('started','finished','contacted','quoted','booked','closed')),
  finished_at     timestamptz,
  mark_note       text
);

CREATE INDEX IF NOT EXISTS genie_sessions_status_idx ON public.genie_sessions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS genie_sessions_email_idx ON public.genie_sessions (email);

ALTER TABLE public.genie_sessions ENABLE ROW LEVEL SECURITY;  -- no policies: service role only

COMMENT ON TABLE public.genie_sessions IS
  'One row per Vacation Genie interview (single, non-group bookings): who they are, what they told us, the ship, sailing, fares and cabins they were shown and picked, and where Mark is with them.';
