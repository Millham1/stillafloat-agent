// ai-visibility.ts — the dashboard's AI Visibility page: what the AI assistants
// read of the site, and what the agent did about it (lib/ai-visibility.ts).
//
//   GET  /api/ai-visibility           the whole platform_state "ai-visibility" payload
//   POST /api/ai-visibility/activity  log one thing the agent did; newest first, 500 kept
//
// Both token-gated with the fail-closed requireToken. The measurements are written
// by a separate job; this route never touches them — POST reads the row, swaps in
// the new activity list and writes the rest back as it found it.

import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken } from "../lib/http-auth";
import { PATHS, readJson, writeJson } from "../lib/persistence";
import { logger } from "../lib/logger";
import { prependActivity, validateActivity, type AiVisibilityPayload } from "../lib/ai-visibility";

const router: IRouter = Router();

router.get("/ai-visibility", requireToken, async (_req: Request, res: Response) => {
  try {
    const payload = await readJson<AiVisibilityPayload>(PATHS.aiVisibility, {});
    res.json({ success: true, ...payload });
  } catch (err) {
    logger.error({ err }, "GET /ai-visibility failed");
    res.status(500).json({ success: false, error: "Failed to load AI visibility data" });
  }
});

router.post("/ai-visibility/activity", requireToken, async (req: Request, res: Response) => {
  const check = validateActivity(req.body);
  if (!check.ok) {
    res.status(400).json({ success: false, error: check.error });
    return;
  }
  try {
    // readJson throws on a failed read (never returns the fallback), so a
    // Supabase blip cannot rebuild the row from {} and erase the measurements.
    const payload = await readJson<AiVisibilityPayload>(PATHS.aiVisibility, {});
    await writeJson(PATHS.aiVisibility, { ...payload, activity: prependActivity(payload.activity, check.entry) });
    res.json({ success: true, entry: check.entry });
  } catch (err) {
    logger.error({ err }, "POST /ai-visibility/activity failed");
    res.status(500).json({ success: false, error: "Failed to save the activity entry" });
  }
});

export default router;
