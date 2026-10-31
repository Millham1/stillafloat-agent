-- 0064 — what a U.S. passport needs at every destination, in a table of our own (Mark 2026-10-31: "these free APIs carry the
-- visa requirements. since this doesn't change often we can load a table in the DB and set a job to review every 3 months").
-- Loaded from the Passport Index dataset on GitHub (ilyankou/passport-index-dataset, the data behind the free passport-visa
-- APIs; one CSV, no key, no quota) by the daily job scheduleVisaRequirements (server/src/index.ts, lib/visa-requirements.ts),
-- which refreshes the table only when its rows are due (every 90 days) or missing. The passport checklist's visa line reads it
-- and still names the State Department's country page for the traveler to verify.

create table if not exists public.visa_requirements (
  passport text not null,                   -- ISO 3166-1 alpha-2 of the passport ('US')
  destination_iso2 text not null,
  destination_name text not null,
  requirement text not null check (requirement in ('visa-free', 'visa-on-arrival', 'e-visa', 'eta', 'visa-required', 'no-admission', 'unknown')),
  stay_days integer,                        -- the visa-free stay the dataset gives, in days, when it gives one
  raw text not null,                        -- the dataset's value, verbatim
  source text not null,
  source_url text not null,
  checked_at timestamptz not null,
  next_check_at timestamptz not null,       -- checked_at + 90 days: the quarterly review
  updated_at timestamptz not null default now(),
  primary key (passport, destination_iso2)
);
create index if not exists visa_requirements_due_idx on public.visa_requirements (next_check_at);
alter table public.visa_requirements enable row level security;

comment on table public.visa_requirements is 'Visa requirement per passport and destination (0064), loaded from the Passport Index dataset and reviewed every 90 days by scheduleVisaRequirements; read by the passport checklist.';
