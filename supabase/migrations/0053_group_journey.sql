-- 0053: the group JOURNEY — everything after the paperwork (Mark 2026-10-16: "simulate the entire process from
-- entering a group to building the marketing and a customer CTA, adding info and the confirmation process, then the
-- follow-up emails for 120, 90, 45, 20, 10, 5 and 2 days before, checklists, follow-up data needed, change
-- notifications, ship info, weather (5 day prior report), embarkation what to know ... the whole package top to bottom").
--
--   * groups.journey: Mark's decisions about the emails on this group. Templates are approved ONCE (Mark 2026-10-02):
--     {"approved": {"t-120": {"approved": true, "at": "...", "version": "..."}}, "videoSources": ["own"], "notified": {...}}.
--     A group with no entry for a milestone inherits the site-wide default kept in platform_state ("group-journey-defaults").
--   * group_travelers.hub_token_hash: the traveler's private cruise-page link (/my-cruise.html?t=<token>). The token is
--     derived (HMAC) from the traveler's id, so every email can carry it without the link ever being stored; only its
--     sha256 is kept, to find the traveler, exactly as form_token_hash does for the paperwork link. The paperwork page
--     accepts either link.
--   * group_messages.meta: what a message was about beyond the email itself (a change notice's text and its changed
--     fields; the milestone a nudge followed; send attempts). Nothing secret goes in it.

alter table public.groups
  add column if not exists journey jsonb not null default '{}'::jsonb;

alter table public.group_travelers
  add column if not exists hub_token_hash text;

create unique index if not exists group_travelers_hub_token_idx
  on public.group_travelers (hub_token_hash) where hub_token_hash is not null;

alter table public.group_messages
  add column if not exists meta jsonb not null default '{}'::jsonb;

comment on column public.groups.journey is 'Approved journey email templates and per-group journey settings. Service role only.';
comment on column public.group_travelers.hub_token_hash is 'sha256 of the traveler''s cruise-page link token (derived, never stored). Never returned by any API.';
comment on column public.group_messages.meta is 'Context for a message (change-notice text and fields, attempts). No secrets.';
