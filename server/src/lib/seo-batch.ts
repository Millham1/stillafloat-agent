// seo-batch.ts — what Mark's answer to a "Search batch" means for each task in it.
//
// The ops-manager's search worker (saf-ops-manager agent/seo_worker.py) cleans the
// search loop's task list every three days and files ONE proposal carrying the best
// few tasks:
//
//   { "type": "seo-batch", "filed_by": "seo-worker",
//     "items": [ { "taskId": "<tasks.id>", "title": "…", "kind": "wording|links|content|code|google",
//                  "worth": 1-5, "action"?: { "type": "seo-override", … } } ],
//     "scorecard": { … } }
//
// Why a batch (Mark, 2026-11-15): the loop had filed 37 tasks in six weeks. His
// 2026-09-14 rule says an agent-filed task needs his approval before anything
// visible changes; on 2026-09-28 those tasks were taken off his brief; nothing
// carried them out. One batch is one decision in his "Waiting on you" queue.
//
// APPROVE, per item:
//   · an item with a story-page override ("action") is applied now, through the same
//     executor a single approved proposal uses, and its task is closed with the
//     old → new audit note;
//   · every other item (and an override whose story cannot be found) stays open and
//     is stamped approved by Mark — the approval his 2026-09-14 rule asks for — so it
//     can be built and shipped through dev like any task he put on the list.
// DISMISS: every item's task is closed, so the worker does not offer it again.
//
// This file is the pure part (shape check, per-item decision, the note written on
// the batch); routes/proposals.ts does the database writes.

import { isSeoOverridePayload, type SeoOverridePayload } from "./seo-executor";

export interface SeoBatchItem {
  taskId: string;
  title: string;
  kind?: string;
  worth?: number;
  action?: SeoOverridePayload;
}

export interface SeoBatchPayload {
  type: "seo-batch";
  items: SeoBatchItem[];
  filed_by?: string;
  scorecard?: Record<string, unknown>;
}

export function isSeoBatchPayload(p: unknown): p is SeoBatchPayload {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  if (o["type"] !== "seo-batch" || !Array.isArray(o["items"]) || o["items"].length === 0) return false;
  return o["items"].every((it) => {
    if (!it || typeof it !== "object") return false;
    const i = it as Record<string, unknown>;
    return typeof i["taskId"] === "string" && i["taskId"].trim() !== "" && typeof i["title"] === "string";
  });
}

/** What approving does to one item, given the task as it stands now. */
export type ItemStep =
  | { step: "apply"; action: SeoOverridePayload } // write the override, close the task
  | { step: "approve" } // stamp approved-by-Mark, leave open to be built
  | { step: "skip"; reason: string }; // the task moved on since the batch was filed

export function planItem(item: SeoBatchItem, task: { status?: string | null } | null | undefined): ItemStep {
  if (!task) return { step: "skip", reason: "the task no longer exists" };
  if (task.status !== "open") return { step: "skip", reason: `the task is already ${task.status ?? "closed"}` };
  if (item.action && isSeoOverridePayload(item.action)) return { step: "apply", action: item.action };
  return { step: "approve" };
}

export interface ItemOutcome {
  title: string;
  /** applied = live on the site now; approved = approved, to be built; skipped = nothing done. */
  result: "applied" | "approved" | "skipped";
  note?: string;
}

/** The note appended to the batch task when Mark approves it. Plain sentences, one line per item. */
export function batchApprovalNote(outcomes: ItemOutcome[], day: string): string {
  const count = (r: ItemOutcome["result"]): number => outcomes.filter((o) => o.result === r).length;
  const head =
    `[approved ${day}] ${count("applied")} applied to the site now, ` +
    `${count("approved")} approved to be built` +
    (count("skipped") ? `, ${count("skipped")} skipped` : "") +
    ".";
  const lines = outcomes.map((o) => {
    const what = o.result === "applied" ? "Applied" : o.result === "approved" ? "Approved to build" : "Skipped";
    return `- ${what}: ${o.title}${o.note ? ` (${o.note})` : ""}`;
  });
  return [head, ...lines].join("\n");
}

/** The line written on each task Mark approved or dismissed through a batch. */
export function itemNote(kind: "approved" | "dismissed", day: string, batchTitle: string): string {
  return kind === "approved"
    ? `[approved by Mark ${day}] Approved in "${batchTitle}". To be built and shipped through dev.`
    : `[dismissed by Mark ${day}] Dismissed in "${batchTitle}". Not to be offered again.`;
}
