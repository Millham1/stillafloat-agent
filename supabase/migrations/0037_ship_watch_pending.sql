-- 0037 — ship watches from the storm pages: they can wait for a subscriber to confirm, and
-- they run for a set number of days instead of a sailing's dates.
--
-- Mark, 2026-09-15, on the storm pages' "Track this ship" buttons: "it should be a direct
-- link to sign up to the tracker with subscription." A visitor who is not a confirmed
-- subscriber yet can now start a watch in the same step as subscribing. The watch is saved
-- as 'pending' and becomes 'active' when they click the confirmation link
-- (routes/subscribe.ts verify-email). Every alert sweep reads only 'active' watches, so a
-- pending one never emails anyone.
--
-- Then: "A storm tracker is only good for the duration of the storm. I think we can remove
-- the start and end dates, but need to give the user an option in the email to stop
-- tracking, maybe set a 15 day cap then restart." window_days = 15 marks such a watch:
-- sailing_start/sailing_end hold its current 15 days, the hourly sweep ends it after the
-- last day with an email offering another 15, and a restart moves the dates forward. Null
-- for a watch on a sailing's own dates from the tracker page, which works as it always has.
--
-- source records where the watch was started ('tracker' page form, 'storm' page buttons),
-- so the storm path's sign-ups can be counted. Apply DEV FIRST, then PROD.

ALTER TABLE public.ship_watches DROP CONSTRAINT IF EXISTS ship_watches_status_check;
ALTER TABLE public.ship_watches
  ADD CONSTRAINT ship_watches_status_check CHECK (status = ANY (ARRAY['pending', 'active', 'ended', 'stopped']));

ALTER TABLE public.ship_watches ADD COLUMN IF NOT EXISTS source text;  -- 'tracker' | 'storm' | … ; null for watches before 0037

ALTER TABLE public.ship_watches ADD COLUMN IF NOT EXISTS window_days integer
  CHECK (window_days IS NULL OR window_days BETWEEN 1 AND 40);  -- 15 for storm-page watches; null = a sailing's dates
