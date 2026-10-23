-- 0055: a reply from the group page needs ONE way to reach the person, not necessarily an email (Mark 2026-10-23, design v2 of the group page).
-- The Count me in form has one box, "Email or phone": the server accepts a valid email OR a phone with at least seven digits. A phone-only reply
-- has no email, so group_interests.email stops being NOT NULL (0045 created it NOT NULL). Additive and idempotent: dropping NOT NULL on a column
-- that is already nullable does nothing, and no row changes. Existing replies all keep their email.
-- (public.prospects.email stays NOT NULL on purpose: the server does not add a phone-only reply to the contact list, so nothing is invented for it.)
alter table public.group_interests alter column email drop not null;

comment on column public.group_interests.email is 'The email the person gave, lower case; null when they gave only a phone number (the form asks for an email OR a phone).';
