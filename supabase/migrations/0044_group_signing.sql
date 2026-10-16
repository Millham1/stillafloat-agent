-- 0044: client paperwork — signatures, per-file fee overrides, the cruise line's
-- own cancellation schedule, and the long tail of form answers (Mark 2026-10-03).
--
--   * group_signatures: one row per signed document per signer. Typed-name
--     signature with timestamp, hashed IP / user agent, the exact answers given,
--     and a sha256 of the document text that was on screen — so a signed copy
--     can always be reproduced and shown to match.
--   * groups.fees: "no fees unless I hand change them" — empty by default; a fee
--     appears on a client's documents only when Mark enters one on that file.
--   * groups.cancellation_schedule: the LINE'S schedule read from its contract.
--     The Cornerstone templates print "typical" penalty tables; our pages show
--     the line's own where we have it.
--   * group_travelers.form_data: answers that have no dedicated column
--     (address, second emergency contact, dining, loyalty programs, optional
--     medical notes). Passport number stays in passport_enc only.

alter table public.groups
  add column if not exists fees jsonb not null default '{}'::jsonb,
  add column if not exists cancellation_schedule jsonb not null default '[]'::jsonb;

alter table public.group_travelers
  add column if not exists form_data jsonb not null default '{}'::jsonb,
  add column if not exists newsletter_opt_in boolean not null default false,
  add column if not exists prospect_id uuid;

create table if not exists public.group_signatures (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  cabin_id uuid references public.group_cabins(id) on delete set null,
  traveler_id uuid references public.group_travelers(id) on delete set null,
  doc_key text not null,                 -- terms / cruise-agreement / liability-waiver / card-authorization / ...
  doc_version text not null,             -- template version that was shown
  lang text not null default 'en' check (lang in ('en','es')),
  signer_role text not null default 'traveler'
    check (signer_role in ('traveler','lead','organizer','guardian','agent')),
  signer_name text not null,             -- the typed signature
  signed_at timestamptz not null default now(),
  ip_hash text,
  ua_hash text,
  answers jsonb not null default '{}'::jsonb,   -- what they ticked / entered on this document
  content_sha256 text not null,          -- hash of the rendered document text they agreed to
  pdf_path text,                         -- signed copy in the private group-docs bucket
  created_at timestamptz not null default now()
);
create index if not exists group_signatures_group_idx on public.group_signatures (group_id);
create index if not exists group_signatures_traveler_idx on public.group_signatures (traveler_id);
create unique index if not exists group_signatures_once_idx
  on public.group_signatures (traveler_id, doc_key, signer_role) where traveler_id is not null;

alter table public.group_signatures enable row level security;
comment on table public.group_signatures is 'Typed-name e-signatures on client documents, with the hash of the text agreed to. Service role only.';
