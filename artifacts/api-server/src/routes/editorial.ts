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

  // 3. Deduplicate known disease clusters — max 1 per topic
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

  // 4. Entity-based dedup — catch same event reported by two sources
  // Extract a fingerprint: (ship name or cruise line) + (event keyword)
  const SHIP_NAMES = /\b(carnival(?: mardi gras| dream| vista| horizon| venezia| jubilee| celebration| luminosa|[a-z]+ [a-z]+)?|royal caribbean|norwegian(?: encore| prima| bliss| escape| getaway| breakaway|[a-z]+ [a-z]+)?|celebrity(?: beyond| edge| apex| ascent|[a-z]+)?|princess|msc|holland america|viking|disney|cunard|silversea|regent)\b/i;
  // Groups of synonymous event words mapped to a canonical key
  const EVENT_GROUPS: [RegExp, string][] = [
    [/\b(rescue[d]?|saving|saved|saves|adrift|stranded at sea)\b/i, "rescue"],
    [/\b(fire|blaze|burning)\b/i, "fire"],
    [/\b(outbreak|norovirus|sick|illness)\b/i, "outbreak"],
    [/\b(delay|cancel|cancell?ed|postpone)\b/i, "delay"],
    [/\b(divert|reroute|itinerary change)\b/i, "reroute"],
    [/\b(collision|crash|accident)\b/i, "collision"],
    [/\b(sinking|sunk|sink|abandon ship)\b/i, "sinking"],
    [/\b(lawsuit|court|sued|ban|overturned)\b/i, "legal"],
    [/\b(power|blackout|dark|engine)\b/i, "power"],
  ];

  function eventFingerprint(s: Record<string, unknown>): string | null {
    const text = `${s.title || ""} ${s.summary || ""}`;
    const shipMatch = SHIP_NAMES.exec(text);
    if (!shipMatch) return null;
    const lineage = shipMatch[0].toLowerCase().split(" ")[0];
    for (const [re, canonical] of EVENT_GROUPS) {
      if (re.test(text)) return `${lineage}:${canonical}`;
    }
    return null;
  }

  const seenFingerprints = new Set<string>();
  const entityDeduped = deduped.filter((s) => {
    const fp = eventFingerprint(s);
    if (!fp) return true;
    if (seenFingerprints.has(fp)) return false;
    seenFingerprints.add(fp);
    return true;
  });

  // 5. Title-similarity dedup — catch same event with different headlines from different sources
  function titleWords(title: string): Set<string> {
    return new Set(
      title.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 3)
    );
  }
  function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    const intersection = [...a].filter((w) => b.has(w)).length;
    const union = new Set([...a, ...b]).size;
    return union > 0 ? intersection / union : 0;
  }
  const titleDeduped: Record<string, unknown>[] = [];
  const titleWordSets: Set<string>[] = [];
  for (const story of entityDeduped) {
    const words = titleWords(String(story.title || ""));
    const isDup = titleWordSets.some((existing) => jaccardSimilarity(existing, words) > 0.5);
    if (!isDup) {
      titleDeduped.push(story);
      titleWordSets.push(words);
    }
  }

  return titleDeduped;
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

    const queue = (candidates.stories || []).map((story) => {
      const sourceLinks = (story.sourceLinks || []) as Array<Record<string, string>>;
      const derivedSource =
        (story.source as string) ||
        sourceLinks[0]?.source ||
        "";
      return {
        id: story.id,
        title: story.title,
        tier: story.tier ?? null,
        category: story.category,
        impactLevel: story.impactLevel,
        travelerImpact: story.travelerImpact,
        summary: (story.summary as string) || (story.synopsis as string),
        reasoning: story.reasoning,
        source: derivedSource,
        image: story.image,
        link: story.link,
        sourceLinks,
        featured: Boolean(story.featured || story.pinned),
        homepageCandidate: Boolean(story.homepageCandidate),
        status: (story.status as string) || null,
        decidedAt: (story.decidedAt as string) || null,
      };
    });

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

    const decidedAt = new Date().toISOString();

    if (action === "reject") {
      await writeJson(PATHS.candidates, {
        ...candidates,
        stories: (candidates.stories || []).map((item) =>
          item.id === id ? { ...item, status: "rejected", decidedAt } : item
        ),
      });
      res.status(200).json({ success: true, message: "Story rejected successfully" });
      return;
    }

    if (action === "defer") {
      await writeJson(PATHS.candidates, {
        ...candidates,
        stories: (candidates.stories || []).map((item) =>
          item.id === id ? { ...item, status: "held", decidedAt } : item
        ),
      });
      res.status(200).json({ success: true, message: "Story held successfully" });
      return;
    }

    const isFeatured = action === "pin";
    const approvedStory = {
      ...normalizedStory,
      status: isFeatured ? "featured" : "approved",
      approvedAt: decidedAt,
      featured: isFeatured,
      pinned: isFeatured,
    };

    const approvedStories = [
      approvedStory,
      ...(approved.stories || []).filter((item) => item.id !== id),
    ];

    // Homepage uses only explicitly featured/pinned stories (chosen by Mark via "Feature" action)
    const featuredStories = approvedStories.filter((s) => s.featured || s.pinned);

    const publishing = buildPublishingBundle({
      approvedStories,
      homepageTop5: featuredStories,
    });

    await Promise.all([
      writeJson(PATHS.approved, { generatedAt: new Date().toISOString(), stories: approvedStories }),
      writeJson(PATHS.candidates, {
        ...candidates,
        stories: (candidates.stories || []).map((item) =>
          item.id === id ? { ...item, status: approvedStory.status, decidedAt } : item
        ),
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
      message: `Story ${isFeatured ? "featured on homepage" : "approved to news feed"} successfully`,
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
    const lang = String(req.query["lang"] || "en") === "es" ? "es" as const : "en" as const;
    const curated = await runEditorialAgent({
      openai: process.env["OPENAI_API_KEY"] || process.env["REPLIT_OPENAI_API_KEY"],
      lang,
    }) as {
      stories?: Record<string, unknown>[];
      homepageTop5?: string[];
      groupedDevelopments?: unknown[];
      systemStatus?: { degraded?: boolean; reason?: string };
    };
    telemetry.ingestionCompleted = true;
    telemetry.aiCompleted = true;
    telemetry.degradedMode = Boolean(curated?.systemStatus?.degraded);

    const normalized = normalizeStories(curated.stories || []);
    const curatedStories = serverSideFilter(normalized);
    telemetry.curatedStoryCount = curatedStories.length;
    telemetry.filteredCount = normalized.length - curatedStories.length;

    // Never overwrite a good queue with an empty/degraded result
    if (telemetry.degradedMode || curatedStories.length === 0) {
      req.log.warn({ degraded: telemetry.degradedMode, count: curatedStories.length }, "Scan returned empty/degraded — preserving existing queue");
      res.json({
        success: false,
        curatedStories: 0,
        degradedMode: true,
        preserved: true,
        telemetry,
      });
      return;
    }

    const generatedAt = new Date().toISOString();
    if (lang === "es") {
      // Spanish pipeline: AI-curated, auto-published — stored in separate ES paths
      // so the English editorial queue and feeds are never overwritten.
      const top5Ids = new Set((curated.homepageTop5 || []).slice(0, 5).map(String));
      const homepageStories = curatedStories.filter(s => top5Ids.has(String(s.id)));
      await Promise.all([
        writeJson(PATHS.candidatesEs, {
          generatedAt,
          systemStatus: curated.systemStatus || null,
          stories: curatedStories,
          homepageTop5: [...top5Ids],
          groupedDevelopments: curated.groupedDevelopments || [],
          telemetry,
        }),
        writeJson(PATHS.homepageEs, {
          generatedAt,
          stories: homepageStories.length ? homepageStories : curatedStories.slice(0, 5),
        }),
        writeJson(PATHS.newsIndexEs, {
          generatedAt,
          stories: curatedStories,
        }),
        writeJson(PATHS.storyDetailsEs, {
          generatedAt,
          stories: curatedStories,
        }),
      ]);
    } else {
      await writeJson(PATHS.candidates, {
        generatedAt,
        systemStatus: curated.systemStatus || null,
        stories: curatedStories,
        homepageTop5: (curated.homepageTop5 || []).slice(0, 5),
        groupedDevelopments: curated.groupedDevelopments || [],
        telemetry,
      });
    }
    telemetry.persistenceCompleted = true;

    const dashboardUrl = process.env["DASHBOARD_URL"] ||
      (process.env["REPLIT_DEV_DOMAIN"] ? `https://${process.env["REPLIT_DEV_DOMAIN"]}` : "");
    const html = renderEditorialDigest({
      stories: curatedStories,
      dashboardUrl,
      approvalToken: process.env["AGENT_APPROVAL_TOKEN"] || "",
    });
    const emailResult = await sendEditorialDigest({
      subject: "Still Afloat AI Editorial Digest",
      html,
    });
    telemetry.emailCompleted = Boolean(emailResult?.success);

    res.json({
      success: true,
      curatedStories: curatedStories.length,
      degradedMode: false,
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
