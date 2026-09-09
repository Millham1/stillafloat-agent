-- 0033: affiliate_clicks — first-party click log for the /api/go/:itemId redirect
-- (Mark's decision 2026-09-09: no third-party analytics script; our own server
-- logs the click and 302s straight to the tagged Amazon URL). Backend/service
-- role only: RLS on, no anon policies — visitors never read or write this table
-- directly, they only trigger a redirect.
create table if not exists public.affiliate_clicks (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null,                -- affiliate_items.id (stored today inside the
                                         -- platform_state "affiliate-items" JSON blob,
                                         -- not a live FK — items are not a SQL table yet)
  category text,
  page text,                            -- attribution: category slug | newsletter | social
  lang text,                            -- en | es
  referrer text,
  ua_hash text,                         -- sha256(user-agent) — never the raw UA
  ip_hash text,                         -- sha256(ip + daily salt) — never the raw IP
  clicked_at timestamptz not null default now()
);
create index if not exists affiliate_clicks_item_time_idx on public.affiliate_clicks (item_id, clicked_at);
create index if not exists affiliate_clicks_time_idx on public.affiliate_clicks (clicked_at);
alter table public.affiliate_clicks enable row level security;
comment on table public.affiliate_clicks is 'First-party affiliate click log for /api/go/:itemId. Service role only.';
