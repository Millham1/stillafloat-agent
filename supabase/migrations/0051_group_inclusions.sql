-- 0051: what the GUEST's fare includes (Mark 2026-10-10: "DO not list amenity points. that is not a
-- perk for the customer. the perks are premium drinks, etc and were in the quote").
--   groups.amenities  = the organizer's side (MSC amenity points etc.) — dashboard only, never public
--   groups.inclusions = the guest's perks printed on the quote (drinks package, Wi-Fi, …) — the page,
--                       the poster and every campaign piece list THESE
alter table public.groups
  add column if not exists inclusions text[] not null default '{}'::text[];
