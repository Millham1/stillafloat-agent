-- 0045: group marketing (Mark 2026-10-04: "next is building the marketing").
--   * groups.marketing        — Mark's interview answers (who the group is, the
--                               occasion, his pitch, how to reserve). Things the
--                               contract cannot tell us.
--   * groups.marketing_copy   — the written copy per language, editable, with the
--                               moment Mark approved it. FACTS (dates, prices,
--                               ports, amenities, deadlines) are never stored in
--                               copy: the page renders them from the group file,
--                               so the words can never drift from the booking.
--   * groups.share_code       — the unguessable code in the group page link. The
--                               page is shared by link and never indexed.
--   * group_interests         — "hold a cabin for me" replies from the group page.
--                               Public write goes through the backend only.
alter table public.groups
  add column if not exists marketing jsonb not null default '{}'::jsonb,
  add column if not exists marketing_copy jsonb not null default '{}'::jsonb,
  add column if not exists marketing_approved_at timestamptz,
  add column if not exists share_code text unique;

create table if not exists public.group_interests (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  first_name text not null,
  last_name text,
  email text not null,
  phone text,
  lang text not null default 'en' check (lang in ('en','es')),
  cabin_type text,                       -- which category they asked about
  guests integer,
  note text,
  newsletter_opt_in boolean not null default false,
  status text not null default 'new' check (status in ('new','contacted','booked','declined','spam')),
  ip_hash text,
  prospect_id uuid,
  traveler_id uuid references public.group_travelers(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists group_interests_group_idx on public.group_interests (group_id, created_at);
alter table public.group_interests enable row level security;
comment on table public.group_interests is 'Replies from a group marketing page ("hold a cabin for me"). Service role only.';
