-- 0050: the group MARKETING PACKAGE (Mark 2026-10-10: "A poster, email campaign, a facebook campaign,
-- etc." built on the cruise line's imagery, fetched by the system — "so I don't have to go in and
-- download anything").
--
--   * group_assets: photographs the package may use, per ship or destination (group_id null = shared
--     by every group on that ship). Each row keeps where it came from, its license and the credit
--     line the poster must print. Sources today: Wikimedia Commons (open licenses; MSC's own site
--     refuses automated reads) and, when a line's rep sends the kit, 'line-kit'.
--   * groups.marketing_package: the chosen photos, the rendered poster / social images (public bucket
--     paths + URLs) and the email + Facebook campaign copy, with Mark's edits.
create table if not exists public.group_assets (
  id uuid primary key default gen_random_uuid(),
  group_id uuid references public.groups(id) on delete cascade,
  cruise_line text,
  ship_name text,
  subject text not null,                 -- 'ship' | 'destination:<name>'
  source text not null check (source in ('wikimedia','line-kit','mark')),
  source_url text not null,              -- the file / page it came from
  page_url text,
  title text,
  license text,                          -- e.g. 'CC BY 4.0', 'CC0'
  share_alike boolean not null default false,
  attribution text,                      -- the credit line to print
  width integer,
  height integer,
  storage_path text not null,            -- in the public 'group-marketing' bucket
  public_url text not null,
  created_at timestamptz not null default now()
);
create index if not exists group_assets_ship_idx on public.group_assets (ship_name, subject);
alter table public.group_assets enable row level security;

alter table public.groups
  add column if not exists marketing_package jsonb not null default '{}'::jsonb;
