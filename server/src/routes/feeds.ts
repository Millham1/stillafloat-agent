import { Router, type IRouter, type Request, type Response } from "express";
import { PATHS, readJson } from "../lib/persistence";

const router: IRouter = Router();

type StoryRecord = Record<string, unknown>;

function applyEsOverlay(story: StoryRecord): StoryRecord {
  return {
    ...story,
    title: (story["title_es"] as string) || story["title"],
    summary: (story["summary_es"] as string) || story["summary"],
    travelerImpact: (story["travelerImpact_es"] as string) || story["travelerImpact"],
    editorialReasoning: (story["editorialReasoning_es"] as string) || story["editorialReasoning"],
  };
}

router.get("/homepage-feed", async (req: Request, res: Response) => {
  try {
    const lang = String(req.query["lang"] || "en");
    const isEs = lang === "es";

    // Spanish site always reads from the shared English editorial queue.
    // Per-story title_es / summary_es etc. fields are applied when present.
    const data = await readJson<{ generatedAt?: string; stories?: StoryRecord[] }>(
      PATHS.homepage,
      { generatedAt: undefined, stories: [] }
    );

    const stories = isEs
      ? (data.stories || []).map(applyEsOverlay)
      : (data.stories || []);

    res.json({
      success: true,
      source: "stillafloat-agent",
      lang: isEs ? "es" : "en",
      generatedAt: data.generatedAt || null,
      count: stories.length,
      stories,
    });
  } catch (error) {
    req.log.error({ err: error }, "Homepage feed failure");
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get("/news-feed", async (req: Request, res: Response) => {
  try {
    const lang = String(req.query["lang"] || "en");
    const isEs = lang === "es";

    const data = await readJson<{ generatedAt?: string; stories?: StoryRecord[] }>(
      PATHS.newsIndex,
      { generatedAt: undefined, stories: [] }
    );

    const stories = isEs
      ? (data.stories || []).map(applyEsOverlay)
      : (data.stories || []);

    res.json({
      success: true,
      source: "stillafloat-agent",
      lang: isEs ? "es" : "en",
      generatedAt: data.generatedAt || null,
      count: stories.length,
      stories,
    });
  } catch (error) {
    req.log.error({ err: error }, "News feed failure");
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get("/story-details", async (req: Request, res: Response): Promise<void> => {
  try {
    const lang = String(req.query["lang"] || "en");
    const isEs = lang === "es";

    const details = await readJson<{ generatedAt?: string; stories?: StoryRecord[] }>(
      PATHS.storyDetails,
      { generatedAt: undefined, stories: [] }
    );

    const storyId = String(req.query["id"] || "").trim();

    if (storyId) {
      const rawStory = (details.stories || []).find((item) => item["id"] === storyId);
      if (!rawStory) {
        res.status(404).json({ success: false, error: "Story not found" });
        return;
      }
      const story = isEs ? applyEsOverlay(rawStory) : rawStory;
      res.json({ success: true, story });
      return;
    }

    const stories = isEs
      ? (details.stories || []).map(applyEsOverlay)
      : (details.stories || []);

    res.json({
      success: true,
      source: "stillafloat-agent",
      generatedAt: details.generatedAt || null,
      count: stories.length,
      stories,
    });
  } catch (error) {
    req.log.error({ err: error }, "Story details failure");
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get("/alerts-feed", async (req: Request, res: Response) => {
  try {
    const newsIndex = await readJson<{ generatedAt?: string; stories?: StoryRecord[] }>(PATHS.newsIndex, { generatedAt: undefined, stories: [] });

    const alerts = (newsIndex.stories || [])
      .filter((story) => {
        const impact = String(story["impactLevel"] || "").toLowerCase();
        return story["featured"] || story["pinned"] || impact.includes("high") || impact.includes("critical");
      })
      .slice(0, 10)
      .map((story) => ({
        id: story["id"],
        title: story["title"],
        category: story["category"],
        impactLevel: story["impactLevel"],
        travelerImpact: story["travelerImpact"],
        summary: story["summary"],
        link: story["link"],
        approvedAt: story["approvedAt"],
        featured: Boolean(story["featured"] || story["pinned"]),
      }));

    res.json({
      success: true,
      source: "stillafloat-agent",
      generatedAt: newsIndex.generatedAt || null,
      count: alerts.length,
      alerts,
    });
  } catch (error) {
    req.log.error({ err: error }, "Alerts feed failure");
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get("/weather-alerts", async (req: Request, res: Response) => {
  try {
    const monitoredPorts = [
      "Miami", "Port Canaveral", "Galveston", "Tampa", "San Juan", "Cozumel", "Nassau",
    ];
    res.json({
      success: true,
      source: "stillafloat-agent",
      generatedAt: new Date().toISOString(),
      monitoringEnabled: true, // Open-Meteo — no API key required
      monitoredPorts,
      status: "weather aggregation scaffolding active",
    });
  } catch (error) {
    req.log.error({ err: error }, "Weather alerts failure");
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get("/system-status", async (req: Request, res: Response) => {
  try {
    const [candidates, approved, homepage] = await Promise.all([
      readJson<{ stories?: unknown[]; systemStatus?: { degraded?: boolean; reason?: string } }>(PATHS.candidates, { stories: [] }),
      readJson<{ stories?: unknown[] }>(PATHS.approved, { stories: [] }),
      readJson<{ stories?: unknown[] }>(PATHS.homepage, { stories: [] }),
    ]);

    res.json({
      success: true,
      service: "stillafloat-agent",
      generatedAt: new Date().toISOString(),
      environment: process.env["NODE_ENV"] || "unknown",
      systems: {
        openaiConfigured: Boolean(process.env["OPENAI_API_KEY"]),
        resendConfigured: Boolean(process.env["RESEND_API_KEY"]),
        gnewsConfigured: Boolean(process.env["GNEWS_API_KEY"]),
        weatherConfigured: true, // Open-Meteo — no API key required
        approvalConfigured: Boolean(process.env["APPROVAL_EMAIL"] && process.env["RESEND_API_KEY"]),
      },
      publishing: {
        candidateStories: (candidates.stories || []).length,
        approvedStories: (approved.stories || []).length,
        homepageStories: (homepage.stories || []).length,
      },
      pipeline: {
        // Only show degraded if the flag is set AND no stories exist.
        // If stories are present a successful scan has run since the failure,
        // so the stale error flag is no longer meaningful.
        degradedMode: Boolean(candidates.systemStatus?.degraded) && (candidates.stories || []).length === 0,
        degradedReason: candidates.systemStatus?.degraded && (candidates.stories || []).length === 0
          ? (candidates.systemStatus?.reason || null)
          : null,
      },
    });
  } catch (error) {
    req.log.error({ err: error }, "System status failure");
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get("/platform-manifest", async (req: Request, res: Response) => {
  try {
    const siteUrl = process.env["SITE_URL"] || "https://stillafloatcruising.com";

    res.json({
      success: true,
      service: "stillafloat-agent",
      generatedAt: new Date().toISOString(),
      endpoints: {
        health: `${siteUrl}/api/healthz`,
        systemStatus: `${siteUrl}/api/system-status`,
        homepageFeed: `${siteUrl}/api/homepage-feed`,
        newsFeed: `${siteUrl}/api/news-feed`,
        storyDetails: `${siteUrl}/api/story-details`,
        alertsFeed: `${siteUrl}/api/alerts-feed`,
        weatherAlerts: `${siteUrl}/api/weather-alerts`,
        scanNews: `${siteUrl}/api/scan-news`,
        editorialActions: `${siteUrl}/api/agent-action`,
        affiliateItems: `${siteUrl}/api/affiliate-items`,
      },
      capabilities: {
        aiEditorial: true,
        operationalAlerts: true,
        publishingFeeds: true,
        approvalWorkflow: true,
        affiliateManager: true,
        weatherMonitoring: Boolean(process.env["OPENWEATHER_API_KEY"]),
        emailDelivery: Boolean(process.env["RESEND_API_KEY"]),
      },
    });
  } catch (error) {
    req.log.error({ err: error }, "Platform manifest failure");
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

export default router;
