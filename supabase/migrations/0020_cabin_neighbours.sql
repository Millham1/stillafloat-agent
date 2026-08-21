-- 0020 — what is directly above and below each room, per room.
--
-- Mark's architecture, 2026-08-18: the room DB carries the facts ("noise issues
-- above, below and a 40 ft radius around the room") and the advisor consumes
-- them. Until now the only above/below knowledge was AREA-level — a researched
-- zone saying "decks 8-10, forward, port" — inherited by every room in the
-- block. Two rooms in the same block can have a quiet cabin above one and the
-- buffet above the other; the zone cannot tell them apart.
--
-- THE DERIVATION, from cabins.pos_along (migration 0019) alone:
-- for a room on deck D at position A, look at the deck immediately above.
--   * another cabin sits at A          → 'cabins'  — the quiet case
--   * that deck is in our grid but has
--     NO cabin at A                    → 'open'    — at that spot the deck above
--                                        is something else: pool, buffet, galley,
--                                        theatre, lounge. This is the noise signal.
--   * that deck is not in our grid      → 'unknown' — say nothing
--
-- 'unknown' is deliberately NOT read as 'open'. A deck missing from the grid may
-- be a genuinely public deck OR just one we never extracted, and guessing would
-- manufacture noise warnings for rooms that have a quiet neighbour above them.
-- Same rule downward, where the classic offender is a galley or crew alleyway.
--
-- These are DERIVED. Recompute whenever pos_along changes. They describe our
-- data's structure, not the operator's word, so nothing here is ever spoken as
-- a claim about the line — Mark's 8/16 rule still governs the wording.

alter table public.cabins
  add column if not exists above_kind text,
  add column if not exists below_kind text;

comment on column public.cabins.above_kind is
  'What sits on the next deck up at this room''s pos_along: cabins | open | unknown. "open" means that deck carries no cabin at this spot, so it is public space — the per-room noise signal. "unknown" means we hold no grid for that deck and must stay quiet.';
comment on column public.cabins.below_kind is
  'As above_kind, for the next deck down. "open" below is typically a galley, crew alleyway or lounge.';
