-- 0021 — what a guest in this room would HEAR, per room.
--
-- Mark, 2026-08-17, on what the room database has to carry:
--   "the room DB holds room numbers, classes, real and perceived obstructions,
--    noise issues above, below and a 40 ft radius around the room (elevators, etc)"
-- and, when asked how wide that radius had to be:
--   "it doesnt have to be 40 ft. the idea is to have an area around each room
--    that identifies noise. that would work with 4 rooms fore and aft of the
--    room and across the corridor"
--
-- 0020 answered above and below. This answers ALONGSIDE: the lift lobby, the
-- stairwell, the nightclub across the corridor — the things that are on your own
-- deck, a few doors away, and keep you up.
--
-- Filled by cabin-advisor/noise-features.py from the deck plans. The rule it
-- applies is Mark's, verbatim: cluster the deck into corridor rows, then take the
-- four rooms either side of the noise source in every row that hears it.
--
-- IMPORTANT, and the reason this is trustworthy: no room number in this column
-- was ever read by a model. A vision read is only ever asked WHERE the noise
-- source sits on the plan; the rooms around it come from cabins.pos_along /
-- pos_across, which the database already held. A misread digit therefore cannot
-- put a wrong room number in front of a guest.

alter table public.cabins
  add column if not exists noise_nearby text,
  add column if not exists noise_source text;

comment on column public.cabins.noise_nearby is
  'Plain-language list of what sits within four rooms fore and aft of this room, and across its corridor: "lift lobby", "stairwell", or a named venue. NULL means nothing was found near it, not that nothing is there — check deck_read_log for whether that deck has been read at all.';
comment on column public.cabins.noise_source is
  'Which deck plan the neighbourhood came from, so any line here can be traced back to a document.';

create index if not exists cabins_noise_nearby_idx
  on public.cabins (ship_slug, deck) where noise_nearby is not null;
