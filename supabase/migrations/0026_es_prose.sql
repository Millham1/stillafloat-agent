-- 0026: ES-first-class prose columns (applied to dev 2026-08-20; file added 2026-08-21)
alter table public.cabin_context_zones add column if not exists what_es text;
alter table public.cabin_context_zones add column if not exists effect_es text;
alter table public.cabin_advice add column if not exists label_es text;
alter table public.cabin_advice add column if not exists recommendations_es jsonb;
alter table public.cabin_advice add column if not exists steer_clear_es jsonb;
