-- 0062 — the card's owner signs the credit card authorization on a link of their own (Mark 2026-10-30: "for the CC, build the
-- link to be sent to the owner of the card if that choice is selected"). The owner's own state lives beside the lead traveler's
-- on the same group_travelers row, under card_* twins of the traveler's columns: the link (its sha256 only), when it was sent and
-- opened, the owner's consent to electronic records, and the owner's copies link. The signature row says signer_role = 'cardholder'.
--
-- The insurance choice made on the paperwork page (quote / the line's plan / own policy / decline) is kept in form_data.insurance
-- and needs no column: it decides which insurance document the packet carries (23 the plan, or 07 Cornerstone's declination).

alter table public.group_travelers
  add column if not exists card_token_hash text,
  add column if not exists card_link_sent_at timestamptz,
  add column if not exists card_form_opened_at timestamptz,
  add column if not exists card_form_last_opened_at timestamptz,
  add column if not exists card_esign_consent_at timestamptz,
  add column if not exists card_esign_consent_ip text,
  add column if not exists card_esign_consent_ua text,
  add column if not exists card_esign_consent_version text,
  add column if not exists card_copies_token_hash text,
  add column if not exists card_copies_sent_at timestamptz;

create unique index if not exists group_travelers_card_token_idx
  on public.group_travelers (card_token_hash) where card_token_hash is not null;
create unique index if not exists group_travelers_card_copies_token_idx
  on public.group_travelers (card_copies_token_hash) where card_copies_token_hash is not null;

alter table public.group_signatures drop constraint if exists group_signatures_signer_role_check;
alter table public.group_signatures add constraint group_signatures_signer_role_check
  check (signer_role in ('traveler','lead','organizer','guardian','agent','cardholder'));

comment on column public.group_travelers.card_token_hash is 'sha256 of the card owner''s private link to the credit card authorization (0062); set only when the card belongs to someone other than the traveler.';
