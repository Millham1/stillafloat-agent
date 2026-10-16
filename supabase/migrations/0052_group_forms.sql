-- 0052: client paperwork, the organizer's side (Mark 2026-10-03).
--
-- Travelers already have their own private link (group_travelers.form_token_hash, 0041) and their
-- signatures are unique per traveler, document and role (0044). The group organizer is not a row in
-- group_travelers, so the organizer's contract needs two things of its own:
--   * a private link: only the sha256 of the token is stored, exactly like a traveler's;
--   * one signature per group and document (the traveler-keyed unique index of 0044 does not cover a
--     signature that has no traveler).
-- The agent's countersignature on that contract is a later dashboard step and will use signer_role 'agent'.

alter table public.groups
  add column if not exists organizer_token_hash text,
  add column if not exists organizer_link_sent_at timestamptz;

create unique index if not exists groups_organizer_token_idx
  on public.groups (organizer_token_hash) where organizer_token_hash is not null;

create unique index if not exists group_signatures_organizer_once_idx
  on public.group_signatures (group_id, doc_key) where signer_role = 'organizer';
