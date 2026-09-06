// seo-executor.ts — the approve→IMPLEMENT half of the SEO proposal loop.
//
// The ops-manager's weekly GSC review files title/meta rewrite proposals as
// status='proposed' tasks carrying a machine-actionable `payload`
// (see supabase/migrations/0011_task_payload.sql):
//
//   { "type": "seo-override",
//     "storyId"?: "<story id>",            // direct key into seo-overrides, OR
//     "page"?: "https://…/news/<slug>.html", // resolved to a story id here
//     "title"?: "…", "metaDescription"?: "…",
//     "title_es"?: "…", "metaDescription_es"?: "…" }
//
// When Mark approves such a proposal (routes/proposals.ts), applySeoOverride()
// merges the change into the per-story `seo-overrides` platform_state entry —
// the exact map runNewsPrerender() already consumes — and returns an old→new
// audit line. The hourly prerender tick republishes the pages; we also kick one
// immediately so the change is live within seconds, not an hour.
//
// The ops-manager sends the PAGE URL (that's what GSC reports); slug→story
// resolution happens here because storySlug() is canonical in this repo (it has
// a byte-for-byte twin in public/js/news.js — a third copy in Python would be a
// drift hazard). storyId is accepted too for anything that already knows it.

import {
  storySlug,
  archivedToNewsStory,
  type NewsStory,
  type SeoOverride,
  type SeoOverrideMap,
} from "./prerender-news";
import { PATHS, readJson, writeJson } from "./persistence";
import { logger } from "./logger";

export interface SeoOverridePayload {
  type: "seo-override";
  storyId?: string;
  page?: string;
  title?: string;
  metaDescription?: string;
  title_es?: string;
  metaDescription_es?: string;
}

export function isSeoOverridePayload(p: unknown): p is SeoOverridePayload {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  if (o["type"] !== "seo-override") return false;
  const hasTarget =
    (typeof o["storyId"] === "string" && o["storyId"].trim() !== "") ||
    (typeof o["page"] === "string" && o["page"].trim() !== "");
  const hasChange = ["title", "metaDescription", "title_es", "metaDescription_es"].some(
    (k) => typeof o[k] === "string" && (o[k] as string).trim() !== "",
  );
  return hasTarget && hasChange;
}

/** Pull the trailing `<slug>` out of a /news/<slug>.html (or /es/news/…) URL or path. */
function slugFromPage(page: string): string | null {
  const m = /\/news\/([a-z0-9-]+)\.html?(?:[?#].*)?$/i.exec(page.trim());
  return m?.[1]?.toLowerCase() ?? null;
}

async function loadStories(): Promise<NewsStory[]> {
  const live = await readJson<{ stories?: NewsStory[] }>(PATHS.storyDetails, { stories: [] });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const archived = await readJson<{ stories?: Record<string, any>[] }>(PATHS.archive, {
    stories: [],
  });
  return [...(live.stories ?? []), ...(archived.stories ?? []).map(archivedToNewsStory)].filter(
    (s) => s && s.id && s.title,
  );
}

/** Resolve the payload's target to a concrete story (by id, or by page slug). */
async function resolveStory(payload: SeoOverridePayload): Promise<NewsStory | null> {
  const stories = await loadStories();
  if (payload.storyId) {
    const hit = stories.find((s) => s.id === payload.storyId);
    if (hit) return hit;
  }
  if (payload.page) {
    const slug = slugFromPage(payload.page);
    if (slug) {
      const hit = stories.find((s) => storySlug(s) === slug);
      if (hit) return hit;
    }
  }
  return null;
}

// Mirrors metaDescription() in prerender-news (not exported there) closely
// enough for an honest "old value" in the audit note.
function baseDesc(story: NewsStory): string {
  const raw = (story.travelerImpact || story.summary || "").replace(/\s+/g, " ").trim();
  return raw.length > 158 ? `${raw.slice(0, 155)}…` : raw;
}

export interface ApplyResult {
  applied: boolean;
  reason?: string; // when applied=false: why (→ proposal falls back to a plain task)
  storyId?: string;
  auditNote?: string; // "what changed, old→new" — appended to the task detail
}

/**
 * Apply a seo-override payload: merge into the `seo-overrides` platform_state
 * map in the exact SeoOverride shape the prerenderer consumes. Returns an
 * old→new audit note. Never throws for "target not found" — that comes back as
 * {applied:false, reason} so the caller can fall back to promote-to-task.
 */
/**
 * A proposal aimed at a Spanish page (/es/news/…) that carries its copy under the
 * English keys must land on the ES fields — otherwise the Spanish title would be
 * written over the English page (seen 2026-09-06 on the ES typhoon proposal, whose
 * `title` was "Tifón Bavi Obliga a Royal Caribbean…"). Explicit *_es keys win.
 */
export function normalizeForPageLanguage(payload: SeoOverridePayload): SeoOverridePayload {
  const isEs = /\/es\/news\//i.test(payload.page ?? "");
  if (!isEs) return payload;
  const out: SeoOverridePayload = { ...payload };
  if (!out.title_es?.trim() && out.title?.trim()) out.title_es = out.title;
  if (!out.metaDescription_es?.trim() && out.metaDescription?.trim()) out.metaDescription_es = out.metaDescription;
  delete out.title;
  delete out.metaDescription;
  return out;
}

export async function applySeoOverride(rawPayload: SeoOverridePayload): Promise<ApplyResult> {
  const payload = normalizeForPageLanguage(rawPayload);
  const story = await resolveStory(payload);
  if (!story || !story.id) {
    return {
      applied: false,
      reason: `story not found for ${payload.storyId ?? payload.page ?? "(no target)"}`,
    };
  }

  const overrides = await readJson<SeoOverrideMap>(PATHS.seoOverrides, {});
  const existing: SeoOverride = overrides[story.id] ?? {};
  const next: SeoOverride = { ...existing };

  const changes: string[] = [];
  const set = (
    field: "title" | "desc" | "title_es" | "desc_es",
    value: string | undefined,
    oldEffective: string,
    label: string,
  ): void => {
    const v = (value ?? "").trim();
    if (!v || v === oldEffective) return;
    next[field] = v;
    changes.push(`${label}: "${oldEffective || "(none)"}" → "${v}"`);
  };

  set("title", payload.title, existing.title ?? story.title ?? "", "title");
  set("desc", payload.metaDescription, existing.desc ?? baseDesc(story), "meta description");
  set("title_es", payload.title_es, existing.title_es ?? story.title_es ?? "", "ES title");
  set(
    "desc_es",
    payload.metaDescription_es,
    existing.desc_es ?? "",
    "ES meta description",
  );

  if (changes.length === 0) {
    return { applied: false, reason: "no effective change (already matches)", storyId: story.id };
  }

  // Freshness signal: the prerender emits this as JSON-LD dateModified and
  // sitemap <lastmod>. Without it a copy rewrite was invisible to crawlers.
  next.updatedAt = new Date().toISOString();
  overrides[story.id] = next;
  await writeJson(PATHS.seoOverrides, overrides);
  logger.info({ storyId: story.id, changes }, "SEO override applied from approved proposal");

  return {
    applied: true,
    storyId: story.id,
    auditNote: `Applied SEO override to story ${story.id} (/news/${storySlug(story)}.html): ${changes.join("; ")}`,
  };
}
