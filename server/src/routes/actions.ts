// routes/actions.ts — the unified action queue API for the brief.
//   GET  /api/actions              → pending actions (token-gated)
//   POST /api/actions/:id/resolve  → { status: "done" | "dismissed" }
//   POST /api/actions              → file an action for Mark (token-gated)
//
// Mark, 2026-10-08: "If there is anything I need to accept or approve outside of a
// session it needs to go to the dashboard and a notification to me that I have
// something to do" — never a saved document. This is the one door for that: any
// agent or session files the decision here; createAction stores one row and sends
// exactly one notification (dedup per type+source_ref).

import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken } from "../lib/http-auth";
import { listPendingActions, resolveAction, createAction } from "../lib/actions";
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

router.post("/actions", requireToken, async (req: Request, res: Response) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof b["title"] === "string" ? b["title"].trim() : "";
    const type = typeof b["type"] === "string" && /^[a-z][a-z0-9_-]{1,40}$/i.test(b["type"]) ? b["type"] : "";
    if (title.length < 8 || !type) {
      res.status(400).json({ ok: false, error: "type (a short slug) and title (a sentence) are required" });
      return;
    }
    const body = typeof b["body"] === "string" ? b["body"].slice(0, 4000) : undefined;
    const buttons = Array.isArray(b["buttons"])
      ? (b["buttons"] as unknown[]).filter((x) => x && typeof x === "object" && typeof (x as { label?: unknown }).label === "string").slice(0, 4)
      : [];
    const out = await createAction({
      type, title, body,
      buttons: buttons as never,
      source_ref: typeof b["source_ref"] === "string" ? b["source_ref"].slice(0, 120) : undefined,
      priority: b["priority"] === "high" ? "high" : "normal",
    });
    res.status(out.created ? 201 : 200).json({ ok: true, ...out });
  } catch (err) {
    logger.error({ err }, "POST /actions failed");
    res.status(500).json({ ok: false, error: "Failed to file the action" });
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
