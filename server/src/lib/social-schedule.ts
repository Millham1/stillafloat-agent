import { logger } from "./logger";
import { readJson, writeJson } from "./persistence";
import { loadQueue, saveQueue, type QueuedBatch, type SocialPost } from "./social-agent";
import { publishOnePost } from "./social-publish";

// ─────────────────────────────────────────────────────────────────────────────
// Social posting SCHEDULER.
//
// On approval, a batch's posts are spread across the week into daily time slots
// (the "calendar"), instead of all firing at once. A cron then posts each one
// when its time arrives. Mark's approval stays the single human gate; everything
// after it drips out automatically.
//
// YouTube slots are the source video itself, so they're never posted — marked
// "skipped". A post whose platform isn't configured yet (or whose IG clip isn't
// registered) is left scheduled and retried on the next tick, so posting simply
// "switches on" once the env vars / clips are in place — no backlog blast beyond
// the per-tick throttle.
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_KEY = "social-schedule-config";

export interface ScheduleConfig {
  tz: string; // IANA timezone the posting times are expressed in
  times: string[]; // daily slot times "HH:MM" (local to tz)
  leadMinutes: number; // don't schedule anything sooner than this from now
}

const DEFAULT_CONFIG: ScheduleConfig = {
  tz: process.env["SAF_TZ"] || "America/New_York",
  times: ["09:00", "13:00", "17:00"],
  leadMinutes: 30,
};

export async function loadScheduleConfig(): Promise<ScheduleConfig> {
  const c = await readJson<Partial<ScheduleConfig>>(CONFIG_KEY, {});
  return {
    tz: c.tz || DEFAULT_CONFIG.tz,
    times: c.times && c.times.length ? c.times : DEFAULT_CONFIG.times,
    leadMinutes: typeof c.leadMinutes === "number" ? c.leadMinutes : DEFAULT_CONFIG.leadMinutes,
  };
}

export async function saveScheduleConfig(c: ScheduleConfig): Promise<void> {
  await writeJson(CONFIG_KEY, c);
}

// ── Timezone math (no external libs) ─────────────────────────────────────────
// Offset (ms) between the given instant's wall-clock in `tz` and true UTC.
function tzOffsetMs(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(instant)) if (part.type !== "literal") p[part.type] = part.value;
  const asUTC = Date.UTC(+p["year"]!, +p["month"]! - 1, +p["day"]!, +p["hour"]!, +p["minute"]!, +p["second"]!);
  return asUTC - instant.getTime();
}

// The UTC instant for a wall-clock time (y/mo/d h:mi) in `tz`. mo is 0-based.
function zonedWallClockToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  let utc = Date.UTC(y, mo, d, h, mi, 0);
  for (let i = 0; i < 2; i++) utc = Date.UTC(y, mo, d, h, mi, 0) - tzOffsetMs(new Date(utc), tz);
  return new Date(utc);
}

// Generate upcoming slot instants (chronological), starting at `from`.
function* upcomingSlots(cfg: ScheduleConfig, from: Date): Generator<Date> {
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: cfg.tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  for (let dayOffset = 0; dayOffset < 90; dayOffset++) {
    const dayInstant = new Date(from.getTime() + dayOffset * 86_400_000);
    const [y, mo, d] = dateFmt.format(dayInstant).split("-").map(Number);
    for (const t of cfg.times) {
      const [h, mi] = t.split(":").map(Number);
      const slot = zonedWallClockToUtc(y!, mo! - 1, d!, h!, mi!, cfg.tz);
      if (slot.getTime() > from.getTime()) yield slot;
    }
  }
}

const schedulable = (p: SocialPost): boolean => p.platform !== "youtube";

// Assign each schedulable post in `batch` the next free upcoming slot (not
// colliding with posts already scheduled elsewhere in the queue). Mutates the
// batch in place and flips its status to "scheduled". Returns the batch.
export async function scheduleApprovedBatch(batch: QueuedBatch): Promise<QueuedBatch> {
  const cfg = await loadScheduleConfig();
  const queue = await loadQueue();
  const now = Date.now();
  const from = new Date(now + cfg.leadMinutes * 60_000);

  // Slots already taken by other not-yet-posted scheduled posts.
  const taken = new Set<number>();
  for (const b of queue.batches) {
    if (b.id === batch.id) continue;
    for (const p of b.posts) {
      if (p.scheduledFor && !p.postedAt) taken.add(new Date(p.scheduledFor).getTime());
    }
  }

  const slots = upcomingSlots(cfg, from);
  const nextFreeSlot = (): Date | null => {
    for (let guard = 0; guard < 1000; guard++) {
      const n = slots.next();
      if (n.done) return null;
      const ts = n.value.getTime();
      if (!taken.has(ts)) { taken.add(ts); return n.value; }
    }
    return null;
  };

  for (const post of batch.posts) {
    if (!schedulable(post)) {
      post.postState = "skipped";
      delete post.scheduledFor;
      continue;
    }
    const slot = nextFreeSlot();
    if (slot) {
      post.scheduledFor = slot.toISOString();
      post.postState = "scheduled";
      delete post.postedAt;
      delete post.postError;
    }
  }
  batch.status = "scheduled";
  batch.decidedAt = new Date().toISOString();

  // Persist into the live queue (replace this batch).
  const idx = queue.batches.findIndex((b) => b.id === batch.id);
  if (idx >= 0) queue.batches[idx] = batch;
  await saveQueue(queue);
  return batch;
}

// "retry later" reasons — leave the post scheduled, try again next tick.
const RETRY_REASONS = new Set(["fb-not-configured", "ig-not-configured", "ig-no-clip"]);

// Post everything that's due. Throttled per tick. Returns count posted.
export async function runDuePosts(maxPerTick = 5): Promise<number> {
  const queue = await loadQueue();
  const now = Date.now();
  let posted = 0;
  let changed = false;

  for (const batch of queue.batches) {
    if (batch.status !== "scheduled") continue;
    for (const post of batch.posts) {
      if (posted >= maxPerTick) break;
      if (post.postedAt || post.postState === "skipped" || post.postState === "failed") continue;
      if (!post.scheduledFor || new Date(post.scheduledFor).getTime() > now) continue;

      const res = await publishOnePost(post);
      if (res.ok) {
        post.postedAt = new Date().toISOString();
        post.postState = "posted";
        posted++;
        changed = true;
      } else if (RETRY_REASONS.has(res.reason)) {
        // not configured / no clip yet — leave scheduled, retry next tick
        continue;
      } else {
        post.postState = "failed";
        post.postError = res.reason;
        changed = true;
      }
    }
    // A batch is done when every schedulable post is resolved (posted/failed).
    const open = batch.posts.some(
      (p) => schedulable(p) && !p.postedAt && p.postState !== "failed",
    );
    if (!open && batch.status !== "posted") {
      batch.status = "posted";
      changed = true;
    }
    if (posted >= maxPerTick) break;
  }

  if (changed) await saveQueue(queue);
  if (posted > 0) logger.info({ posted }, "social poster: posted due items");
  return posted;
}

// Flat, chronological view of everything scheduled or already posted (calendar).
export interface ScheduledItem {
  batchId: string;
  videoId: string;
  title: string;
  track: string;
  platform: string;
  surface: string;
  caption: string;
  scheduledFor?: string;
  postedAt?: string;
  postState?: string;
  postError?: string;
}

export async function listSchedule(): Promise<ScheduledItem[]> {
  const queue = await loadQueue();
  const items: ScheduledItem[] = [];
  for (const b of queue.batches) {
    if (b.status !== "scheduled" && b.status !== "posted") continue;
    for (const p of b.posts) {
      if (!schedulable(p)) continue;
      items.push({
        batchId: b.id, videoId: b.videoId, title: b.title, track: b.track,
        platform: p.platform, surface: p.surface, caption: p.caption,
        ...(p.scheduledFor ? { scheduledFor: p.scheduledFor } : {}),
        ...(p.postedAt ? { postedAt: p.postedAt } : {}),
        ...(p.postState ? { postState: p.postState } : {}),
        ...(p.postError ? { postError: p.postError } : {}),
      });
    }
  }
  items.sort((a, b) => (a.scheduledFor || a.postedAt || "").localeCompare(b.scheduledFor || b.postedAt || ""));
  return items;
}
