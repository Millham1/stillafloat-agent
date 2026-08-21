-- 0023 — the noise neighbourhood, in a form Spanish can be written from.
--
-- 0021 stores what is near a room as English prose ("lift lobby", "stairwell and
-- The Martini Bar"). Dropping that straight into the Spanish concierge would be
-- exactly the failure Mark named on 8/15 — an ES page carrying English is "just a
-- copy". Venue names are proper nouns and stay put in either language; "lift
-- lobby" and "stairwell" are not, and have to be written fresh in Spanish.
--
-- So the room also carries the KIND of the loudest thing near it, and each
-- language renders its own words for it. The prose column stays as the readable
-- record and the source of venue names.

alter table public.cabins
  add column if not exists noise_kind text;

comment on column public.cabins.noise_kind is
  'The loudest thing near this room, as a code the API can write either language from: lift | stairs | venue. The prose in noise_nearby carries the detail and any venue name.';
