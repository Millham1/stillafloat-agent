// routes/proposals.ts — the AI-proposed-change approval gate.
//
// Agents never file site/content changes as live tasks. They file them as tasks
// with status='proposed' (excluded from the active list) plus a public.actions row
// with Approve/Dismiss buttons that surface in Mark's morning brief. Approving
// promotes the task to 'open' (it enters his real list); dismissing drops it. Both
// clear the brief item. Token-gated exactly like the storm approve/dismiss buttons,
// so they fire straight from the brief. See saf-ops-manager/agent/proposals.py for
// the filing side, and lib/actions.ts for the queue.

import { Router, type IRouter, type Request, type Response } from "express";
import { getSupabase } from "../lib/persistence";
import { requireToken } from "../lib/http-auth";
import { resolveActionsForSource } from "../lib/actions";
import { logger } from "../lib/logger";

const router: IRouter = Router();

async function setProposalStatus(taskId: string, next: "open" | "dismissed"): Promise<void> {
  const supabase = getSupabase();
  const patch: Record<string, unknown> = { status: next };
  if (next === "open") patch["updated_at"] = new Date().toISOString();
  // Only flip while still 'proposed' — keeps re-clicks idempotent.
  const { error } = await supabase.from("tasks").update(patch).eq("id", taskId).eq("status", "proposed");
  if (error) throw new Error(error.message);
  await resolveActionsForSource("site_proposal", taskId, next === "open" ? "done" : "dismissed");
}

router.post("/proposals/:id/approve", requireToken, async (req: Request, res: Response) => {
  try {
    await setProposalStatus(req.params["id"] ?? "", "open");
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "proposal approve failed");
    res.status(500).json({ success: false, error: "Approve failed" });
  }
});

router.post("/proposals/:id/dismiss", requireToken, async (req: Request, res: Response) => {
  try {
    await setProposalStatus(req.params["id"] ?? "", "dismissed");
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "proposal dismiss failed");
    res.status(500).json({ success: false, error: "Dismiss failed" });
  }
});

export default router;
