// routes/go.ts — first-party affiliate click redirect (Mark's decision 2026-09-09:
// "build the click tracking" — no third-party analytics script; our own server
// logs the click and sends the shopper to the exact tagged Amazon URL so the
// commission is unchanged).
//
// GET /api/go/:itemId  → 302 to the item's Amazon URL (tag guaranteed), logging
//                         the click fire-and-forget first (never delays or fails
//                         the redirect — a shopper's click-through matters more
//                         than one missed row).
// GET /api/affiliate/clicks?days=28 → token-gated reporting for the dashboard.
//
// getItemMap/logClick are injectable (GoRouterDeps) so tests never touch
// Supabase — same dependency-injection pattern as lib/push-health.ts.

import { Router, type IRouter, type Request, type Response } from "express";
import { PATHS, readJson } from "../lib/persistence";
import { requireToken } from "../lib/http-auth";
import { logger } from "../lib/logger";
import {
  ensureAffiliateTag,
  isBotUA,
  hashUA,
  hashIp,
  logAffiliateClick,
  fetchClickReport,
  type ClickInput,
} from "../lib/affiliate-clicks";
import type { AffiliateItem } from "./affiliate";

const CACHE_MS = 10 * 60 * 1000;
const RATE_LIMIT_PER_MIN = 60;
const RATE_WINDOW_MS = 60_000;

export interface GoRouterDeps {
  getItemMap: () => Promise<Map<string, AffiliateItem>>;
  logClick: (input: ClickInput) => Promise<void>;
}

async function loadItemMap(): Promise<Map<string, AffiliateItem>> {
  const store = await readJson<{ items?: AffiliateItem[] }>(PATHS.affiliateItems, { items: [] });
  const byId = new Map<string, AffiliateItem>();
  for (const item of store.items ?? []) byId.set(item.id, item);
  return byId;
}

// Module-level cache shared by every real (non-test) mount of this router —
// a test-injected getItemMap bypasses this entirely.
let cached: { at: number; byId: Map<string, AffiliateItem> } | null = null;
async function cachedGetItemMap(): Promise<Map<string, AffiliateItem>> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.byId;
  const byId = await loadItemMap();
  cached = { at: Date.now(), byId };
  return byId;
}

export const defaultGoRouterDeps: GoRouterDeps = {
  getItemMap: cachedGetItemMap,
  logClick: logAffiliateClick,
};

/** The plain URL to send the shopper to, tag guaranteed. Empty if the item has none. */
function targetUrlFor(item: AffiliateItem): string {
  const smart = (item.smartStrip || "").trim();
  const raw = /^https?:\/\//i.test(smart) ? smart : (item.affiliateLink || "").trim();
  return raw ? ensureAffiliateTag(raw) : "";
}

function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0]!.trim();
  return req.socket?.remoteAddress || "unknown";
}

export function createGoRouter(deps: GoRouterDeps = defaultGoRouterDeps): IRouter {
  const router: IRouter = Router();

  // In-memory rate limiter, same shape as routes/subscribe.ts. It only caps
  // LOGGING volume — a rate-limited or bot request still gets its 302. The
  // redirect must never fail just because we're capping how many rows a
  // script can write.
  const rateMap = new Map<string, { count: number; resetAt: number }>();
  function isRateLimited(ipHash: string): boolean {
    const now = Date.now();
    const entry = rateMap.get(ipHash);
    if (!entry || now > entry.resetAt) {
      rateMap.set(ipHash, { count: 1, resetAt: now + RATE_WINDOW_MS });
      return false;
    }
    if (entry.count >= RATE_LIMIT_PER_MIN) return true;
    entry.count++;
    return false;
  }

  router.get("/go/:itemId", async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const itemId = String(req.params["itemId"] || "");

    let byId: Map<string, AffiliateItem>;
    try {
      byId = await deps.getItemMap();
    } catch (err) {
      logger.error({ err }, "go: item lookup failed");
      res.status(404).send("Not found");
      return;
    }

    const item = byId.get(itemId);
    const targetUrl = item ? targetUrlFor(item) : "";
    if (!item || !targetUrl) {
      res.status(404).send("Not found");
      return;
    }

    const ua = String(req.headers["user-agent"] || "");
    const bot = isBotUA(ua);
    const ipHash = hashIp(clientIp(req));

    if (!bot && !isRateLimited(ipHash)) {
      const pageParam = req.query["p"];
      const langParam = req.query["l"];
      const referrer = String(req.headers["referer"] || req.headers["referrer"] || "");
      // Fire-and-forget: NEVER awaited, NEVER lets a logging failure touch the
      // redirect below.
      deps
        .logClick({
          itemId: item.id,
          category: item.category,
          page: typeof pageParam === "string" ? pageParam : undefined,
          lang: typeof langParam === "string" ? langParam : undefined,
          referrer,
          uaHash: hashUA(ua),
          ipHash,
        })
        .catch((err) => logger.warn({ err, itemId: item.id }, "affiliate click log failed"));
    }

    res.redirect(302, targetUrl);
  });

  router.get("/affiliate/clicks", requireToken, async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    try {
      const daysParam = Number(req.query["days"]);
      const days = Number.isFinite(daysParam) && daysParam > 0 ? daysParam : 28;
      const report = await fetchClickReport(days);
      res.json({ success: true, days, ...report });
    } catch (err) {
      logger.error({ err }, "affiliate clicks report failed");
      res.status(500).json({ success: false, error: "failed to load report" });
    }
  });

  return router;
}

export default createGoRouter();
