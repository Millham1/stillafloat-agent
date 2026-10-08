// routes/social-analytics.ts — Facebook + Instagram analytics, fed by Make.
//
// Meta's developer-app gate is blocked for this account, so we can't mint our own
// Graph API token. Instead, Make (which already holds the authorized FB/IG
// connection used for posting) POSTs a stats snapshot to /api/social/ingest
// (routes/social.ts) every 12 hours, and the dashboard reads /api/social-analytics here.

import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken } from "../lib/http-auth";
import { readJson } from "../lib/persistence";
import { STATS_KEY, type StatsSnapshot } from "../lib/social-stats";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// The snapshots live in platform_state `social-stats` as the LIST that POST /api/social/ingest
// (routes/social.ts, the route that actually runs) appends to — { items: [{ at, facebook, instagram }] }.
// Until 2026-10-08 this file ALSO defined POST /api/social/ingest and read a single { latest, previous }
// object from the same key; Express served the first definition, so the panel's shape was never
// written and the dashboard said "No data yet" for a month (release gate ops.social-pulse-matches-stats).

type Snap = { followers?: number; reach?: number; username?: string; period_days?: number };
type Snapshot = StatsSnapshot & { facebook?: Snap; instagram?: Snap };
const PERIOD_DAYS = 28;

function trend(recent?: number, prior?: number): string {
  if (recent == null || prior == null) return "steady";
  if (prior <= 0) return recent > 0 ? "up" : "steady";
  const pct = (recent - prior) / prior;
  return pct > 0.10 ? "up" : pct < -0.10 ? "down" : "steady";
}

function pulse(cur: Snap, prev?: Snap) {
  return {
    connected: true,
    followers: cur.followers ?? null,
    recent_reach: cur.reach ?? null,
    prior_reach: prev?.reach ?? null,
    trend: trend(cur.reach, prev?.reach),
    new_followers: (cur.followers != null && prev?.followers != null) ? cur.followers - prev.followers : null,
    period_days: cur.period_days ?? PERIOD_DAYS,
    ...(cur.username ? { username: cur.username } : {}),
  };
}

/** The newest snapshot, and the newest one at least PERIOD_DAYS older than it (else the oldest). */
export function latestAndPrior(items: Snapshot[]): { latest: Snapshot | null; prior: Snapshot | null } {
  const sorted = [...items].filter((s) => s && typeof s.at === "string").sort((a, b) => a.at.localeCompare(b.at));
  const latest = sorted[sorted.length - 1] ?? null;
  if (!latest) return { latest: null, prior: null };
  const cutoff = Date.parse(latest.at) - PERIOD_DAYS * 86_400_000;
  const old = sorted.filter((s) => s !== latest && Date.parse(s.at) <= cutoff);
  const prior = old[old.length - 1] ?? (sorted.length > 1 ? sorted[0]! : null);
  return { latest, prior };
}

// Dashboard reads FB + IG pulse from the Make-fed snapshots.
router.get("/social-analytics", requireToken, async (_req: Request, res: Response) => {
  try {
    const store = await readJson<{ items?: Snapshot[] }>(STATS_KEY, { items: [] });
    const { latest, prior } = latestAndPrior(store.items ?? []);
    if (!latest) {
      const msg = "No data yet — the Make scenario hasn't posted a snapshot";
      res.json({ facebook: { connected: false, reason: msg }, instagram: { connected: false, reason: msg } });
      return;
    }
    res.json({
      updated_at: latest.at,
      facebook: latest.facebook ? pulse(latest.facebook, prior?.facebook) : { connected: false, reason: "no FB data" },
      instagram: latest.instagram ? pulse(latest.instagram, prior?.instagram) : { connected: false, reason: "no IG data" },
    });
  } catch (err) {
    logger.error({ err }, "social-analytics read failed");
    res.status(500).json({ facebook: { connected: false }, instagram: { connected: false } });
  }
});

export default router;
