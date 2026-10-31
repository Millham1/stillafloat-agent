-- Mark 2026-10-30: "they should be able to select the policy/price here" — the Allianz plans for a sailing, as quoted in AgentMax,
-- one per line ("OneTrip Prime: $129 per person"), shown on the paperwork's insurance step to pick from whenever the box cannot
-- quote the traveler itself. Free text on the group file, like line_protection (0060).
alter table public.groups add column if not exists insurance_plans text;
