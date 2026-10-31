-- 0063 — the passport and travel document checklist (Cornerstone's 16) is no longer signed (Mark 2026-10-31: "the passport and
-- document checklist does not need to be a signed document. it should be separate / pre-populated with the info we have, and sent
-- separately"). It is prepared from the file (the passport on file, every itinerary country's visa and vaccination requirements,
-- the insurance choice, the emergency contact) and emailed to the traveler on a link of its own: once their paperwork is complete,
-- and again from the group file whenever Mark asks. Only the link's sha256 is stored, with when it was sent.

alter table public.group_travelers
  add column if not exists checklist_token_hash text,
  add column if not exists checklist_sent_at timestamptz;

create unique index if not exists group_travelers_checklist_token_idx
  on public.group_travelers (checklist_token_hash) where checklist_token_hash is not null;

comment on column public.group_travelers.checklist_token_hash is 'sha256 of the traveler''s private link to their passport and travel document checklist (0063): the checklist is prepared from the file and read, never signed.';
comment on column public.group_travelers.checklist_sent_at is 'When the checklist email last went out (0063); null when it never did or the sender refused it.';
