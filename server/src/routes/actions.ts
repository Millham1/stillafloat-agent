// routes/actions.ts — the unified action queue API for the brief.
//   GET  /api/actions              → pending actions (token-gated)
//   POST /api/actions/:id/resolve  → { status: "done" | "dismissed" }

import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken } from "../lib/http-auth";
import { listPendingActions, resolveAction } from "../lib/actions";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/actions", requireToken, async (_req: Request, res: Response) => {
  try {
    res.json({ ok: true, actions: await listPendingActions() });
  } catch (err) {
    logger.error({ err }, "GET /actions failed");
    res.status(500).json({ ok: false, error: "Failed to load actions" });
  }
});

router.post("/actions/:id/resolve", requireToken, async (req: Request, res: Response) => {
  try {
    const status = req.body?.status === "dismissed" ? "dismissed" : "done";
    await resolveAction(req.params["id"] ?? "", status);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "resolve action failed");
    res.status(500).json({ ok: false, error: "Failed to resolve" });
  }
});

export default router;
