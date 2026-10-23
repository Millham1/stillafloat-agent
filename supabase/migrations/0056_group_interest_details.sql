-- 0056: after "Count me in" the guest can finish the booking details themselves (Mark 2026-10-23: "I want to give them the ability to just complete the forms
-- rather than have me call them, so it becomes a choice giving them some control. I would need a page for them to complete the missing information. Auto fill
-- what we have, then ask for DOB, have them run through the room concierge questions.").
--
-- A reply from the group page (public.group_interests) now carries its own private link to a "Your details" page: names and birthdays of the people
-- coming, the four Room Concierge questions, our cabin pick for them and a "Hold my cabin" button. Everything the guest fills in is stored on the reply
-- until Mark moves it into the group file himself (dashboard: "Add travelers to a cabin"); nothing here touches group_travelers or a cabin's status.
--
-- ADDITIVE AND IDEMPOTENT: only new nullable columns and one partial unique index, every one guarded by "if not exists"; no row changes, no default,
-- no rewrite. The code that uses them needs this applied FIRST (an insert that names a missing column fails): apply it to dev and prod before the
-- branch that reads it is deployed.
--
-- The link is a credential, exactly like a traveler's paperwork link: a random 43-character token goes in the email, and only its sha256 is stored here.
alter table public.group_interests
  add column if not exists details_token_hash text,
  add column if not exists details_token_issued_at timestamptz,
  add column if not exists choice text,
  add column if not exists choice_at timestamptz,
  add column if not exists travelers jsonb,
  add column if not exists concierge jsonb,
  add column if not exists pick jsonb,
  add column if not exists hold_requested_at timestamptz,
  add column if not exists ack_email_status text,
  add column if not exists ack_email_at timestamptz;

-- "unique" on the hash, as the paperwork links are: one link finds one reply. Partial, so the many replies with no link yet (every reply before this
-- migration) are not all "the same null". (A column-level UNIQUE would do the same; this form is safe to run twice.)
create unique index if not exists group_interests_details_token_idx
  on public.group_interests (details_token_hash) where details_token_hash is not null;

-- "choice" is either of the two ways the guest took after Count me in, or nothing yet. Added only when it is not there, so running this twice is harmless.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'group_interests_choice_check' and conrelid = 'public.group_interests'::regclass) then
    alter table public.group_interests add constraint group_interests_choice_check check (choice is null or choice in ('finish', 'call'));
  end if;
end $$;

comment on column public.group_interests.details_token_hash is 'sha256 of the private link token for this reply''s "Your details" page (/details.html?t=<token>). The token itself is never stored and never returned by any API except to the person who just submitted the reply. Unique.';
comment on column public.group_interests.details_token_issued_at is 'When the link above was made. The link stops working 90 days after this.';
comment on column public.group_interests.choice is 'What the guest chose after Count me in: finish = they took the "I''ll finish it now" road (set when they ask us to hold their cabin); call = "Mark, call me". Empty until they choose.';
comment on column public.group_interests.choice_at is 'When the guest made that choice.';
comment on column public.group_interests.travelers is 'The people coming, as the guest typed them on the details page: a list of {legal_name, dob} (dob as yyyy-mm-dd). Kept here until Mark adds them to a cabin in the group file.';
comment on column public.group_interests.concierge is 'The guest''s four Room Concierge answers: {room, priority, budget, motion}. room = inside|oceanview|balcony|suite, priority = ocean|quiet|action|space, budget = lean|middle|treat|sky, motion = yes|no (seasick).';
comment on column public.group_interests.pick is 'Our cabin pick for the guest, worked out from the answers above and the group''s cabin categories: {category, where, why}. Shown to the guest and to Mark.';
comment on column public.group_interests.hold_requested_at is 'When the guest pressed "Hold my cabin". Nothing is booked or charged by this: it is a request Mark confirms with the cruise line himself.';
comment on column public.group_interests.ack_email_status is 'What happened to the acknowledgement email sent after Count me in: sent, failed, held (this box only emails its test addresses), or no-email (the guest gave only a phone number).';
comment on column public.group_interests.ack_email_at is 'When the acknowledgement email was handed to the mail sender (empty when it was not sent).';
