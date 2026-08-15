-- 0013: rename the "Grinch" voice to "Salty Grump" (Mark, 2026-08-14).
-- The always-present dry/skeptical aside on every Conga Line rating keeps its
-- exact mechanics (see 0012) — only the name changes, everywhere it surfaces.
alter table conga_line_ratings rename column grinch_take to salty_grump_take;
