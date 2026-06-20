import { logger } from "./logger";
import type { QueuedBatch } from "./social-agent";

// Posting actuator. On batch approval the backend pushes each post to its
// platform via Make. v1 path (no media-hosting pipeline yet): Facebook photo
// posts using the video's public YouTube thumbnail + caption + link — drives
// traffic to YouTube. Instagram Reels / native FB video need a public clip URL
// (Cloudinary upload of the actual file) and are skipped until that exists.
//
// Fully gated: if MAKE_FB_WEBHOOK is unset, nothing posts (dormant). The webhook
// is the Make "Still Afloat Social Post" scenario ({image_url, caption} → FB page).

export interface PublishResult {
  surface: string;
  platform: string;
  ok: boolean;
  reason: string;
}

export async function publishBatch(batch: QueuedBatch): Promise<PublishResult[]> {
  const fbWebhook = process.env["MAKE_FB_WEBHOOK"];
  const results: PublishResult[] = [];

  for (const post of batch.posts) {
    if (post.platform === "youtube") {
      results.push({ surface: post.surface, platform: "youtube", ok: false, reason: "source — already on YouTube" });
      continue;
    }
    if (post.platform === "instagram") {
      results.push({ surface: post.surface, platform: "instagram", ok: false, reason: "needs hosted clip (Cloudinary) — pending media pipeline" });
      continue;
    }
    // facebook
    if (!fbWebhook) {
      results.push({ surface: post.surface, platform: "facebook", ok: false, reason: "MAKE_FB_WEBHOOK not configured" });
      continue;
    }
    try {
      const image_url = `https://i.ytimg.com/vi/${post.videoId}/hqdefault.jpg`;
      const caption = post.link ? `${post.caption}\n\n${post.link}` : post.caption;
      const r = await fetch(fbWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_url, caption }),
        signal: AbortSignal.timeout(30_000),
      });
      results.push({ surface: post.surface, platform: "facebook", ok: r.ok, reason: r.ok ? "posted" : `HTTP ${r.status}` });
    } catch (err) {
      results.push({ surface: post.surface, platform: "facebook", ok: false, reason: (err as Error).message });
    }
  }

  logger.info({ batch: batch.id, results }, "publishBatch");
  return results;
}
