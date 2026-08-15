-- The concierge results tell the visitor to "pull it up on the deck plan and
-- check me" — which means we must actually hand them the deck plan (Mark,
-- 2026-08-12). We LINK to each line's official deck-plan page (never rehost
-- the artwork — cabin-advisor/DESIGN.md §7); a ship without a URL simply
-- doesn't make the check-me claim in the UI.
alter table public.cabin_ships
  add column if not exists deckplan_url text;

comment on column public.cabin_ships.deckplan_url is
  'Official cruise-line deck-plans page for this ship (linked, never rehosted). Null = UI omits deck-plan references.';

update public.cabin_ships
  set deckplan_url = 'https://www.royalcaribbean.com/cruise-ships/wonder-of-the-seas/deck-plans'
  where slug = 'wonder-of-the-seas';
