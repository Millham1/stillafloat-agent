import { logger } from "./logger";
import { readJson, writeJson } from "./persistence";
import type { QueuedBatch } from "./social-agent";

// Posting actuator. On batch approval the backend pushes each post to its
// platform via Make.
//   • Facebook → "Still Afloat Social Post" webhook (MAKE_FB_WEBHOOK):
//       {image_url, caption} → FB photo. v1 uses the YouTube thumbnail + link.
//   • Instagram Reel → MAKE_IG_WEBHOOK: {video_url, caption}. Needs a hosted
//       clip URL (Cloudinary) registered in the media map for that video.
//   • YouTube → skipped (it's the source).
// Fully gated: missing webhook/clip = skip, never throws.

const MEDIA_KEY = "social-media-map";

export interface MediaEntry {
  videoUrl: string;
  addedAt: string;
}
interface MediaMap {
  items: Record<string, MediaEntry>;
}

export async function loadMediaMap(): Promise<MediaMap> {
  return readJson<MediaMap>(MEDIA_KEY, { items: {} });
}
export async function setMedia(videoId: string, videoUrl: string): Promise<void> {
  const map = await loadMediaMap();
  map.items[videoId] = { videoUrl, addedAt: new Date().toISOString() };
  await writeJson(MEDIA_KEY, map);
}

export interface PublishResult {
  surface: string;
  platform: string;
  ok: boolean;
  reason: string;
}

export async function publishBatch(batch: QueuedBatch): Promise<PublishResult[]> {
  const fbWebhook = process.env["MAKE_FB_WEBHOOK"];
  const igWebhook = process.env["MAKE_IG_WEBHOOK"];
  const media = await loadMediaMap();
  const results: PublishResult[] = [];

  for (const post of batch.posts) {
    if (post.platform === "youtube") {
      results.push({ surface: post.surface, platform: "youtube", ok: false, reason: "source — already on YouTube" });
      continue;
    }

    if (post.platform === "instagram") {
      const clip = media.items[post.videoId]?.videoUrl;
      if (!clip) {
        results.push({ surface: post.surface, platform: "instagram", ok: false, reason: "no hosted clip URL registered (Cloudinary) for this video" });
        continue;
      }
      if (!igWebhook) {
        results.push({ surface: post.surface, platform: "instagram", ok: false, reason: "MAKE_IG_WEBHOOK not configured" });
        continue;
      }
      results.push(await postWebhook(igWebhook, { video_url: clip, caption: post.caption }, post.surface, "instagram"));
      continue;
    }

    // facebook
    if (!fbWebhook) {
      results.push({ surface: post.surface, platform: "facebook", ok: false, reason: "MAKE_FB_WEBHOOK not configured" });
      continue;
    }
    // Prefer a hosted clip (native video) when available; else the thumbnail.
    const clip = media.items[post.videoId]?.videoUrl;
    const payload = clip
      ? { video_url: clip, caption: post.link ? `${post.caption}\n\n${post.link}` : post.caption }
      : { image_url: `https://i.ytimg.com/vi/${post.videoId}/hqdefault.jpg`, caption: post.link ? `${post.caption}\n\n${post.link}` : post.caption };
    results.push(await postWebhook(fbWebhook, payload, post.surface, "facebook"));
  }

  logger.info({ batch: batch.id, results }, "publishBatch");
  return results;
}

async function postWebhook(
  url: string,
  body: Record<string, string>,
  surface: string,
  platform: string,
): Promise<PublishResult> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    return { surface, platform, ok: r.ok, reason: r.ok ? "posted" : `HTTP ${r.status}` };
  } catch (err) {
    return { surface, platform, ok: false, reason: (err as Error).message };
  }
}
