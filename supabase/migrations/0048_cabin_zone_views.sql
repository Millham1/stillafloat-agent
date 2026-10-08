-- 0048_cabin_zone_views.sql — a research zone can be limited to cabins with a given view.
-- 2026-10-08 (release gate cabins.cabin-check-matches-deck-map): the Wonder of the Seas zone about
-- inward-facing Boardwalk/Central Park balconies matched every aft/mid cabin on decks 8-14, so
-- sea-facing balconies 8272/8732 were told they "face inward". Empty = applies to every view.
ALTER TABLE public.cabin_context_zones
  ADD COLUMN IF NOT EXISTS views text[] NOT NULL DEFAULT '{}'::text[];

-- The one zone known to need it today (keyed by its text, not its id).
UPDATE public.cabin_context_zones
   SET views = '{boardwalk,garden}'
 WHERE rep_slug = 'wonder-of-the-seas'
   AND what LIKE 'Neighborhood (Boardwalk/Central Park) balconies face inward%';
