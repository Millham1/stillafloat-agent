-- 0022 — which deck plans have actually been read.
--
-- Mark, 2026-08-17: "i want every ship every deck done ... I am not publishing a
-- half-assed half done version again like we did this weekend when i relied on
-- your word that it was 100%."
--
-- So coverage stops being something anyone claims and becomes something the
-- database states. One row per class rep per deck that holds cabins. A deck is
-- 'read' only once its plan has been through the pipeline and its rooms written;
-- 'needs-source' records a deck we cannot do yet AND why, in the notes, so a
-- gap is never mistaken for a completed read.
--
-- Only class reps appear here. Sister ships inherit their rep's grid, so reading
-- Norwegian Escape's twelve decks covers four ships — ships_covered records how
-- many, which is what makes a coverage number meaningful.

create table if not exists public.deck_read_log (
  rep_slug      text not null,
  deck          integer not null,
  ships_covered integer,
  source        text,
  source_ok     boolean default true,
  status        text not null default 'todo',   -- todo | read | needs-source
  lifts_found   integer,
  rooms_flagged integer,
  read_at       timestamptz,
  notes         text,
  primary key (rep_slug, deck)
);

comment on table public.deck_read_log is
  'Deck-plan reading coverage, one row per class rep per cabin-carrying deck. The honest answer to "how much of the fleet is done" — never a claim, always a count.';
comment on column public.deck_read_log.status is
  'todo = not read yet; read = plan read and rooms written; needs-source = cannot be read with what we hold, with the blocker in notes.';
comment on column public.deck_read_log.ships_covered is
  'How many in-fleet ships inherit this rep''s grid, so coverage can be counted in ships as well as decks.';
