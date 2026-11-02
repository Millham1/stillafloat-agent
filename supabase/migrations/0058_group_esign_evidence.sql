-- 0058: electronic-signature evidence for the client paperwork (Mark 2026-10-25: "how am I sure the electronic
-- signatures conform legally, like a docusign signature would"). Four additions, all evidence, no new documents:
--   1. consent to do business electronically, given once per signer before the first signature (ESIGN consumer consent);
--   2. when the private link was first and last opened (the audit page prints it);
--   3. the signer's network address and browser in clear on each signature, as DocuSign records them (before today
--      only one-way hashes were kept; the table is service-key only, RLS stays on);
--   4. whether the signed PDF was sealed with our certificate, and the long-lived "your signed copies" link.
alter table public.group_travelers
  add column if not exists esign_consent_at timestamptz,
  add column if not exists esign_consent_ip text,
  add column if not exists esign_consent_ua text,
  add column if not exists esign_consent_version text,
  add column if not exists form_opened_at timestamptz,
  add column if not exists form_last_opened_at timestamptz,
  add column if not exists copies_token_hash text,
  add column if not exists copies_sent_at timestamptz;
create unique index if not exists group_travelers_copies_token_hash_idx on public.group_travelers (copies_token_hash) where copies_token_hash is not null;

alter table public.groups
  add column if not exists organizer_esign_consent_at timestamptz,
  add column if not exists organizer_esign_consent_ip text,
  add column if not exists organizer_esign_consent_ua text,
  add column if not exists organizer_esign_consent_version text,
  add column if not exists organizer_form_opened_at timestamptz,
  add column if not exists organizer_form_last_opened_at timestamptz,
  add column if not exists organizer_copies_token_hash text,
  add column if not exists organizer_copies_sent_at timestamptz;
create unique index if not exists groups_organizer_copies_token_hash_idx on public.groups (organizer_copies_token_hash) where organizer_copies_token_hash is not null;

alter table public.group_signatures
  add column if not exists ip text,
  add column if not exists ua text,
  add column if not exists sealed boolean not null default false,
  add column if not exists seal_fingerprint text;
