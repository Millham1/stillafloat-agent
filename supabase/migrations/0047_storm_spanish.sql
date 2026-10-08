-- 0047_storm_spanish.sql — Spanish text for storm alerts (release gate 2026-10-08, prod audit high
-- static-06: storm emails and the /es/ Storm Watch pages showed English to Spanish subscribers,
-- 8 of 11 of whom chose Spanish). The English columns stay the source Mark reviews; each gets a
-- Spanish twin the agent fills (faithful translation, no new facts). Apply dev first, then prod
-- with the dev→main promotion.
ALTER TABLE public.storm_alerts
  ADD COLUMN IF NOT EXISTS headline_es           text,
  ADD COLUMN IF NOT EXISTS body_md_es            text,
  ADD COLUMN IF NOT EXISTS detail_md_es          text,
  ADD COLUMN IF NOT EXISTS all_clear_headline_es text,
  ADD COLUMN IF NOT EXISTS all_clear_body_md_es  text;
