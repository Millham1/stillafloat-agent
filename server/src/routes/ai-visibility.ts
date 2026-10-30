// ai-visibility.ts — the dashboard's AI Visibility page: what the AI assistants
// read of the site, and what the agent did about it (lib/ai-visibility.ts).
//
//   GET  /api/ai-visibility                   the whole platform_state "ai-visibility" payload
//   POST /api/ai-visibility/activity          log one thing the agent did; newest first, 500 kept.
//                                             status "waiting-on-mark" needs buttons and files the
//                                             same item in the action queue (brief + notification).
//   POST /api/ai-visibility/activity/update   change one stored item: {actionId|title, status?,
//                                             detail?, note?, buttons?, remove?}. Leaving "waiting-on-mark"
//                                             closes its action row (declined → dismissed); remove
//                                             retracts the line (and dismisses its row).
//   POST /api/ai-visibility/prompt-tests/:on  on|off — Mark's switch for the paid weekly prompt
//                                             tests (the Python job reads promptTests.wanted).
//
// All token-gated with the fail-closed requireToken. The measurements are written
// by a separate job; this route never touches them — every POST reads the row, swaps
// in what it changed and writes the rest back as it found it.
//
// Mark, 2026-10-29, on two "Waiting on you" rows with nothing to press: "There is
// nothing here that takes me to an action." A waiting item is an action: it carries
// buttons, the brief shows the same buttons, and pressing one does the thing.

import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken } from "../lib/http-auth";
import { PATHS, readJson, writeJson } from "../lib/persistence";
import { logger } from "../lib/logger";
import { createAction, findPendingActionId, resolveAction } from "../lib/actions";
import {
  ACTIVITY_STATUSES, activitySourceRef, patchActivity, prependActivity, validateActivity, validateButtons,
  type ActivityButton, type ActivityEntry, type ActivityStatus, type AiVisibilityPayload,
} from "../lib/ai-visibility";

const router: IRouter = Router();
const ACTION_TYPE = "ai-visibility";

/** File the waiting item in the action queue; returns the row id (new or the pending one). */
async function fileAction(entry: ActivityEntry): Promise<string | undefined> {
  const source_ref = activitySourceRef(entry.title);
  const out = await createAction({
    type: ACTION_TYPE, title: entry.title, body: entry.detail || undefined,
    buttons: entry.buttons ?? [], source_ref,
  });
  return out.id ?? (await findPendingActionId(ACTION_TYPE, source_ref));
}

async function closeAction(entry: ActivityEntry, status: ActivityStatus): Promise<void> {
  if (!entry.actionId) return;
  try {
    await resolveAction(entry.actionId, status === "declined" ? "dismissed" : "done");
  } catch (err) {
    logger.warn({ err, actionId: entry.actionId }, "ai-visibility: could not close the action row");
  }
}

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
    const entry = check.entry;
    if (entry.status === "waiting-on-mark") {
      const id = await fileAction(entry);
      if (id) entry.actionId = id;
    }
    // readJson throws on a failed read (never returns the fallback), so a
    // Supabase blip cannot rebuild the row from {} and erase the measurements.
    const payload = await readJson<AiVisibilityPayload>(PATHS.aiVisibility, {});
    await writeJson(PATHS.aiVisibility, { ...payload, activity: prependActivity(payload.activity, entry) });
    res.json({ success: true, entry });
  } catch (err) {
    logger.error({ err }, "POST /ai-visibility/activity failed");
    res.status(500).json({ success: false, error: "Failed to save the activity entry" });
  }
});

router.post("/ai-visibility/activity/update", requireToken, async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const actionId = typeof b["actionId"] === "string" ? b["actionId"].trim() : "";
  const title = typeof b["title"] === "string" ? b["title"].trim() : "";
  if (!actionId && !title) {
    res.status(400).json({ success: false, error: "actionId or title is required" });
    return;
  }
  let status: ActivityStatus | undefined;
  if (b["status"] != null) {
    if (typeof b["status"] !== "string" || !(ACTIVITY_STATUSES as readonly string[]).includes(b["status"])) {
      res.status(400).json({ success: false, error: `status must be one of: ${ACTIVITY_STATUSES.join(", ")}` });
      return;
    }
    status = b["status"] as ActivityStatus;
  }
  const buttons = validateButtons(b["buttons"]);
  if (!buttons.ok) {
    res.status(400).json({ success: false, error: buttons.error });
    return;
  }
  const detail = typeof b["detail"] === "string" ? b["detail"] : undefined;
  const note = typeof b["note"] === "string" && b["note"].trim() ? b["note"].trim().slice(0, 1000) : undefined;
  try {
    const payload = await readJson<AiVisibilityPayload>(PATHS.aiVisibility, {});
    const remove = b["remove"] === true;
    const patch = { status, detail, note, buttons: b["buttons"] != null ? buttons.buttons : undefined, remove };
    const { list, entry, before } = patchActivity(payload.activity, actionId ? { actionId } : { title }, patch);
    if (!entry || !before) {
      res.status(404).json({ success: false, error: "no activity item matches" });
      return;
    }
    if (remove) {
      if (before.status === "waiting-on-mark") await closeAction(before, "declined");
      await writeJson(PATHS.aiVisibility, { ...payload, activity: list });
      res.json({ success: true, removed: before });
      return;
    }
    if (entry.status === "waiting-on-mark") {
      const btns: ActivityButton[] = entry.buttons ?? [];
      if (!btns.length) {
        res.status(400).json({ success: false, error: "an item that waits on Mark must carry at least one button" });
        return;
      }
      if (!entry.actionId) {
        const id = await fileAction(entry);
        if (id) entry.actionId = id;
      }
    } else if (before.status === "waiting-on-mark") {
      await closeAction(before, entry.status);
    }
    const idx = list.findIndex((e) => e === entry);
    if (idx >= 0) list[idx] = entry;
    await writeJson(PATHS.aiVisibility, { ...payload, activity: list });
    res.json({ success: true, entry });
  } catch (err) {
    logger.error({ err }, "POST /ai-visibility/activity/update failed");
    res.status(500).json({ success: false, error: "Failed to update the activity item" });
  }
});

router.post("/ai-visibility/prompt-tests/:choice", requireToken, async (req: Request, res: Response) => {
  const choice = req.params["choice"];
  if (choice !== "on" && choice !== "off") {
    res.status(400).json({ success: false, error: "choice must be on or off" });
    return;
  }
  const wanted = choice === "on";
  try {
    const payload = await readJson<AiVisibilityPayload>(PATHS.aiVisibility, {});
    const pt = { ...(payload.promptTests ?? {}), wanted };
    // Close every waiting prompt-test item and say what happened on it.
    let list = Array.isArray(payload.activity) ? [...payload.activity] : [];
    const note = wanted
      ? "Turned on by Mark from the dashboard. First run on the next daily measurement, then once a week."
      : "Mark pressed Not now. Nothing is spent; the switch stays on the dashboard.";
    for (const e of list) {
      if (e?.kind === "prompt-test" && e.status === "waiting-on-mark") {
        const r = patchActivity(list, e.actionId ? { actionId: e.actionId } : { title: e.title },
          { status: wanted ? "done" : "declined", note });
        if (r.entry && r.before) {
          list = r.list;
          await closeAction(r.before, r.entry.status);
        }
      }
    }
    const logged: ActivityEntry = {
      at: new Date().toISOString(), kind: "prompt-test", status: wanted ? "done" : "declined",
      title: wanted ? "Weekly prompt tests turned on" : "Weekly prompt tests left off",
      detail: wanted
        ? "Mark's OK from the dashboard. The job asks ChatGPT, Claude and Perplexity the fixed questions once a week and records whether Mark or the site is named; the row carries the dollar note."
        : "Mark pressed Not now on the dashboard.",
    };
    await writeJson(PATHS.aiVisibility, { ...payload, promptTests: pt, activity: prependActivity(list, logged) });
    res.json({ success: true, wanted });
  } catch (err) {
    logger.error({ err }, "POST /ai-visibility/prompt-tests failed");
    res.status(500).json({ success: false, error: "Failed to change the prompt-test switch" });
  }
});

export default router;
