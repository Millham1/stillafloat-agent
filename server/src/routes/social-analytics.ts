// routes/social-analytics.ts — Facebook + Instagram analytics, fed by Make.
//
// Meta's developer-app gate is blocked for this account, so we can't mint our own
// Graph API token. Instead, Make (which already holds the authorized FB/IG
// connection used for posting) POSTs a stats snapshot to /api/social/ingest on a
// schedule, and the dashboard reads /api/social-analytics. No Graph token here.

import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken } from "../lib/http-auth";
import { readJson, writeJson } from "../lib/persistence";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const SOCIAL_KEY = "social-stats";

type Snap = { followers?: number; reach?: number; username?: string; period_days?: number };
type Stored = {
  latest?: { facebook?: Snap; instagram?: Snap; updated_at?: string };
  previous?: { facebook?: Snap; instagram?: Snap } | null;
};

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
    period_days: cur.period_days ?? 28,
    ...(cur.username ? { username: cur.username } : {}),
  };
}

// Make posts the latest FB+IG snapshot here (token-gated). Shape:
// { "facebook": {"followers": N, "reach": N}, "instagram": {"username":"..","followers": N,"reach": N} }
router.post("/social/ingest", requireToken, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { facebook?: Snap; instagram?: Snap };
    const prev = await readJson<Stored>(SOCIAL_KEY, {});
    await writeJson(SOCIAL_KEY, {
      latest: { ...body, updated_at: new Date().toISOString() },
      previous: prev.latest ?? null,
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "social ingest failed");
    res.status(500).json({ ok: false, error: "ingest failed" });
  }
});

// Dashboard reads FB + IG pulse from the Make-fed snapshot.
router.get("/social-analytics", requireToken, async (_req: Request, res: Response) => {
  try {
    const payload = await readJson<Stored>(SOCIAL_KEY, {});
    const latest = payload.latest;
    if (!latest) {
      const msg = "No data yet — the Make scenario hasn't posted a snapshot";
      res.json({ facebook: { connected: false, reason: msg }, instagram: { connected: false, reason: msg } });
      return;
    }
    const prev = payload.previous ?? {};
    res.json({
      updated_at: latest.updated_at,
      facebook: latest.facebook ? pulse(latest.facebook, prev.facebook) : { connected: false, reason: "no FB data" },
      instagram: latest.instagram ? pulse(latest.instagram, prev.instagram) : { connected: false, reason: "no IG data" },
    });
  } catch (err) {
    logger.error({ err }, "social-analytics read failed");
    res.status(500).json({ facebook: { connected: false }, instagram: { connected: false } });
  }
});

export default router;
