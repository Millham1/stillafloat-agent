-- 0031: port_tips — good-to-know port intel Mark gathers (phone notes) for the future
-- port guides (2026-09-06). Backend/service role only: RLS on, no anon policies.
create table if not exists public.port_tips (
  id uuid primary key default gen_random_uuid(),
  port_slug text not null,                      -- norfolk, port-canaveral, nassau …
  port_name text not null,                      -- "Norfolk, Virginia"
  region text,                                  -- "US East Coast"
  category text not null,                       -- parking | transport | terminal | hotel | food | excursion | other
  title text not null,
  body text not null,                           -- Mark's fact, in his words where possible
  body_es text,                                 -- Spanish twin (ES is first-class)
  price_usd numeric,
  price_note text,                              -- "$20/day"
  source text,                                  -- "Mark phone note 2026-09-05"
  source_idea_id uuid,
  verified boolean not null default false,      -- true when Mark saw it himself
  status text not null default 'active',        -- active | retired
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists port_tips_port_idx on public.port_tips (port_slug, category);
alter table public.port_tips enable row level security;
comment on table public.port_tips is 'Good-to-know port intel (Mark''s phone notes) for the future port guides. Service role only.';
