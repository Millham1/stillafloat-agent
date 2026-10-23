// actions.ts — the unified action queue (public.actions).
//
// One pipeline for everything that needs Mark's attention: an agent calls
// createAction() → one row + the one "Waiting on you: N" notification (via
// notifyMark, kind "waiting"). The brief renders pending rows with working inline
// buttons; resolving closes the row. Dedup: one PENDING row per (type, source_ref) — re-creating an action
// for the same source while one is pending is a no-op (no notification spam).

import { getSupabase } from "./persistence";
import { logger } from "./logger";
import { notifyMark, type NotifyButton } from "./notify";

export interface ActionRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  buttons: NotifyButton[];
  status: string;
  source_ref: string | null;
  created_at: string;
}

export async function createAction(a: {
  type: string;
  title: string;
  body?: string;
  buttons?: NotifyButton[];
  source_ref?: string;
  /** Legacy; the "Waiting on you" notification carries one fixed tag now. */
  tag?: string;
  /**
   * "high" lets the notification fall through to email when push delivers
   * nothing. For FAULTS only — a review queue filling up is not a fault.
   * "lead": a customer waiting on Mark gets the same floor (2026-10-07).
   */
  priority?: "high" | "lead" | "normal";
}): Promise<{ created: boolean; id?: string }> {
  const supabase = getSupabase();

  // Dedup: skip if a pending action for this source already exists.
  if (a.source_ref) {
    const { data } = await supabase
      .from("actions").select("id")
      .eq("type", a.type).eq("source_ref", a.source_ref).eq("status", "pending")
      .limit(1);
    if ((data ?? []).length) return { created: false };
  }

  const { data, error } = await supabase
    .from("actions")
    .insert({
      type: a.type,
      title: a.title.slice(0, 200),
      body: a.body ?? null,
      buttons: (a.buttons ?? []) as unknown as object,
      source_ref: a.source_ref ?? null,
    })
    .select("id")
    .single();
  if (error) {
    logger.error({ error }, "createAction insert failed");
    return { created: false };
  }

  const id = (data as { id?: string } | null)?.id ?? "";
  // The row IS the waiting item. The notification is the one "Waiting on you: N" list,
  // recomputed live, which now includes this row (Mark, 2026-10-22).
  await notifyMark({
    kind: "waiting",
    source: a.type,
    title: a.title,
    body: a.body ?? "Open the brief to act.",
    buttons: a.buttons ?? [],
    priority: a.priority ?? "normal",
  });
  return { created: true, id };
}

export async function listPendingActions(): Promise<ActionRow[]> {
  const supabase = getSupabase();
  // Every pending action, newest first. Until 2026-10-08 this stopped at 30: with 54 waiting, a
  // storm all-clear from September fell off Mark's brief with no notice (release gate
  // editorial.action-queue-matches-its-sources). A long queue is a problem to show, not to hide.
  const { data, error } = await supabase
    .from("actions").select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`listPendingActions: ${error.message}`);
  return (data ?? []) as unknown as ActionRow[];
}

export async function resolveAction(id: string, status: "done" | "dismissed"): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("actions")
    .update({ status, resolved_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`resolveAction: ${error.message}`);
}

/** Close any pending action tied to a source (call from the underlying endpoint
 *  so acting via ANY surface — brief button, dashboard, notification — clears it). */
export async function resolveActionsForSource(type: string, sourceRef: string, status: "done" | "dismissed" = "done"): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("actions")
    .update({ status, resolved_at: new Date().toISOString() })
    .eq("type", type).eq("source_ref", sourceRef).eq("status", "pending");
  if (error) logger.warn({ error }, "resolveActionsForSource failed");
}

/**
 * Say the same waiting item better: rewrite the title (and body) of the PENDING action tied to a source. The "Waiting on you" list is recomputed from
 * the rows, so the item changes in place and Mark is not pinged twice for one person. Returns how many rows changed (0 when none is pending, and the
 * caller then makes a new item).
 */
export async function retitleActionsForSource(type: string, sourceRef: string, patch: { title: string; body?: string }): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getSupabase() as any;
  const { data, error } = await supabase
    .from("actions")
    .update({ title: patch.title.slice(0, 200), ...(patch.body !== undefined ? { body: patch.body } : {}) })
    .eq("type", type).eq("source_ref", sourceRef).eq("status", "pending")
    .select("id");
  if (error) {
    logger.warn({ error, type }, "retitleActionsForSource failed");
    return 0;
  }
  return ((data ?? []) as unknown[]).length;
}

/**
 * A fault that re-raises DAILY (push-health writes one row per day while the channel is
 * dead, so a dead day never hides behind yesterday's row) must not pile up: keep the
 * current row, expire every older pending row of the same family. 2026-10-23: the dev box,
 * which has no phone by design, had 55 pending "reaching nobody" rows going back 57 days.
 * Returns how many rows were expired.
 */
export async function expireSupersededActions(type: string, sourceRefPrefix: string, keepRef: string): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("actions")
    .update({ status: "expired", resolved_at: new Date().toISOString() })
    .eq("type", type).eq("status", "pending")
    .like("source_ref", `${sourceRefPrefix}%`)
    .neq("source_ref", keepRef)
    .select("id");
  if (error) {
    logger.warn({ error, type, sourceRefPrefix }, "expireSupersededActions failed");
    return 0;
  }
  return ((data ?? []) as unknown[]).length;
}

