// actions.ts — the unified action queue (public.actions).
//
// One pipeline for everything that needs Mark's attention: an agent calls
// createAction() → one row + exactly one notification (via notifyMark). The
// brief renders pending rows with working inline buttons; resolving closes the
// row. Dedup: one PENDING row per (type, source_ref) — re-creating an action
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
  /** Extra notification tag (defaults to type+source_ref). */
  tag?: string;
  /**
   * "high" lets the notification fall through to email when push delivers
   * nothing. For FAULTS only — a review queue filling up is not a fault.
   */
  priority?: "high" | "normal";
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
  await notifyMark({
    title: a.title,
    body: a.body ?? "Open the brief to act.",
    tag: a.tag ?? `${a.type}-${a.source_ref ?? id}`,
    buttons: a.buttons ?? [],
    priority: a.priority ?? "normal",
  });
  return { created: true, id };
}

export async function listPendingActions(): Promise<ActionRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("actions").select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(30);
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
