-- 0004_wheres_my_ship.sql
-- "Where's My Ship?" live cruise tracker (WMS). Apply DEV FIRST, then PROD
-- after Mark's sign-off.
--
-- ships.mmsi/imo key the free aisstream.io AIS feed. subscribers.tier is the
-- premium designator (everything is free during the launch window, but the
-- column makes the future paywall a flag-flip). ship_watches holds saved
-- searches for the email-alert service. sailings.source distinguishes the
-- AIS-derived rolling itineraries (which now auto-populate the storm feature's
-- impacted-ship matching) from manually entered future sailings.

ALTER TABLE public.ships
  ADD COLUMN IF NOT EXISTS mmsi text,
  ADD COLUMN IF NOT EXISTS imo  text;
CREATE UNIQUE INDEX IF NOT EXISTS ships_mmsi_key
  ON public.ships (mmsi) WHERE mmsi IS NOT NULL;

ALTER TABLE public.subscribers
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'free';

ALTER TABLE public.sailings
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'; -- manual | ais

CREATE TABLE IF NOT EXISTS public.ship_watches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id    uuid NOT NULL REFERENCES public.subscribers(id) ON DELETE CASCADE,
  ship_name        text NOT NULL,
  sailing_start    date NOT NULL,
  sailing_end      date NOT NULL,
  status           text NOT NULL DEFAULT 'active',   -- active | ended | stopped
  last_destination text,                              -- last AIS-declared port slug (scrub baseline)
  itinerary_flags  jsonb NOT NULL DEFAULT '[]'::jsonb, -- recorded (not displayed) change events
  alerted          jsonb NOT NULL DEFAULT '[]'::jsonb, -- hashes of alerts already emailed (dedup)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ship_watches_status_check CHECK (status = ANY (ARRAY['active','ended','stopped']))
);
CREATE INDEX IF NOT EXISTS ship_watches_active_idx
  ON public.ship_watches (status, sailing_start, sailing_end);
ALTER TABLE public.ship_watches ENABLE ROW LEVEL SECURITY; -- service-role only
