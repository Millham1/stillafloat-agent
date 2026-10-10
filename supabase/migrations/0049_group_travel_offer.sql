-- 0049: air, hotel before the cruise and transfers as part of the quote (Mark 2026-10-10:
-- "I also need to add airfare, hotel before, and transfers from hotel to port and port to airport.
-- We need an input field after the induction of the cruise quote. If the quote holds transfers,
-- air and hotel then the fields prepopulate."). group_travel already holds flight/hotel/transfer
-- rows per traveler; a row with no traveler/cabin is the GROUP's offer. Three columns make an
-- offer priceable and traceable:
--   price_per_person  what the line quotes for it (null = not priced on the document)
--   included          true when the quote includes it in the cruise price
--   source            'quote' (read from the document) or 'mark' (typed in)
alter table public.group_travel
  add column if not exists price_per_person numeric,
  add column if not exists included boolean not null default false,
  add column if not exists source text not null default 'mark' check (source in ('quote','mark'));
