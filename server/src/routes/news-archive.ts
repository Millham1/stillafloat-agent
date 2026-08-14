import { Router, type IRouter, type Request, type Response } from "express";
import { PATHS, readJson } from "../lib/persistence";
import { requireToken } from "../lib/http-auth";
import { storySlug } from "../lib/prerender-news";
import {
  type ArchiveStoryRecord,
  queryTerms,
  matchesQuery,
  inRange,
  parseFrom,
  parseTo,
  storyTime,
} from "../lib/news-archive-search";

// ── News archive browser (task 669ea94b) ─────────────────────────────────────
// Dashboard-facing search over `archive-stories`: every story ever approved,
// including the ones the newsagent's daily 21-day sweep has aged out of the
// live feed. Token-gated like the rest of the dashboard API (requireToken —
// x-affiliate-token header / Bearer / ?token=).
//
// The collection is a single jsonb payload (~500 stories max), so filtering
// happens here server-side and the dashboard only ever receives a small page
// of trimmed results — never the whole 800KB blob.

const router: IRouter = Router();

const SITE = "https://stillafloatcruising.com";

function summarize(story: ArchiveStoryRecord) {
  const slug = storySlug({ id: String(story["id"] || "") });
  return {
    id: story["id"],
    slug,
    url: `${SITE}/news/${slug}.html`,
    urlEs: `${SITE}/es/news/${slug}.html`,
    title: story["title"] || "",
    title_es: story["title_es"] || "",
    summary: story["summary"] || "",
    summary_es: story["summary_es"] || "",
    category: story["category"] || "",
    impactLevel: story["impactLevel"] || "",
    source: story["source"] || (story["sources"] || [])[0] || "",
    link: story["link"] || "",
    approvedAt: story["approvedAt"] || null,
    archivedAt: story["archivedAt"] || null,
    featured: Boolean(story["featured"] || story["pinned"]),
    // "archived" = aged out of the live feed by the 21-day sweep;
    // "live" = an approval-time archive copy of a story still in the feed.
    status: story["archivedAt"] ? "archived" : "live",
  };
}

router.get("/news-archive", requireToken, async (req: Request, res: Response) => {
  try {
    const terms = queryTerms(String(req.query["q"] || ""));
    const from = req.query["from"] ? parseFrom(String(req.query["from"])) : null;
    const to = req.query["to"] ? parseTo(String(req.query["to"])) : null;
    const limit = Math.min(Math.max(Number(req.query["limit"]) || 50, 1), 200);
    const offset = Math.max(Number(req.query["offset"]) || 0, 0);

    const data = await readJson<{ generatedAt?: string; stories?: ArchiveStoryRecord[] }>(
      PATHS.archive,
      { generatedAt: undefined, stories: [] },
    );

    const matched = (data.stories || [])
      .filter((s) => s && s["id"])
      .filter((s) => matchesQuery(s, terms) && inRange(s, from, to))
      .sort((a, b) => (storyTime(b) ?? 0) - (storyTime(a) ?? 0));

    res.json({
      success: true,
      source: "stillafloat-agent",
      generatedAt: data.generatedAt || null,
      total: matched.length,
      offset,
      limit,
      stories: matched.slice(offset, offset + limit).map(summarize),
    });
  } catch (error) {
    req.log.error({ err: error }, "News archive search failure");
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Full raw record for one archived story (detail view in the dashboard).
router.get("/news-archive/story", requireToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = String(req.query["id"] || "").trim();
    if (!id) {
      res.status(400).json({ success: false, error: "Missing story id" });
      return;
    }

    const data = await readJson<{ stories?: ArchiveStoryRecord[] }>(PATHS.archive, { stories: [] });
    const story = (data.stories || []).find((s) => String(s["id"]) === id);
    if (!story) {
      res.status(404).json({ success: false, error: "Story not found in archive" });
      return;
    }

    res.json({ success: true, ...summarize(story), story });
  } catch (error) {
    req.log.error({ err: error }, "News archive detail failure");
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

export default router;
