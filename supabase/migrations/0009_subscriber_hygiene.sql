-- Subscriber lifecycle hygiene: track reminder sends, bounces, and archiving of
-- never-confirmed subscribers. status remains an unconstrained text column (app
-- convention, matching the existing 'pending'/'confirmed'/'unsubscribed' set) —
-- this migration adds two new legal values, 'bounced' and 'archived', and the
-- timestamps that record when each transition happened.
alter table public.subscribers
  add column if not exists reminder_sent_at timestamptz,
  add column if not exists bounced_at timestamptz,
  add column if not exists archived_at timestamptz;

comment on column public.subscribers.reminder_sent_at is
  'When a confirmation-reminder email was sent to a still-pending subscriber (sent at most once).';
comment on column public.subscribers.bounced_at is
  'When this email was confirmed bounced (from Gmail bounce-scan) and status was set to bounced.';
comment on column public.subscribers.archived_at is
  'When a stale never-confirmed subscriber was archived (kept for future re-engagement, excluded from active sends).';
