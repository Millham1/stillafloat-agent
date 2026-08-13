-- 0012_conga_line_ratings.sql
-- "Conga Line" ship rating — a crowd-sourced 1-5 "audience score" for the Room
-- Engine (cabin concierge), built by a human manually reading the PUBLIC review
-- pages on Cruiseline.com and CruiseCritic (both sites' ToS bar automated bot
-- access — a person reading and typing what they see is fine; Tripadvisor is
-- deliberately excluded, Mark doesn't trust it as a source) and blending them
-- into one score. Quarterly refresh cadence, human-checked, never live/automated.
--
-- Design (finalized with Mark, 2026-08-13):
--   • Scale is 1-5 ONLY, never negative or zero. Mark works under a host agency
--     and does not want a real ship ever carrying an official worst-possible
--     verdict — that would sour supplier relationships. The crowd score is
--     always in the positive band; honesty about a weak ship lives in the
--     separate grinch_take field below, not in the number.
--   • The Grinch mechanic (Rotten-Tomatoes critics-vs-audience split): a SEPARATE,
--     always-present `grinch_take` column carries Mark's own dry, skeptical
--     one-liner alongside the crowd score, regardless of what that score says.
--     It is NOT a rating value and NOT on the 1-5 scale — a distinct editorial
--     voice, humor aimed at the ship's real tradeoffs, never at the traveler,
--     never actually mean (same "honest about downsides, plainly and kindly"
--     rule as the cabin voice-guide, just drier). The 6-character "Grinch to
--     Conga King/Queen" concept art Mark generated (-1 Grinch ... 5 Conga
--     King/Queen) is for a future ABOUT/EXPLAINER surface on how the rating
--     works — the Grinch character there represents this grinch_take voice,
--     not a literal -1 score.
--   • `comment` is a warm/honest PARAPHRASE of real review themes in Mark's
--     voice (cabin-advisor/voice-guide.md), never a verbatim lifted quote —
--     same copyright discipline as the newsletter/commentary pipelines.
--   • Nothing publishes without Mark's explicit approval: draft -> approved is
--     a distinct, separate action from saving a draft (comment_status /
--     status), matching the standing rule for all AI-touched content here.
--
-- RLS service-role-only on both tables (no anon policy — this is a curated,
-- human-checked dataset with an explicit publish gate, never a public write
-- path). Apply to DEV first, prod only after Mark's sign-off.

-- ── conga_line_sources ───────────────────────────────────────────────────────
-- One row per (ship, source, capture). Raw material a human read off the public
-- review page and typed in — never scraped. Kept as history: source_count on
-- the rating table is a snapshot, this table is the audit trail behind it.
CREATE TABLE IF NOT EXISTS public.conga_line_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ship_slug     text NOT NULL,
  source        text NOT NULL CHECK (source IN ('cruiseline', 'cruisecritic')),
  source_score  numeric,          -- as published on the source site, its own scale
  source_scale  numeric,          -- e.g. 5 or 10 — needed to normalize into 1-5
  review_count  integer,
  source_url    text,
  captured_at   timestamptz NOT NULL DEFAULT now(),
  captured_by   text,             -- who read the page and typed this in
  notes         text              -- free-text themes noticed while reading
);

CREATE INDEX IF NOT EXISTS conga_line_sources_ship_idx ON public.conga_line_sources (ship_slug);
CREATE INDEX IF NOT EXISTS conga_line_sources_ship_source_idx ON public.conga_line_sources (ship_slug, source);

-- ── conga_line_ratings ───────────────────────────────────────────────────────
-- One row per ship: the computed/blended, editorially-approved public-facing
-- rating. Two independent gates before anything shows on the site:
--   comment_status: draft -> approved   (has Mark signed off the WORDS)
--   status:         draft -> published  (is it actually live)
-- The public API checks BOTH; either one still 'draft' hides the ship entirely.
CREATE TABLE IF NOT EXISTS public.conga_line_ratings (
  ship_slug       text PRIMARY KEY,
  rating          numeric(2,1) CHECK (rating >= 1 AND rating <= 5),
  rating_display  text,           -- e.g. "4/5 Conga Line" — precomputed display string
  comment         text,           -- warm paraphrase of review themes, Mark's voice
  grinch_take     text,           -- the separate dry/skeptical aside — always present
  comment_status  text NOT NULL DEFAULT 'draft' CHECK (comment_status IN ('draft', 'approved')),
  source_count    integer,        -- how many conga_line_sources rows fed this
  computed_at     timestamptz,
  refresh_due_at  timestamptz,    -- quarterly cadence: when this should be re-read
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.conga_line_sources ENABLE ROW LEVEL SECURITY; -- service-role only
ALTER TABLE public.conga_line_ratings ENABLE ROW LEVEL SECURITY; -- service-role only
