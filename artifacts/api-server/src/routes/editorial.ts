import { Router, type IRouter, type Request, type Response } from "express";
import { PATHS, readJson, writeJson } from "../lib/persistence";
import { buildPublishingBundle } from "../lib/publishing-output";
import { normalizeStory, normalizeStories, validatePublishingStory } from "../lib/story-normalizer";
import { runEditorialAgent } from "../lib/editorial-agent";
import { renderEditorialDigest, sendEditorialDigest } from "../lib/email-delivery";

const router: IRouter = Router();

const VALID_ACTIONS = new Set(["approve", "reject", "pin", "defer", "hold", "feature"]);

// ─── Server-side story filter ─────────────────────────────────────────────────
// Safety net that removes bad stories even if the agent misbehaves.

const CRUISE_KEYWORDS = /\b(cruise|ship|vessel|sailing|itinerary|port|embark|disembark|carnival|royal caribbean|norwegian|celebrity|princess|msc|holland america|viking|disney cruise|cunard|azamara|silversea|regent|oceania|seabourn)\b/i;

const WEATHER_NOISE = /\b(heatwave|heat wave|temperatures|celsius|fahrenheit|monsoon|rainfall|drought|wildfire|earthquake|flood(?!ing.*cruise)|tornado)\b/i;

function serverSideFilter(stories: Record<string, unknown>[]): Record<string, unknown>[] {
  // 1. Drop stories with no tier assigned
  const tiered = stories.filter((s) => {
    const tier = Number(s.tier);
    return tier >= 1 && tier <= 4;
  });

  // 2. Drop weather/natural disaster stories with no cruise connection
  const relevant = tiered.filter((s) => {
    const text = `${s.title || ""} ${s.summary || ""} ${s.travelerImpact || ""}`.toLowerCase();
    const isWeatherNoise = WEATHER_NOISE.test(text);
    const hasCruiseLink = CRUISE_KEYWORDS.test(text);
    if (isWeatherNoise && !hasCruiseLink) return false;
    return true;
  });

  // 3. Deduplicate by topic entity — keep highest-tier story when same key term appears 3+ times
  const termCount: Record<string, number> = {};
  const DEDUP_TERMS = [
    /\bhantavirus\b/i, /\bnorovirus\b/i, /\bcovid\b/i, /\bmpox\b/i,
  ];
  const deduped: Record<string, unknown>[] = [];
  for (const story of relevant) {
    const text = `${story.title || ""} ${story.summary || ""}`;
    let flagged = false;
    for (const re of DEDUP_TERMS) {
      if (re.test(text)) {
        const key = re.toString();
        termCount[key] = (termCount[key] || 0) + 1;
        if (termCount[key] > 1) { flagged = true; break; }
      }
    }
    if (!flagged) deduped.push(story);
  }

  return deduped;
}

function authorize(req: Request): boolean {
  const expected = process.env["AGENT_APPROVAL_TOKEN"];
  if (!expected) return true;
  const supplied = String(req.query.token || req.headers["x-agent-token"] || "");
  return supplied === expected;
}

// Resolve action from either full name (?action=approve|reject|hold|feature|pin|defer)
// or compact routing (?c=a → approve, ?c=h → hold, ?c=f → feature)
function resolveAction(req: Request): string | null {
  const compact = String(req.query.c || "").toLowerCase().trim();
  if (compact) {
    const COMPACT_MAP: Record<string, string> = { a: "approve", h: "hold", f: "feature" };
    return COMPACT_MAP[compact] ?? null;
  }
  const full = String(req.query.action || "").toLowerCase().trim();
  return full || null;
}

// Normalize user-facing action names to internal canonical names
function canonicalAction(action: string): string {
  if (action === "hold") return "defer";
  if (action === "feature") return "pin";
  return action;
}

router.get("/editorial-queue", async (req: Request, res: Response) => {
  try {
    const candidates = await readJson<{
      generatedAt?: string;
      systemStatus?: { degraded?: boolean };
      stories?: Record<string, unknown>[];
    }>(PATHS.candidates, { generatedAt: undefined, stories: [] });

    const queue = (candidates.stories || []).map((story) => ({
      id: story.id,
      title: story.title,
      tier: story.tier ?? null,
      category: story.category,
      impactLevel: story.impactLevel,
      travelerImpact: story.travelerImpact,
      summary: (story.summary as string) || (story.synopsis as string),
      reasoning: story.reasoning,
      image: story.image,
      link: story.link,
      sourceLinks: story.sourceLinks || [],
      featured: Boolean(story.featured || story.pinned),
      homepageCandidate: Boolean(story.homepageCandidate),
    }));

    res.json({
      success: true,
      generatedAt: candidates.generatedAt || null,
      degradedMode: Boolean(candidates.systemStatus?.degraded),
      count: queue.length,
      stories: queue,
    });
  } catch (error) {
    req.log.error({ err: error }, "Editorial queue failure");
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get("/agent-action", async (req: Request, res: Response): Promise<void> => {
  try {
    if (!authorize(req)) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }

    const rawAction = resolveAction(req);
    const id = String(req.query.id || "").trim();

    if (!rawAction || !VALID_ACTIONS.has(rawAction)) {
      res.status(400).json({ success: false, error: "Invalid editorial action" });
      return;
    }

    const action = canonicalAction(rawAction);

    if (!id) {
      res.status(400).json({ success: false, error: "Missing story id" });
      return;
    }

    const [candidates, approved, archive] = await Promise.all([
      readJson<{
        stories?: Record<string, unknown>[];
        rejectedStories?: Record<string, unknown>[];
        deferredStories?: Record<string, unknown>[];
      }>(PATHS.candidates, { stories: [], rejectedStories: [], deferredStories: [] }),
      readJson<{ stories?: Record<string, unknown>[] }>(PATHS.approved, { stories: [] }),
      readJson<{ stories?: Record<string, unknown>[] }>(PATHS.archive, { stories: [] }),
    ]);

    const story = (candidates.stories || []).find((item) => item.id === id);

    if (!story) {
      const alreadyApproved = (approved.stories || []).some((item) => item.id === id);
      if (alreadyApproved) {
        res.status(200).json({ success: true, message: "Story was already approved" });
        return;
      }
      res.status(404).json({ success: false, error: "Story not found or already processed" });
      return;
    }

    const normalizedStory = normalizeStory(story);
    const validationErrors = validatePublishingStory(normalizedStory);

    if (action !== "reject" && validationErrors.length) {
      res.status(422).json({ success: false, error: "Story failed publishing validation", validationErrors });
      return;
    }

    if (action === "reject") {
      await writeJson(PATHS.candidates, {
        ...candidates,
        stories: (candidates.stories || []).filter((item) => item.id !== id),
        rejectedStories: [
          ...(candidates.rejectedStories || []),
          {
            ...normalizedStory,
            status: "rejected",
            rejectedAt: new Date().toISOString(),
            rejectionReason: "Manual editorial rejection",
          },
        ],
      });
      res.status(200).json({ success: true, message: "Story rejected successfully" });
      return;
    }

    if (action === "defer") {
      await writeJson(PATHS.candidates, {
        ...candidates,
        stories: (candidates.stories || []).map((item) =>
          item.id === id ? { ...item, status: "deferred", deferredAt: new Date().toISOString() } : item
        ),
        deferredStories: [
          ...(candidates.deferredStories || []),
          { ...normalizedStory, status: "deferred", deferredAt: new Date().toISOString() },
        ],
      });
      res.status(200).json({ success: true, message: "Story deferred successfully" });
      return;
    }

    const approvedStory = {
      ...normalizedStory,
      status: "approved",
      approvedAt: new Date().toISOString(),
      featured: action === "pin" ? true : Boolean(normalizedStory.featured || normalizedStory.homepageCandidate),
      pinned: action === "pin",
    };

    const approvedStories = [
      approvedStory,
      ...(approved.stories || []).filter((item) => item.id !== id),
    ].slice(0, 20);

    const publishing = buildPublishingBundle({
      approvedStories,
      homepageTop5: approvedStories.slice(0, 5),
    });

    await Promise.all([
      writeJson(PATHS.approved, { generatedAt: new Date().toISOString(), stories: approvedStories }),
      writeJson(PATHS.candidates, {
        ...candidates,
        stories: (candidates.stories || []).filter((item) => item.id !== id),
      }),
      writeJson(PATHS.archive, {
        generatedAt: new Date().toISOString(),
        stories: [approvedStory, ...(archive.stories || [])].slice(0, 500),
      }),
      writeJson(PATHS.homepage, publishing.homepage),
      writeJson(PATHS.newsIndex, publishing.newsIndex),
      writeJson(PATHS.storyDetails, publishing.storyDetails),
    ]);

    res.status(200).json({
      success: true,
      message: `Story ${action === "pin" ? "pinned and approved" : "approved"} successfully`,
    });
  } catch (error) {
    req.log.error({ err: error }, "Agent action failure");
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post("/scan-news", async (req: Request, res: Response) => {
  if (!authorize(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  const telemetry: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    ingestionCompleted: false,
    normalizationCompleted: false,
    aiCompleted: false,
    persistenceCompleted: false,
    emailCompleted: false,
    degradedMode: false,
    errors: [],
  };

  try {
    const curated = await runEditorialAgent({
      openai: process.env["OPENAI_API_KEY"] || process.env["REPLIT_OPENAI_API_KEY"],
    });
    telemetry.ingestionCompleted = true;
    telemetry.aiCompleted = true;
    telemetry.degradedMode = Boolean(curated?.systemStatus?.degraded);

    const normalized = normalizeStories(curated.stories || []);
    const curatedStories = serverSideFilter(normalized);
    telemetry.curatedStoryCount = curatedStories.length;
    telemetry.filteredCount = normalized.length - curatedStories.length;

    await writeJson(PATHS.candidates, {
      generatedAt: new Date().toISOString(),
      systemStatus: curated.systemStatus || null,
      stories: curatedStories,
      homepageTop5: (curated.homepageTop5 || []).slice(0, 5),
      groupedDevelopments: curated.groupedDevelopments || [],
      telemetry,
    });
    telemetry.persistenceCompleted = true;

    const dashboardUrl = process.env["DASHBOARD_URL"] ||
      (process.env["REPLIT_DEV_DOMAIN"] ? `https://${process.env["REPLIT_DEV_DOMAIN"]}` : "");
    const html = renderEditorialDigest({
      stories: curatedStories,
      dashboardUrl,
      approvalToken: process.env["AGENT_APPROVAL_TOKEN"] || "",
    });
    const emailResult = await sendEditorialDigest({
      subject: telemetry.degradedMode
        ? "Still Afloat AI Digest (Degraded Mode)"
        : "Still Afloat AI Editorial Digest",
      html,
    });
    telemetry.emailCompleted = Boolean(emailResult?.success);

    res.json({
      success: true,
      curatedStories: curatedStories.length,
      degradedMode: telemetry.degradedMode,
      telemetry,
      emailResult: emailResult ? { success: emailResult.success, provider: emailResult.provider } : null,
    });
  } catch (error) {
    req.log.error({ err: error }, "Scan pipeline failure");
    (telemetry.errors as unknown[]).push({
      message: (error as Error).message,
      timestamp: new Date().toISOString(),
    });
    res.status(500).json({ success: false, error: (error as Error).message, telemetry });
  }
});

export default router;
