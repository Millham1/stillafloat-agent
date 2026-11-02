-- 0065_group_quote.sql — the quote step between the names and the paperwork (Mark 2026-11-01: "there has to be an intermediary step …
-- the discussion is which cabin, do they want to use flexpay, drink package (if not included), insurance, do they need a hotel/ air/ transfers?
-- once those are answered and the quote is agreed to then the documentation is sent").
--   group_interests.quote           the guest's answers and the figures the page showed them, as computed from the group file (jsonb; never a
--                                   figure of its own); rewritten on every answer until it is agreed, then frozen
--   group_interests.quote_agreed_at when the guest tapped "I agree": the travelers go on the file and the paperwork link goes out
alter table public.group_interests
  add column if not exists quote jsonb,
  add column if not exists quote_agreed_at timestamptz;
