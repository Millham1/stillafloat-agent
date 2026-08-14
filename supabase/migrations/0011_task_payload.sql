-- 0011_task_payload.sql — machine-actionable proposal payloads.
--
-- The SEO cockpit's approve→implement path: when the ops-manager's weekly GSC
-- review proposes a title/meta rewrite it now attaches a machine-actionable
-- payload to the proposal task, e.g.
--   {"type":"seo-override","page":"https://…/news/<slug>.html",
--    "title":"…","metaDescription":"…"}
-- Approving such a proposal (routes/proposals.ts) APPLIES the change (writes the
-- per-story `seo-overrides` platform_state entry) and closes the task with an
-- audit note, instead of just promoting it to 'open'. Proposals without a
-- payload keep the promote-to-task behavior, so this column is nullable and
-- nothing existing changes shape.

ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS payload jsonb;

COMMENT ON COLUMN public.tasks.payload IS
  'Optional machine-actionable change carried by a proposal (status=proposed). '
  'Currently: {"type":"seo-override", storyId|page, title?, metaDescription?, '
  'title_es?, metaDescription_es?} — applied automatically on approval.';
