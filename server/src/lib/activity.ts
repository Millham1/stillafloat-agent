// activity.ts — the record of what the agents did, for the brief page. Nothing here pushes.
//
// Mark, 2026-10-22: his phone was getting 6–34 pushes a day from four agents in eight title
// styles ("multiple brief alerts for different topics, and none of them tie to each other").
// His decision: two notification shapes only — "Waiting on you: N" and "Heads-up: …" — and
// everything else stops pushing and goes onto the brief page under "What the agents did today".
// This module is that page section's store: every notifyMark() call that is not a waiting
// trigger lands here (pushed or not), so the page is the complete log and the phone is quiet.
//
// Storage: one platform_state row per entry, id `activity:<local day>:<iso time>:<rand>`.
// Insert-only, so two agents writing in the same second never overwrite each other (a single
// JSON list would be read-modify-write). Listing is a prefix match on the day; pruning deletes
// days older than the keep window by the same prefix order.

import { getSupabase } from "./persistence";
import { logger } from "./logger";

export type ActivityLevel = "info" | "fault";

export interface ActivityItem {
  /** ISO timestamp. */
  at: string;
  /** Which agent or module is speaking: "news", "ops", "storm", "newsletter"… */
  source: string;
  title: string;
  body?: string;
  level: ActivityLevel;
  /** Whether this entry also buzzed the phone (a heads-up or a fault). */
  pushed: boolean;
}

const TZ = process.env["TIMEZONE"] || "America/New_York";
const KEEP_DAYS = 14;

/** YYYY-MM-DD in Mark's zone — the day a brief reader means by "today". */
export function localDay(d: Date = new Date(), tz: string = TZ): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function activityKey(at: string, rand: string = Math.random().toString(36).slice(2, 6)): string {
  return `activity:${localDay(new Date(at))}:${at}:${rand}`;
}

export function normalizeActivity(item: Partial<ActivityItem> & { source: string; title: string }): ActivityItem {
  const at = item.at && !Number.isNaN(Date.parse(item.at)) ? new Date(item.at).toISOString() : new Date().toISOString();
  const body = (item.body ?? "").trim();
  return {
    at,
    source: item.source.trim().slice(0, 60) || "backend",
    title: item.title.trim().slice(0, 200) || "(untitled)",
    ...(body ? { body: body.slice(0, 1000) } : {}),
    level: item.level === "fault" ? "fault" : "info",
    pushed: Boolean(item.pushed),
  };
}

/** Record one entry. Never throws: a log that can take down its caller is worse than a gap. */
export async function logActivity(item: Partial<ActivityItem> & { source: string; title: string }): Promise<boolean> {
  const row = normalizeActivity(item);
  if (!process.env["SUPABASE_URL"]) {
    logger.debug({ title: row.title }, "activity: no store configured — entry not recorded");
    return false;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (getSupabase().from("platform_state") as any)
      .insert({ id: activityKey(row.at), payload: row, updated_at: row.at });
    if (error) {
      logger.warn({ error, title: row.title }, "activity: could not record");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, title: row.title }, "activity: could not record");
    return false;
  }
}

/** Today's entries (or a given local day), oldest first. */
export async function listActivity(day: string = localDay()): Promise<ActivityItem[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (getSupabase().from("platform_state") as any)
    .select("id,payload")
    .like("id", `activity:${day}:%`)
    .order("id", { ascending: true })
    .limit(300);
  if (error) {
    logger.warn({ error, day }, "activity: could not list");
    return [];
  }
  return ((data ?? []) as Array<{ payload: ActivityItem | null }>)
    .map((r) => r.payload)
    .filter((p): p is ActivityItem => Boolean(p && p.title));
}

/** Drop entries older than the keep window. Day keys sort lexically, so a prefix compare works. */
export async function pruneActivity(keepDays: number = KEEP_DAYS): Promise<number> {
  const cutoff = localDay(new Date(Date.now() - keepDays * 86_400_000));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (getSupabase().from("platform_state") as any)
    .delete()
    .like("id", "activity:%")
    .lt("id", `activity:${cutoff}`)
    .select("id");
  if (error) {
    logger.warn({ error }, "activity: prune failed");
    return 0;
  }
  const n = ((data ?? []) as unknown[]).length;
  if (n) logger.info({ pruned: n, cutoff }, "activity: pruned old entries");
  return n;
}
