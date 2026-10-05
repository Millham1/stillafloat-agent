-- 0046: the quote's terms, kept on the group file (Mark 2026-10-05: "copy the reader's
-- terms onto the group file"). Rates, review dates, the line's cancellation schedule and
-- other deadlines were readable only through groups.source_intake_id; the working view
-- needs them on the file itself. Written at accept from the confirmed read; not editable
-- from the dashboard column whitelist.
alter table public.groups
  add column if not exists terms jsonb not null default '{}'::jsonb;
