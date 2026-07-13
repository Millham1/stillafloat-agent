-- 0005_wms_registry.sql
-- WMS v2: the ships table becomes the FULL cruise-ship registry (Mark: "we can
-- have the entire ship list in the DB, which is nothing as far as data").
-- Search covers every registry ship; live AIS tracking activates on request
-- and is retained ("as more ships are added they get retained in the
-- scheduler"). Apply DEV FIRST, then PROD after sign-off.

ALTER TABLE public.ships
  ADD COLUMN IF NOT EXISTS homeport          text,          -- summer-2026 homeport (best effort)
  ADD COLUMN IF NOT EXISTS seed_active       boolean NOT NULL DEFAULT false, -- US East/Gulf/West Coast + San Juan fleet: tracked from day one
  ADD COLUMN IF NOT EXISTS last_requested_at timestamptz,   -- stamped when a visitor asks for this ship
  ADD COLUMN IF NOT EXISTS reported_name     text,          -- name the vessel broadcasts over AIS (self-heal signal)
  ADD COLUMN IF NOT EXISTS mmsi_suspect      boolean NOT NULL DEFAULT false; -- AIS name mismatch / long silence → re-verify MMSI

CREATE INDEX IF NOT EXISTS ships_requested_idx ON public.ships (last_requested_at DESC NULLS LAST);
