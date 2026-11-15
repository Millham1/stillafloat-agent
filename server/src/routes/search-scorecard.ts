// search-scorecard.ts — the dashboard Search page's scorecard and synopsis.
//
//   GET /api/search-scorecard   four tiles (times shown in Google, clicks, hub and guide
//                               pages Google holds, newest stories fetched), how each moved
//                               since the last run, the plain synopsis, and what is waiting.
//
// Mark, 2026-11-15: "put the scorecard on my dashboard and a synopsis of what the results
// mean." Written every three days by the ops-manager's search worker into platform_state
// "seo-worker"; this route only reads that row (lib/search-scorecard.ts shapes it).
// Token-gated with the fail-closed requireToken, like every dashboard data address.

import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken } from "../lib/http-auth";
import { PATHS, readJson } from "../lib/persistence";
import { logger } from "../lib/logger";
import { scorecardView, type SeoWorkerState } from "../lib/search-scorecard";

const router: IRouter = Router();

router.get("/search-scorecard", requireToken, async (_req: Request, res: Response) => {
  try {
    const state = await readJson<SeoWorkerState>(PATHS.seoWorker, {});
    res.json({ success: true, ...scorecardView(state) });
  } catch (err) {
    logger.error({ err }, "GET /search-scorecard failed");
    res.status(500).json({ success: false, error: "Could not read the search scorecard" });
  }
});

export default router;
