-- 0029_watch_baseline_at.sql — ship watches use the storm course-change classifier
-- (Mark, 2026-09-05). Apply DEV FIRST, then PROD with the dev→main promotion.
--
-- The watch sweep used the same "any destination change is a course update" rule
-- the storm feature just replaced, so the first watcher would have been emailed
-- every scheduled port rotation. The classifier needs to know WHEN the recorded
-- baseline was declared to tell a completed leg from a mid-leg re-route.
ALTER TABLE public.ship_watches
  ADD COLUMN IF NOT EXISTS last_destination_at timestamp with time zone;
