// lib/affiliate-clicks.ts — first-party affiliate click tracking (Mark's decision
// 2026-09-09: no third-party analytics script; our own server logs the click and
// the /api/go/:itemId redirect sends the shopper straight to the tagged Amazon URL
// so the commission is unchanged). Pure helpers here are the tested surface; the
// two functions that talk to Supabase (logAffiliateClick, fetchClickReport) are
// thin I/O wrappers, same split as the rest of this codebase (persistence.ts).

import crypto from "node:crypto";
import { getSupabase } from "./persistence";
import { logger } from "./logger";

export const AMAZON_AFFILIATE_TAG = "stillafloatcr-20";

// ── Bot / crawler detection ─────────────────────────────────────────────────
// Bots still get redirected (never break a preview crawler or an ad-network
// fetch), they just don't inflate the click count.
const BOT_UA_RE = /bot|crawl|spider|preview|facebookexternalhit/i;
export function isBotUA(ua: string | undefined | null): boolean {
  return BOT_UA_RE.test(ua || "");
}

// ── Privacy hashing ──────────────────────────────────────────────────────────
// ua_hash: sha256 of the user-agent — never the raw UA.
// ip_hash: sha256 of the ip + a salt that rotates every UTC calendar day, so an
// ip_hash from today can never be correlated with the same visitor tomorrow,
// while still deduping/rate-limiting repeat clicks WITHIN a day.
export function hashUA(ua: string | undefined | null): string {
  return crypto.createHash("sha256").update(ua || "").digest("hex");
}

export function dailySalt(now: Date = new Date()): string {
  const secret = process.env["AFFILIATE_CLICK_SALT"] || "still-afloat-affiliate-click-v1";
  const day = now.toISOString().slice(0, 10); // UTC calendar day, e.g. 2026-09-09
  return crypto.createHash("sha256").update(`${secret}:${day}`).digest("hex");
}

export function hashIp(ip: string | undefined | null, now: Date = new Date()): string {
  return crypto.createHash("sha256").update(`${ip || "unknown"}:${dailySalt(now)}`).digest("hex");
}

// ── Amazon tag guarantee ─────────────────────────────────────────────────────
// The commission depends entirely on this tag surviving the redirect. If the
// stored URL already carries the CORRECT tag, leave it byte-for-byte alone;
// if it's missing or wrong, fix it rather than silently losing the commission.
export function ensureAffiliateTag(rawUrl: string, tag: string = AMAZON_AFFILIATE_TAG): string {
  if (!rawUrl) return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (u.searchParams.get("tag") === tag) return rawUrl;
    u.searchParams.set("tag", tag);
    return u.toString();
  } catch {
    // Not a parseable absolute URL — fall back to a plain string append/replace
    // so a malformed but tag-bearing link doesn't get a second tag= appended.
    if (new RegExp(`(?:\\?|&)tag=${tag}(?:&|$)`).test(rawUrl)) return rawUrl;
    const withoutTag = rawUrl.replace(/([?&])tag=[^&]*(&?)/, (_m, lead, trail) => (trail ? lead : ""));
    const sep = withoutTag.includes("?") ? "&" : "?";
    return `${withoutTag}${sep}tag=${tag}`;
  }
}

// ── Writing a click (fire-and-forget from the route) ────────────────────────
export interface ClickInput {
  itemId: string;
  category?: string | undefined;
  page?: string | undefined;
  lang?: string | undefined;
  referrer?: string | undefined;
  uaHash: string;
  ipHash: string;
}

export async function logAffiliateClick(input: ClickInput): Promise<void> {
  const client = getSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (client.from("affiliate_clicks") as any).insert({
    item_id: input.itemId,
    category: input.category || null,
    page: input.page || null,
    lang: input.lang || null,
    referrer: input.referrer || null,
    ua_hash: input.uaHash,
    ip_hash: input.ipHash,
  });
  if (error) {
    logger.warn({ err: error, itemId: input.itemId }, "affiliate_clicks insert failed");
    throw error;
  }
}

// ── Reporting: pure aggregation over raw rows ────────────────────────────────
export interface ClickRow {
  item_id: string;
  category?: string | null;
  page?: string | null;
  clicked_at: string; // ISO timestamp
}

export interface ClickReport {
  total: number;
  byItem: Array<{ item_id: string; count: number }>;
  byPage: Array<{ page: string; count: number }>;
  byDay: Array<{ day: string; count: number }>;
}

export function aggregateClicks(rows: ClickRow[]): ClickReport {
  const byItem = new Map<string, number>();
  const byPage = new Map<string, number>();
  const byDay = new Map<string, number>();
  for (const row of rows) {
    byItem.set(row.item_id, (byItem.get(row.item_id) ?? 0) + 1);
    const page = row.page || "unknown";
    byPage.set(page, (byPage.get(page) ?? 0) + 1);
    const day = String(row.clicked_at).slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const byCount = (a: [string, number], b: [string, number]) => b[1] - a[1];
  return {
    total: rows.length,
    byItem: [...byItem.entries()].sort(byCount).map(([item_id, count]) => ({ item_id, count })),
    byPage: [...byPage.entries()].sort(byCount).map(([page, count]) => ({ page, count })),
    byDay: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, count]) => ({ day, count })),
  };
}

export async function fetchClickReport(days = 28): Promise<ClickReport> {
  const client = getSupabase();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (client.from("affiliate_clicks") as any)
    .select("item_id, category, page, clicked_at")
    .gte("clicked_at", since);
  if (error) {
    logger.error({ err: error }, "affiliate_clicks query failed");
    throw error;
  }
  return aggregateClicks((data ?? []) as ClickRow[]);
}

/** Best-effort 28-day total for the daily brief — never throws, never blocks it. */
export async function recentClickTotal(days = 28): Promise<number> {
  try {
    const report = await fetchClickReport(days);
    return report.total;
  } catch (err) {
    logger.warn({ err }, "affiliate_clicks: brief total unavailable");
    return 0;
  }
}
