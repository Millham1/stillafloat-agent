import { logger } from "./logger";
import { readJson, writeJson } from "./persistence";
import type { QueuedBatch, SocialPost } from "./social-agent";
import type { PublishResult } from "./social-publish";

// Test-only posting target for the DEV mirror (Mark 2026-10-09: "turn the poster on in dev").
//
// Dev has no Make webhooks and must never post publicly, so with the poster switched off the
// release gate could never see it work (jobs.social-poster-handles-due-posts stayed UNTESTABLE).
// With SOCIAL_POSTER_SINK=1 the poster runs as on prod — same schedule, same language and clip
// rules, same outcomes — but the final hop goes to this sink (platform_state "social-sink",
// newest 100) instead of Make, so nothing can leave the box. It never calls a webhook, even
// if one is set. It refuses to run on a box whose PUBLIC_URL is the production site, so a
// stray flag on prod cannot pretend to post.

const SINK_KEY = "social-sink";
const KEEP = 100;
const PRODUCTION_HOST = /(^|[/.])stillafloatcruising\.com(?=[/:]|$)/i;

export function sinkEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env["SOCIAL_POSTER_SINK"] !== "1") return false;
  const url = env["PUBLIC_URL"] ?? "";
  return url.length > 0 && !PRODUCTION_HOST.test(url);
}

export interface SinkEntry {
  at: string;
  platform: string;
  surface: string;
  lang: string;
  videoId: string;
  scheduledFor: string | null;
  captionChars: number;
}

export function sinkEntry(post: SocialPost, nowMs: number): SinkEntry {
  return {
    at: new Date(nowMs).toISOString(),
    platform: post.platform,
    surface: post.surface,
    lang: post.lang,
    videoId: post.videoId,
    scheduledFor: post.scheduledFor ?? null,
    captionChars: post.caption.length,
  };
}

/** "Send" one post to the sink: recorded, never transmitted. */
export async function sinkPost(post: SocialPost, nowMs = Date.now()): Promise<PublishResult> {
  try {
    const store = await readJson<{ entries: SinkEntry[] }>(SINK_KEY, { entries: [] });
    store.entries = [sinkEntry(post, nowMs), ...(store.entries ?? [])].slice(0, KEEP);
    await writeJson(SINK_KEY, store);
    logger.info({ platform: post.platform, surface: post.surface, videoId: post.videoId }, "social poster: SINK (dev) — recorded, not sent");
    return { surface: post.surface, platform: post.platform, ok: true, reason: "posted" };
  } catch (err) {
    return { surface: post.surface, platform: post.platform, ok: false, reason: `sink-error: ${(err as Error).message}` };
  }
}

/**
 * Which pending batch the dev feeder approves next. Mark approves batches by hand on prod, so
 * prod's calendar always has posts coming; on dev nobody does, so the sink-mode poster would run
 * dry. When fewer than `minAhead` posts are still waiting for a future slot, the OLDEST pending
 * batch is approved (scheduled into the next free slots, like any approval). Pure.
 */
export function pickBatchToFeed(batches: QueuedBatch[], nowMs: number, minAhead = 3): QueuedBatch | null {
  const ahead = batches.reduce((n, b) => n + b.posts.filter((p) => {
    const at = p.scheduledFor ? Date.parse(p.scheduledFor) : NaN;
    return Number.isFinite(at) && at > nowMs && !p.postedAt && p.postState === "scheduled";
  }).length, 0);
  if (ahead >= minAhead) return null;
  const pending = batches.filter((b) => b.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return pending[0] ?? null;
}
