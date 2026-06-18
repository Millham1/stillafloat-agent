import { Router, type IRouter, type Request, type Response } from "express";
import { readJson, writeJson } from "../lib/persistence";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const CHANNEL_HANDLE = "@StillAfloatcruising2026";
const CHANNEL_URL = `https://www.youtube.com/@StillAfloatcruising2026`;

// Cache the resolved channel ID in memory so we don't re-fetch every time
let cachedChannelId: string | null = null;

async function resolveChannelId(): Promise<string | null> {
  if (cachedChannelId) return cachedChannelId;
  try {
    const res = await fetch(CHANNEL_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; StillAfloatBot/1.0)" },
    });
    const html = await res.text();
    // YouTube embeds channelId in the page as `"channelId":"UCxxxxxxx"`
    const match = /"channelId":"(UC[a-zA-Z0-9_-]{22})"/?.exec(html);
    if (match?.[1]) {
      cachedChannelId = match[1];
      logger.info({ channelId: cachedChannelId }, "Resolved YouTube channel ID");
      return cachedChannelId;
    }
    // Fallback: externalId pattern
    const match2 = /"externalId":"(UC[a-zA-Z0-9_-]{22})"/?.exec(html);
    if (match2?.[1]) {
      cachedChannelId = match2[1];
      logger.info({ channelId: cachedChannelId, via: "externalId" }, "Resolved YouTube channel ID");
      return cachedChannelId;
    }
    logger.warn({ html: html.slice(0, 500) }, "Could not extract channel ID from YouTube page");
    return null;
  } catch (err) {
    logger.error({ err }, "Failed to resolve YouTube channel ID");
    return null;
  }
}

interface YTVideo {
  id: string;
  title: string;
  published: string;
  thumbnail: string;
  url: string;
  isShort: boolean;
  views: number;
}

async function fetchChannelVideos(channelId: string): Promise<YTVideo[]> {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(feedUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; StillAfloatBot/1.0)" },
  });
  if (!res.ok) throw new Error(`RSS feed returned ${res.status}`);
  const xml = await res.text();

  const entries: YTVideo[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;

  while ((m = entryRegex.exec(xml)) !== null) {
    const entry = m[1];
    const videoId = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(entry)?.[1] ?? "";
    const title = /<title>([^<]+)<\/title>/.exec(entry)?.[1] ?? "";
    const published = /<published>([^<]+)<\/published>/.exec(entry)?.[1] ?? "";
    const thumbUrl = /<media:thumbnail[^>]+url="([^"]+)"/.exec(entry)?.[1]
      ?? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    // YouTube's channel RSS includes per-video view counts in media:community.
    const views = Number(/<media:statistics\s+views="(\d+)"/.exec(entry)?.[1] ?? "0");

    if (!videoId) continue;

    // Detect Shorts by checking duration later or by title hint — for now flag all ≤60s
    // We'll use the thumbnail aspect ratio heuristic: Shorts thumbnails are often vertical
    // Simplest: check if the video was in a /shorts/ URL when we detect it
    entries.push({
      id: videoId,
      title: title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
      published,
      thumbnail: thumbUrl,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      isShort: false,
      views,
    });
  }

  return entries;
}

// ── GET /api/youtube-scan ─────────────────────────────────────────────────────
router.get("/youtube-scan", async (req: Request, res: Response) => {
  try {
    const channelId = await resolveChannelId();
    if (!channelId) {
      res.status(502).json({ success: false, error: "Could not resolve YouTube channel ID" });
      return;
    }

    const videos = await fetchChannelVideos(channelId);
    const scannedAt = new Date().toISOString();

    // Persist the scan result. Preserve a manual feature pick if Mark set one;
    // otherwise leave featuredId unpinned so the homepage tracks the latest upload.
    const existing = (await readJson("youtube-channel")) as
      | { featuredId?: string; featuredManual?: boolean }
      | null;
    await writeJson("youtube-channel", {
      scannedAt,
      channelId,
      channelHandle: CHANNEL_HANDLE,
      videos,
      featuredId: existing?.featuredId ?? null,
      featuredManual: existing?.featuredManual ?? false,
    });

    res.json({ success: true, scannedAt, channelId, videos });
  } catch (err) {
    logger.error({ err }, "YouTube scan failed");
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── POST /api/youtube-feature ─────────────────────────────────────────────────
router.post("/youtube-feature", async (req: Request, res: Response) => {
  try {
    const { videoId } = req.body as { videoId?: string };
    if (!videoId) {
      res.status(400).json({ success: false, error: "videoId required" });
      return;
    }

    const existing = (await readJson("youtube-channel")) as Record<string, unknown> | null;
    if (!existing) {
      res.status(404).json({ success: false, error: "No YouTube data — run a scan first" });
      return;
    }

    await writeJson("youtube-channel", { ...existing, featuredId: videoId, featuredManual: true });
    res.json({ success: true, featuredId: videoId });
  } catch (err) {
    logger.error({ err }, "YouTube feature failed");
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── GET /api/youtube-featured ─────────────────────────────────────────────────
// Public endpoint used by the homepage to get the currently featured video
router.get("/youtube-featured", async (_req: Request, res: Response) => {
  try {
    const data = (await readJson("youtube-channel")) as {
      featuredId?: string;
      featuredManual?: boolean;
      videos?: YTVideo[];
      scannedAt?: string;
    } | null;

    const videos = data?.videos ?? [];

    const respond = (v: YTVideo) =>
      res.json({
        videoId: v.id,
        title: v.title,
        thumbnail: v.thumbnail || `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`,
        channelUrl: CHANNEL_URL,
      });

    // 1. A video Mark explicitly featured wins — as long as it's still in the feed.
    if (data?.featuredManual && data.featuredId) {
      const pinned = videos.find(v => v.id === data.featuredId);
      if (pinned) { respond(pinned); return; }
    }

    // 2. Otherwise track the latest upload (the feed is newest-first).
    if (videos.length > 0) { respond(videos[0]); return; }

    // 3. Nothing scanned yet — fall back to the hardcoded Short.
    res.json({
      videoId: "qjzM4sm7cqA",
      title: "Cruise Relationship Crisis",
      thumbnail: "https://img.youtube.com/vi/qjzM4sm7cqA/mqdefault.jpg",
      channelUrl: CHANNEL_URL,
    });
  } catch (err) {
    logger.error({ err }, "YouTube featured fetch failed");
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── GET /api/youtube-top ──────────────────────────────────────────────────────
// Public endpoint used by the homepage to show the most-watched videos.
// Returns the top N (default 5) by view count, plus the channel URL.
router.get("/youtube-top", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 10);
    const data = (await readJson("youtube-channel")) as { videos?: YTVideo[] } | null;

    const videos = (data?.videos ?? [])
      .slice()
      .sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0))
      .slice(0, limit)
      .map((v) => ({
        id: v.id,
        title: v.title,
        thumbnail: v.thumbnail || `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`,
        url: v.url || `https://www.youtube.com/watch?v=${v.id}`,
        views: Number(v.views) || 0,
      }));

    res.json({ videos, channelUrl: CHANNEL_URL });
  } catch (err) {
    logger.error({ err }, "YouTube top fetch failed");
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
