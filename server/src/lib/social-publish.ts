import { logger } from "./logger";
import { readJson, writeJson } from "./persistence";
import type { QueuedBatch, SocialPost } from "./social-agent";

// Posting actuator. On batch approval the backend pushes each post to its
// platform via Make.
//   • Facebook → "Still Afloat Social Post" webhook (MAKE_FB_WEBHOOK):
//       {image_url, caption} → FB photo. v1 uses the YouTube thumbnail + link.
//   • Instagram Reel → MAKE_IG_WEBHOOK: {video_url, caption}. Needs a PUBLIC clip
//       URL registered in the media map for that video — since 2026-09-06 that is
//       OUR Supabase Storage bucket `social-clips` (see social-clips.ts), filled by
//       the Mac publisher right after the YouTube upload. No Cloudinary. Instagram's
//       API only fetches from a URL, it never accepts bytes, so a host is unavoidable;
//       Mark chose to own it ("as much as possible should reside on the server").
//     IG posting is language-gated by IG_POST_LANGS (comma list; unset = all) —
//       the 30-day Instagram test (Mark 2026-09-06) runs Spanish only.
//   • YouTube → skipped (it's the source).
// Fully gated: missing webhook/clip = skip, never throws.

const MEDIA_KEY = "social-media-map";

export interface MediaEntry {
  videoUrl: string;
  addedAt: string;
  lang?: string;
  path?: string; // object path inside the social-clips bucket
  sha256?: string;
  bytes?: number;
  source?: "supabase" | "cloudinary" | "manual";
}
interface MediaMap {
  items: Record<string, MediaEntry>;
}

export async function loadMediaMap(): Promise<MediaMap> {
  return readJson<MediaMap>(MEDIA_KEY, { items: {} });
}
export async function setMedia(
  videoId: string,
  videoUrl: string,
  meta: Omit<Partial<MediaEntry>, "videoUrl" | "addedAt"> = {},
): Promise<void> {
  const map = await loadMediaMap();
  map.items[videoId] = { videoUrl, addedAt: new Date().toISOString(), ...meta };
  await writeJson(MEDIA_KEY, map);
}

export interface PublishResult {
  surface: string;
  platform: string;
  ok: boolean;
  reason: string;
}

// Personal-profile surfaces (e.g. "Personal Facebook") can never be automated —
// the Meta APIs only post to Pages / business accounts. They are shared by hand
// via the Share Kit and must never be routed to the Page webhook.
export const isPersonalSurface = (post: SocialPost): boolean => /personal/i.test(post.surface);

// Publish ONE post to its platform. Used both by publishBatch (post-now) and the
// social poster cron (scheduled drip). Special reasons the caller may want to
// treat as "retry later" rather than a hard failure: "youtube-source",
// "fb-not-configured", "ig-not-configured", "ig-no-clip". "personal-manual"
// and "ig-lang-off" are terminal: resolve the post as skipped.

// IG_POST_LANGS: comma-separated languages Instagram may post in. Unset/empty =
// every language. "es" during the Spanish-only Instagram test (Mark 2026-09-06).
export function igLangAllowed(lang: string, env: string | undefined = process.env["IG_POST_LANGS"]): boolean {
  const allowed = (env ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.length === 0 || allowed.includes(String(lang).toLowerCase());
}
export async function publishOnePost(post: SocialPost): Promise<PublishResult> {
  const fbWebhook = process.env["MAKE_FB_WEBHOOK"];
  const igWebhook = process.env["MAKE_IG_WEBHOOK"];

  if (post.platform === "youtube") {
    return { surface: post.surface, platform: "youtube", ok: false, reason: "youtube-source" };
  }

  if (isPersonalSurface(post)) {
    return { surface: post.surface, platform: post.platform, ok: false, reason: "personal-manual" };
  }

  if (post.platform === "instagram") {
    if (!igLangAllowed(post.lang)) {
      return { surface: post.surface, platform: "instagram", ok: false, reason: "ig-lang-off" };
    }
    const media = await loadMediaMap();
    const clip = media.items[post.videoId]?.videoUrl;
    if (!clip) return { surface: post.surface, platform: "instagram", ok: false, reason: "ig-no-clip" };
    if (!igWebhook) return { surface: post.surface, platform: "instagram", ok: false, reason: "ig-not-configured" };
    return postWebhook(igWebhook, { video_url: clip, caption: post.caption }, post.surface, "instagram");
  }

  // facebook — photo post: send the YouTube thumbnail + caption + link.
  if (!fbWebhook) return { surface: post.surface, platform: "facebook", ok: false, reason: "fb-not-configured" };
  const caption = post.link ? `${post.caption}\n\n${post.link}` : post.caption;
  const image_url = `https://i.ytimg.com/vi/${post.videoId}/hqdefault.jpg`;
  return postWebhook(fbWebhook, { image_url, caption }, post.surface, "facebook");
}

export async function publishBatch(batch: QueuedBatch): Promise<PublishResult[]> {
  const results: PublishResult[] = [];
  for (const post of batch.posts) {
    results.push(await publishOnePost(post));
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
