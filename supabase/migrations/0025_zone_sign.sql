-- 0025: research zones carry a polarity sign — penalty | benefit | neutral
-- (applied to dev 2026-08-19; file added 2026-08-21). Default penalty preserves
-- the pre-sign behaviour for any zone inserted without one.
alter table public.cabin_context_zones add column if not exists sign text not null default 'penalty';
