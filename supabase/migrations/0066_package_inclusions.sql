-- 0066 — what each cruise line's paid package includes, in a table of our own (Mark 2026-11-05: "review everything included in
-- the ultimate license to chill package and add to the confirmation what is missing. take a note to do this for all carriers and
-- make a table so we dont have to search every time"). A booking confirmation prints only the package's NAME and price; the
-- intake reader (routes/group-intake.ts, lib/package-inclusions.ts) looks the name up here and lists what the guest gets.
-- One row per line + ship + package as the line sells it; `inclusions` are the line's own words from `source_url`, read on
-- `checked_on`. A row is data: adding a carrier's package is an insert, no deploy.

create table if not exists public.package_inclusions (
  id uuid primary key default gen_random_uuid(),
  cruise_line text not null,                -- as the line names itself ('Margaritaville at Sea')
  ship text,                                -- the ship the package is sold on ('Paradise'); null = every ship of the line
  package_name text not null,               -- as the confirmation prints it, any case ('Ultimate License to Chill')
  sold_per text not null default 'guest' check (sold_per in ('guest', 'two guests', 'stateroom')),
  inclusions text[] not null,               -- one entry per thing the guest gets, the line's own words
  notes text,                               -- limits and what is NOT covered; for Mark, never shown to guests
  source_url text not null,
  checked_on date not null,
  updated_at timestamptz not null default now()
);
create unique index if not exists package_inclusions_key on public.package_inclusions (lower(cruise_line), lower(coalesce(ship, '')), lower(package_name), sold_per);
alter table public.package_inclusions enable row level security;

comment on table public.package_inclusions is 'What a cruise line''s paid package includes (0066), from the line''s own page; the booking intake lists these under a paid add-on of the same name.';

insert into public.package_inclusions (cruise_line, ship, package_name, sold_per, inclusions, notes, source_url, checked_on)
values (
  'Margaritaville at Sea', 'Paradise', 'Ultimate License to Chill', 'guest',
  array[
    'Ultimate Beverage Chill Package',
    'One dinner at JWB Steakhouse',
    'One Sparkling Brunch',
    '$25 dining credit for a la carte purchases at Far Side Sushi',
    '$100 Shore Excursion Credit',
    '$200 credit for St. Somewhere Spa and Salon',
    'Premium WiFi for one device',
    'Priority embarkation and debarkation (Express Check-In)',
    'Priority Luggage Delivery',
    'VIP Lounge Access during embarkation at the Port of Palm Beach',
    'Shore Excursion Booking Assistance'
  ],
  'The price printed on a confirmation already carries the package''s mandatory 20% service charge. The daily stateroom gratuity ($22 per person, per night, as of 2026-01-30) is NOT part of the package: it is added to the stateroom account on board. The line''s page prints "Express Check-In"; priority debarkation is Mark''s own knowledge of the package (2026-11-05). Spa credit is for services, not retail. Dining benefits are for one guest, not shared.',
  'https://www.margaritavilleatsea.com/current-offers/paradise-ultimate-license-to-chill',
  '2026-11-05'
)
on conflict do nothing;
