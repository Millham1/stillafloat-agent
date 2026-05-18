import { Router, type IRouter, type Request, type Response } from "express";
import { PATHS, readJson, writeJson } from "../lib/persistence";
import { buildPublishingBundle } from "../lib/publishing-output";
import { normalizeStory, normalizeStories, validatePublishingStory } from "../lib/story-normalizer";
import { buildCandidateFeed } from "../lib/live-sources";
import { runEditorialAgent } from "../lib/editorial-agent";
import { renderEditorialDigest, sendEditorialDigest } from "../lib/email-delivery";

const router: IRouter = Router();

const VALID_ACTIONS = new Set(["approve", "reject", "pin", "defer", "hold", "feature"]);

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
    const rawStories = await buildCandidateFeed();
    telemetry.ingestionCompleted = true;
    telemetry.rawStoryCount = rawStories.length;

    const normalizedStories = normalizeStories(rawStories);
    telemetry.normalizationCompleted = true;
    telemetry.normalizedStoryCount = normalizedStories.length;

    const curated = await runEditorialAgent({
      stories: normalizedStories,
      openai: process.env["OPENAI_API_KEY"],
    });
    telemetry.aiCompleted = true;
    telemetry.degradedMode = Boolean(curated?.systemStatus?.degraded);

    const curatedStories = normalizeStories(curated.stories || []);

    await writeJson(PATHS.candidates, {
      generatedAt: new Date().toISOString(),
      systemStatus: curated.systemStatus || null,
      stories: curatedStories,
      homepageTop5: normalizeStories(curated.homepageTop5 || []).slice(0, 5),
      groupedDevelopments: curated.groupedDevelopments || [],
      rejectedStories: normalizeStories(curated.rejectedStories || []),
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
      scannedStories: normalizedStories.length,
      curatedStories: curatedStories.length,
      degradedMode: telemetry.degradedMode,
      telemetry,
      emailResult,
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
