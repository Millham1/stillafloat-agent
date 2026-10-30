-- 0059: the cardholder's driver's licence on the credit card authorization (Mark 2026-10-30: "we need to add back the drivers
-- license fields. this form should mimic the cornerstone form"). Cornerstone's e-signed form takes the state and number to verify
-- identity and keeps the number encrypted; so do we: the number is encrypted with GROUP_PII_KEY like the passport (lib/group-secure.ts),
-- only its last four and the state are ever read back, and the signature's answers hold "ending NNNN".
alter table public.group_travelers
  add column if not exists dl_enc text,
  add column if not exists dl_last4 text,
  add column if not exists dl_state text;
comment on column public.group_travelers.dl_enc is 'Driver''s licence number, AES-256-GCM under GROUP_PII_KEY (v1:iv:tag:ct). Written by the card authorization; never returned by any API.';
comment on column public.group_travelers.dl_last4 is 'Last four characters of the driver''s licence number, for the file and the signed copy.';
comment on column public.group_travelers.dl_state is 'The state that issued the driver''s licence, as typed (two letters).';
