-- Mark 2026-11-05: the price on the guest's page is the starting price. "Send my choices to Mark!" is not an agreement to it: Mark re-quotes the
-- choices in the cruise line's system, uploads that quote (it fills the booking confirmation), checks the paperwork and sends it. The guest commits
-- by signing the paperwork. So the moment the choices were sent gets its own column; quote_agreed_at (0065) is kept as history and no longer written.
alter table public.group_interests
  add column if not exists quote_requested_at timestamptz;
update public.group_interests set quote_requested_at = quote_agreed_at where quote_agreed_at is not null and quote_requested_at is null;
-- The signed documents are back (stored by the signing itself) and Mark has confirmed the booking with the cruise line and the vendors.
alter table public.group_interests
  add column if not exists booking_completed_at timestamptz;
comment on column public.group_interests.quote_requested_at is 'When the guest sent their choices to Mark (the starting price is not agreed to; the signed paperwork is the commitment).';
comment on column public.group_interests.booking_completed_at is 'When Mark confirmed the booking with the cruise line and the vendors, after the signed documents came back.';
