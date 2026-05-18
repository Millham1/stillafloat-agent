import { Router, type IRouter, type Request, type Response } from "express";
import { PATHS, readJson } from "../lib/persistence";

const router: IRouter = Router();

router.get("/homepage-feed", async (req: Request, res: Response) => {
  try {
    const homepage = await readJson<{ generatedAt?: string; stories?: unknown[] }>(PATHS.homepage, { generatedAt: undefined, stories: [] });
    res.json({
      success: true,
      source: "stillafloat-agent",
      generatedAt: homepage.generatedAt || null,
      count: (homepage.stories || []).length,
      stories: homepage.stories || [],
    });
  } catch (error) {
    req.log.error({ err: error }, "Homepage feed failure");
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get("/news-feed", async (req: Request, res: Response) => {
  try {
    const [newsIndex, candidates] = await Promise.all([
      readJson<{ generatedAt?: string; stories?: Record<string, unknown>[] }>(PATHS.newsIndex, { generatedAt: undefined, stories: [] }),
      readJson<{ generatedAt?: string; stories?: Record<string, unknown>[] }>(PATHS.candidates, { generatedAt: undefined, stories: [] }),
    ]);

    // Approved stories come first, then fill with queue candidates not already approved
    const approvedIds = new Set((newsIndex.stories || []).map((s) => String(s.id)));
    const candidateFill = (candidates.stories || [])
      .filter((s) => s.id && !approvedIds.has(String(s.id)) && s.tier && Number(s.tier) >= 1)
      .map((s) => ({ ...s, _pending: true }));

    const merged = [...(newsIndex.stories || []), ...candidateFill];

    res.json({
      success: true,
      source: "stillafloat-agent",
      generatedAt: newsIndex.generatedAt || candidates.generatedAt || null,
      count: merged.length,
      stories: merged,
    });
  } catch (error) {
    req.log.error({ err: error }, "News feed failure");
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get("/story-details", async (req: Request, res: Response): Promise<void> => {
  try {
    const storyDetails = await readJson<{ generatedAt?: string; stories?: Record<string, unknown>[] }>(PATHS.storyDetails, { generatedAt: undefined, stories: [] });
    const storyId = String(req.query.id || "").trim();

    if (storyId) {
      const story = (storyDetails.stories || []).find((item) => item.id === storyId);
      if (!story) {
        res.status(404).json({ success: false, error: "Story not found" });
        return;
      }
      res.json({ success: true, story });
      return;
    }

    res.json({
      success: true,
      source: "stillafloat-agent",
      generatedAt: storyDetails.generatedAt || null,
      count: (storyDetails.stories || []).length,
      stories: storyDetails.stories || [],
    });
  } catch (error) {
    req.log.error({ err: error }, "Story details failure");
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get("/alerts-feed", async (req: Request, res: Response) => {
  try {
    const newsIndex = await readJson<{ generatedAt?: string; stories?: Record<string, unknown>[] }>(PATHS.newsIndex, { generatedAt: undefined, stories: [] });

    const alerts = (newsIndex.stories || [])
      .filter((story) => {
        const impact = String(story.impactLevel || "").toLowerCase();
        return story.featured || story.pinned || impact.includes("high") || impact.includes("critical");
      })
      .slice(0, 10)
      .map((story) => ({
        id: story.id,
        title: story.title,
        category: story.category,
        impactLevel: story.impactLevel,
        travelerImpact: story.travelerImpact,
        summary: story.summary,
        link: story.link,
        approvedAt: story.approvedAt,
        featured: Boolean(story.featured || story.pinned),
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
      monitoringEnabled: Boolean(process.env["OPENWEATHER_API_KEY"]),
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
        openaiConfigured: Boolean(process.env["OPENAI_API_KEY"] || process.env["REPLIT_OPENAI_API_KEY"]),
        resendConfigured: Boolean(process.env["RESEND_API_KEY"]),
        gnewsConfigured: Boolean(process.env["GNEWS_API_KEY"]),
        weatherConfigured: Boolean(process.env["OPENWEATHER_API_KEY"]),
        approvalConfigured: Boolean(process.env["APPROVAL_EMAIL"] && process.env["RESEND_API_KEY"]),
      },
      publishing: {
        candidateStories: (candidates.stories || []).length,
        approvedStories: (approved.stories || []).length,
        homepageStories: (homepage.stories || []).length,
      },
      pipeline: {
        degradedMode: Boolean(candidates.systemStatus?.degraded),
        degradedReason: candidates.systemStatus?.reason || null,
      },
    });
  } catch (error) {
    req.log.error({ err: error }, "System status failure");
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get("/platform-manifest", async (req: Request, res: Response) => {
  try {
    const siteUrl = process.env["REPLIT_DOMAINS"]?.split(",")[0]
      ? `https://${process.env["REPLIT_DOMAINS"]?.split(",")[0]}`
      : "https://stillafloat-agent.replit.app";

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
      },
      capabilities: {
        aiEditorial: true,
        operationalAlerts: true,
        publishingFeeds: true,
        approvalWorkflow: true,
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
