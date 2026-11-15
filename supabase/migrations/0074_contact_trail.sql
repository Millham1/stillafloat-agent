-- Mark 2026-11-14: "I'd like to save the email log, even if the client is deleted, I'd like to log emails recorded in my gmail as well. any time we
-- have an interaction with someone there should be a 'paper trail,' so the contact record should stay in the DB for retrieval if necessary. It can be
-- in a separate archive if that makes more sense."
--
-- contact_trail is that archive: one row per interaction with a person, keyed by their email address, and tied to NOTHING that can be deleted.
-- group_messages (the group email log) is removed with its group (on delete cascade) and loses its traveler when a guest is deleted; this table
-- keeps its own copy of the address, the name, the group's name and the words, so the trail outlives the guest and the group.
--   kind 'site-email'  an email the site sent the person (copied here by the trigger below the moment it is sent, failed or held)
--   kind 'gmail'       a message to or from the person in Mark's mailbox (read by the ops-manager, POST /mail/trail: who, when, subject, preview)
--   kind 'event'       something that happened to their record (removed from a group, a group deleted), written by the site
-- source_id makes each interaction land once: 'msg:<group_messages.id>', 'gmail:<gmail message id>', 'event:<...>'.
create table if not exists public.contact_trail (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text,
  kind text not null check (kind in ('site-email', 'gmail', 'event')),
  direction text not null default 'out' check (direction in ('out', 'in', 'note')),
  subject text,
  snippet text,
  body_html text,
  status text,
  at timestamptz not null,
  group_id uuid,
  group_name text,
  source_id text not null unique,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists contact_trail_by_email on public.contact_trail (email, at desc);
create index if not exists contact_trail_by_time on public.contact_trail (at desc);
alter table public.contact_trail enable row level security;
comment on table public.contact_trail is 'Paper trail: every interaction with a person (site emails, mailbox messages, record events), kept when the guest or the group is deleted. Service role only.';
comment on column public.contact_trail.group_id is 'The group it happened in, as a plain value: NOT a foreign key, so deleting the group keeps the row.';

-- Every client email the site logs lands in the trail by itself, whichever code path sent it.
create or replace function public.contact_trail_from_group_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text; grp text;
begin
  if new.audience <> 'client' or new.to_email is null or btrim(new.to_email) = '' or new.status not in ('sent', 'failed', 'skipped') then
    return new;
  end if;
  select nullif(btrim(concat_ws(' ', t.first_name, t.last_name)), '') into who from public.group_travelers t where t.id = new.traveler_id;
  select g.name into grp from public.groups g where g.id = new.group_id;
  insert into public.contact_trail (email, name, kind, direction, subject, body_html, status, at, group_id, group_name, source_id, meta)
  values (lower(btrim(new.to_email)), who, 'site-email', 'out', new.subject, new.body_html, new.status, coalesce(new.sent_at, new.updated_at, now()),
          new.group_id, grp, 'msg:' || new.id::text, jsonb_build_object('template', new.template))
  on conflict (source_id) do update set status = excluded.status, subject = excluded.subject, body_html = excluded.body_html, at = excluded.at,
          name = coalesce(excluded.name, public.contact_trail.name), group_name = coalesce(excluded.group_name, public.contact_trail.group_name);
  return new;
end $$;
drop trigger if exists contact_trail_from_group_message on public.group_messages;
create trigger contact_trail_from_group_message after insert or update of status, sent_at, subject, body_html, to_email on public.group_messages
  for each row execute function public.contact_trail_from_group_message();
revoke all on function public.contact_trail_from_group_message() from public, anon, authenticated;

-- What is in the log today.
insert into public.contact_trail (email, name, kind, direction, subject, body_html, status, at, group_id, group_name, source_id, meta)
select lower(btrim(m.to_email)), nullif(btrim(concat_ws(' ', t.first_name, t.last_name)), ''), 'site-email', 'out', m.subject, m.body_html, m.status,
       coalesce(m.sent_at, m.updated_at, m.created_at), m.group_id, g.name, 'msg:' || m.id::text, jsonb_build_object('template', m.template)
from public.group_messages m
left join public.group_travelers t on t.id = m.traveler_id
left join public.groups g on g.id = m.group_id
where m.audience = 'client' and m.to_email is not null and btrim(m.to_email) <> '' and m.status in ('sent', 'failed', 'skipped')
on conflict (source_id) do nothing;
