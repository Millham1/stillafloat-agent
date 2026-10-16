// newsletter-editions.ts — the two editions are ONE issue. Pure (no I/O) so the rule is tested.
//
// Mark's standing rule (2026-10-08): he works in English only; every approved English item gets
// its Spanish twin automatically, and he is never asked about Spanish. The newsletter broke that:
// it nudged him per language and let either edition be sent alone. 2026-10-16 06:38Z the Spanish
// nudge landed on top, he pressed "Approve & Send" there, and the Spanish issue went to 8 readers
// a day and a half before he had seen the English one.
//
// From now on: approving English (or the Friday fallback) sends English AND Spanish; Spanish is
// never sent on its own. Mark 2026-10-16 07:30Z: "the ES site is a mirror of the EN site so it
// should be an identical ES newsletter… built from ES versions of commentary and news stories that
// already exist and it is just a build." So the Spanish edition is BUILT from the final English
// issue at send time — same stories (their Spanish versions), the Spanish commentary, his edited
// English text translated — never drafted as a separate issue.

export type EditionStatus = "pending" | "sending" | "sent";

export interface EditionState {
  status: EditionStatus;
  hasStories: boolean;
  generatedAt: string; // ISO
}

export type SpanishAction = "build-then-send" | "skip";

export interface WeeklySendPlan {
  sendEn: boolean;
  es: SpanishAction;
  /** Set when the plan sends nothing because the English issue cannot go: the caller tells Mark. */
  englishProblem?: "missing" | "stale" | "empty";
  reason: string;
}

/** A draft generated more than this long ago belongs to a previous week. */
export const ISSUE_MAX_AGE_MS = 8 * 86_400_000;

function fresh(e: EditionState | null, nowMs: number): e is EditionState {
  return !!e && nowMs - Date.parse(e.generatedAt) < ISSUE_MAX_AGE_MS;
}

/**
 * Decide what goes out when this week's issue is approved (by Mark on the English page, or by the
 * Friday fallback). `esHasSubscribers` is whether anyone confirmed is on the Spanish list.
 */
export function planWeeklySend(
  en: EditionState | null,
  es: EditionState | null,
  nowMs: number,
  esHasSubscribers: boolean,
): WeeklySendPlan {
  if (!en) return { sendEn: false, es: "skip", englishProblem: "missing", reason: "there is no English issue to approve" };
  if (!fresh(en, nowMs)) return { sendEn: false, es: "skip", englishProblem: "stale", reason: "the English draft is from a previous week" };
  if (en.status === "pending" && !en.hasStories) {
    return { sendEn: false, es: "skip", englishProblem: "empty", reason: "the English issue has no stories" };
  }
  const sendEn = en.status === "pending";
  // English is going (now, or already went this week) — Spanish follows it, never leads it.
  let esAction: SpanishAction;
  let why: string;
  if (!esHasSubscribers) {
    esAction = "skip"; why = "no confirmed Spanish subscribers";
  } else if (es && fresh(es, nowMs) && (es.status === "sending" || es.status === "sent")) {
    esAction = "skip"; why = "the Spanish edition already went out this week";
  } else {
    // Always rebuilt from the FINAL English issue, so Mark's edits carry over. A Spanish preview
    // built earlier in the week is just that — a preview.
    esAction = "build-then-send"; why = "the Spanish edition is built from the English issue and goes right behind it";
  }
  if (!sendEn && esAction === "skip") {
    return { sendEn: false, es: "skip", reason: `nothing to send: English already ${en.status}; ${why}` };
  }
  return { sendEn, es: esAction, reason: `${sendEn ? "English goes out" : `English already ${en.status}`}; ${why}` };
}

/** The sentence the Spanish page, the Spanish send route and the skipped nudge all use. */
export const SPANISH_FOLLOWS_ENGLISH =
  "The Spanish edition is a build of the English issue — the same stories in their Spanish versions, the Spanish commentary, and your letter translated — and goes out automatically right behind the English one. Nothing to approve here.";

/** Said when someone asks for a Spanish edition before there is an English issue to build it from. */
export const SPANISH_NEEDS_ENGLISH = "Draft the English issue first — the Spanish edition is built from it.";
