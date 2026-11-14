-- Mark 2026-11-13: "you should be able to pull coverage off the sites as needed, then store them for future use" (travel protection coverages, for
-- Allianz's plans and for a cruise line's own plan). What a plan COVERS does not change with the booking, so it is kept once and reused:
--   protection_plans          one row a plan as read for the residents of one state (Allianz: off its agent site with a quote; a cruise line's own
--                             plan: off its insurer's public plan-document page), with where and when it was read
--   protection_plan_benefits  the plan's benefit table, line by line and in order; a limit listed under a benefit points at it (parent_position)
-- Prices are NOT kept here: an Allianz price belongs to one trip, and Mark notes the cruise line's price himself.
create table if not exists public.protection_plans (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('allianz', 'cruise-line')),
  cruise_line text,
  plan_name text not null,
  product_code text,
  state text,
  about text,
  source_en text not null,
  source_es text not null,
  source_url text,
  read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists protection_plans_one_per_plan_and_state
  on public.protection_plans (provider, coalesce(cruise_line, ''), plan_name, coalesce(state, ''));
create table if not exists public.protection_plan_benefits (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.protection_plans(id) on delete cascade,
  position integer not null,
  parent_position integer,
  name text not null,
  value text not null default ''
);
create index if not exists protection_plan_benefits_by_plan on public.protection_plan_benefits (plan_id, position);
alter table public.protection_plans enable row level security;
alter table public.protection_plan_benefits enable row level security;
comment on table public.protection_plans is 'A travel protection plan as read for the residents of one state: Allianz (off its agent site) or a cruise line''s own plan (off its insurer''s plan-document page). Coverages only, never a price.';
comment on table public.protection_plan_benefits is 'A plan''s benefit table in order. parent_position set = a limit listed under the benefit at that position.';
comment on column public.protection_plans.state is 'Two-letter state of residence the coverages were read for.';
comment on column public.protection_plans.source_en is 'Where the coverages were read, as said to the guest under the table (English).';
