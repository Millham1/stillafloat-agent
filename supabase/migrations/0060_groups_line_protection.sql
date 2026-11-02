-- 0060 — the cruise line's own protection plan, as Mark quotes it on the group file (Mark 2026-10-29: "we should also offer
-- the ship's rate for insurance"). Free text, e.g. "MSC Vacation Protection: $89 per person"; shown on the insurance step
-- beside the Allianz quote, and chosen on the Travel Insurance document as "The cruise line's own protection plan".
alter table public.groups add column if not exists line_protection text;
