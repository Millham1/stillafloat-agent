-- 0024: researched view-blockage columns on cabins (applied to dev 2026-08-19; file added 2026-08-21)
alter table public.cabins add column if not exists view_blocked text;
alter table public.cabins add column if not exists view_blocked_source text;
