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

// ── Task CLOSURE proposals ───────────────────────────────────────────────────
// Nothing in the stack ever closed a task: 'done' was only ever READ (to avoid
// recreating finished work), never written. So the list only grew and Mark's
// brief filled with work that shipped weeks ago. The closer proposes candidates
// rather than auto-closing them — closing work that isn't actually finished is
// worse than a list that runs slightly long (Mark's call, 2026-08-09).
//
// Close = the work is done. Keep = still live; bumping updated_at also stops the
// closer re-proposing it on the next pass.
async function resolveClosure(taskId: string, close: boolean): Promise<void> {
  const supabase = getSupabase();
  const patch: Record<string, unknown> = close
    ? { status: "done", done_at: new Date().toISOString() }
    : { updated_at: new Date().toISOString() };
  // Only act while still open — keeps re-clicks idempotent.
  const { error } = await supabase
    .from("tasks")
    .update(patch)
    .eq("id", taskId)
    .in("status", ["open", "in_progress"]);
  if (error) throw new Error(error.message);
  await resolveActionsForSource("task_closure", taskId, close ? "done" : "dismissed");
}

router.post("/tasks/:id/close", requireToken, async (req: Request, res: Response) => {
  try {
    await resolveClosure(req.params["id"] ?? "", true);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "task close failed");
    res.status(500).json({ success: false, error: "Close failed" });
  }
});

router.post("/tasks/:id/keep", requireToken, async (req: Request, res: Response) => {
  try {
    await resolveClosure(req.params["id"] ?? "", false);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "task keep failed");
    res.status(500).json({ success: false, error: "Keep failed" });
  }
});

export default router;
