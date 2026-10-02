-- 0041: group bookings — the "one place" for a group's file (Mark, 2026-10-02).
-- A group = one block of cabins on one sailing (first two: the American Legion
-- group and the 91st-birthday family group, 16 cabins each). Everything a group
-- needs hangs off groups.id: cabins, travelers, paperwork, payment schedule,
-- flights/hotels/transfers, checklist items and the email log.
--
-- HARD RULES encoded here:
--   * NO payment-card data, ever. There is no column for a card number, expiry or
--     CVV, and group_payments.method_note / confirmation_ref are for the cruise
--     line's receipt reference only. Card authorization happens outside this DB.
--   * Passport numbers are stored only as app-level ciphertext (passport_enc,
--     AES-256-GCM, key in shared.env) plus the last 4 for display. The API never
--     selects passport_enc.
--   * Service role only: RLS on, no anon policies. Clients reach their own form
--     through a signed link handled by the backend, never by the anon key.

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  status text not null default 'draft'
    check (status in ('draft','marketing','booking','final-paid','sailed','closed','cancelled')),
  organizer_name text,
  organizer_email text,
  organizer_phone text,
  cruise_line text,
  ship_name text,
  ship_slug text,                        -- cabin_ships.slug when the Room Concierge knows the hull
  sail_date date,
  return_date date,
  nights integer,
  embark_port text,
  itinerary jsonb not null default '[]'::jsonb,   -- [{day, date, port, arrive, depart}]
  group_number text,                     -- the cruise line's group booking id
  cabins_held integer,
  amenities jsonb not null default '[]'::jsonb,   -- ["$50 onboard credit per cabin", ...]
  deposit_per_person numeric(10,2),
  deposit_due date,
  names_due date,                        -- the line's deadline for passenger names
  final_payment_due date,
  recall_date date,                      -- the line takes back unsold cabins
  lang text not null default 'en' check (lang in ('en','es','both')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.group_cabins (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  cabin_num text,
  deck text,
  category text,                         -- Inside / Ocean View / Balcony / Suite
  category_code text,                    -- the line's code (e.g. 8C)
  status text not null default 'held'
    check (status in ('held','offered','booked','released','cancelled')),
  booking_number text,
  price_total numeric(10,2),
  deposit_amount numeric(10,2),
  insurance text not null default 'not-offered'
    check (insurance in ('not-offered','offered','accepted','declined')),
  dining text,
  bed_config text,
  concierge_sent_at timestamptz,         -- Room Concierge assessment emailed
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists group_cabins_group_idx on public.group_cabins (group_id);

create table if not exists public.group_travelers (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  cabin_id uuid references public.group_cabins(id) on delete set null,
  is_lead boolean not null default false,          -- the cabin's contact / payer
  first_name text,
  middle_name text,
  last_name text,
  dob date,
  gender text,
  citizenship text,
  email text,
  phone text,
  lang text not null default 'en' check (lang in ('en','es')),
  loyalty_number text,
  passport_enc text,                     -- ciphertext only; never returned by the API
  passport_last4 text,
  passport_country text,
  passport_expiry date,
  emergency_name text,
  emergency_phone text,
  special_needs text,                    -- dietary / accessibility / medical notes they chose to share
  form_token_hash text,                  -- sha256 of the traveler's private form link token
  form_sent_at timestamptz,
  form_submitted_at timestamptz,
  consent_name text,                     -- typed signature
  consent_signed_at timestamptz,
  consent_ip_hash text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists group_travelers_group_idx on public.group_travelers (group_id);
create index if not exists group_travelers_cabin_idx on public.group_travelers (cabin_id);
create unique index if not exists group_travelers_token_idx
  on public.group_travelers (form_token_hash) where form_token_hash is not null;

create table if not exists public.group_documents (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  cabin_id uuid references public.group_cabins(id) on delete cascade,
  traveler_id uuid references public.group_travelers(id) on delete cascade,
  kind text not null default 'other'
    check (kind in ('group-contract','host-agency','client-terms','insurance-waiver',
                    'card-auth-reference','invoice','confirmation','other')),
  title text not null,
  status text not null default 'needed'
    check (status in ('needed','sent','signed','received','filed','not-required')),
  owner text not null default 'mark' check (owner in ('mark','client')),
  due_date date,
  completed_at timestamptz,
  storage_path text,                     -- private Supabase Storage object, when a file is kept
  external_ref text,                     -- where it lives if not with us (line portal, host agency)
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists group_documents_group_idx on public.group_documents (group_id);

create table if not exists public.group_payments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  cabin_id uuid references public.group_cabins(id) on delete cascade,
  kind text not null default 'deposit' check (kind in ('deposit','final','other')),
  amount numeric(10,2),
  due_date date,
  paid_at timestamptz,
  method_note text,                      -- "paid to the line by phone" — NEVER card details
  confirmation_ref text,                 -- the line's receipt reference
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists group_payments_group_idx on public.group_payments (group_id);
create index if not exists group_payments_due_idx on public.group_payments (due_date) where paid_at is null;

create table if not exists public.group_travel (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  cabin_id uuid references public.group_cabins(id) on delete cascade,
  traveler_id uuid references public.group_travelers(id) on delete cascade,
  kind text not null check (kind in ('flight','hotel','transfer')),
  direction text not null default 'pre' check (direction in ('pre','post')),
  provider text,                         -- airline / hotel / transfer company
  reference text,                        -- flight number / room type
  from_place text,
  to_place text,
  starts_at timestamptz,
  ends_at timestamptz,
  confirmation text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists group_travel_group_idx on public.group_travel (group_id);

create table if not exists public.group_checklist (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  cabin_id uuid references public.group_cabins(id) on delete cascade,
  audience text not null default 'mark' check (audience in ('mark','client')),
  kind text not null default 'task' check (kind in ('task','product','excursion')),
  title text not null,
  detail text,
  link_url text,
  due_date date,
  done_at timestamptz,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists group_checklist_group_idx on public.group_checklist (group_id);

create table if not exists public.group_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  cabin_id uuid references public.group_cabins(id) on delete set null,
  traveler_id uuid references public.group_travelers(id) on delete set null,
  audience text not null default 'client' check (audience in ('client','mark')),
  template text not null,                -- invitation / deposit-reminder / final-reminder / ...
  to_email text,
  subject text,
  body_html text,
  status text not null default 'draft'
    check (status in ('draft','approved','queued','sent','failed','skipped')),
  scheduled_for timestamptz,
  sent_at timestamptz,
  error text,
  dedupe_key text unique,                -- one reminder per (template, cabin, due date)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists group_messages_group_idx on public.group_messages (group_id);
create index if not exists group_messages_due_idx on public.group_messages (scheduled_for) where sent_at is null;

alter table public.groups enable row level security;
alter table public.group_cabins enable row level security;
alter table public.group_travelers enable row level security;
alter table public.group_documents enable row level security;
alter table public.group_payments enable row level security;
alter table public.group_travel enable row level security;
alter table public.group_checklist enable row level security;
alter table public.group_messages enable row level security;

comment on table public.groups is 'Group bookings: one row per cabin block on a sailing. Service role only.';
comment on table public.group_cabins is 'Cabins in a group block. Service role only.';
comment on table public.group_travelers is 'Travelers in a group (PII; passport as ciphertext only). Service role only.';
comment on table public.group_documents is 'Paperwork tracker per group/cabin/traveler. Service role only.';
comment on table public.group_payments is 'Payment schedule and receipts per cabin. No card data. Service role only.';
comment on table public.group_travel is 'Flights, hotels and transfers per group/cabin/traveler. Service role only.';
comment on table public.group_checklist is 'Checklist items for Mark and for clients (tasks, product links, excursions). Service role only.';
comment on table public.group_messages is 'Email queue + log for group communications. Service role only.';
