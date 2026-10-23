// notify.ts — THE single notification channel to Mark. Every agent calls notifyMark();
// nothing else may push/email/DM him.
//
// TWO SHAPES ON THE PHONE (Mark, 2026-10-22 — "multiple brief alerts for different topics,
// and none of them tie to each other"; 12 pushes on Oct 22 from four agents in eight styles):
//
//   kind "waiting"   → ONE notification, "Waiting on you: N", same tag always, updated in
//                      place, body = what is waiting, opens the brief. The caller's text is
//                      NOT pushed: the list is recomputed live (lib/waiting.ts) and a push goes
//                      out only when something NEW joined it. This is the only shape that asks
//                      for a decision.
//   kind "headsup"   → "Heads-up: …" — a buzz with no decision: a meeting in 90 minutes.
//   kind "fault"     → "Heads-up: ⚠️ …" — an agent cannot do its job (AI unreachable, scan
//                      produced nothing, push channel dead). Own tag so a meeting reminder
//                      never replaces it; email floor when no device hears it.
//   kind "activity"  → NO push. Recorded for the brief's "What the agents did today".
//
// Everything that is not a waiting trigger is also recorded in the activity log, pushed or
// not, so the brief page is the complete record and the phone is quiet.
//
// Tiers for the pushing kinds: self-hosted ntfy when configured (NTFY_URL/NTFY_TOPIC), else
// in-house Web Push; email (ops-manager Gmail sender) is the floor for FAULTS and LEADS only —
// "never silently fail" must not become "email me 14 times a day" (2026-08-26).
//
// Env: NTFY_URL, NTFY_TOPIC, NTFY_TOKEN (optional bearer), DASHBOARD_URL, OWNER_EMAIL,
//      DISABLE_NOTIFY_EMAIL=1 (dev: never email Mark from this box).

import { logger } from "./logger";
import { sendPush } from "./push";
import { sendMail } from "./mailer";
import { logActivity } from "./activity";
import type { WaitingPushResult } from "./waiting-core";

export type NotifyKind = "waiting" | "headsup" | "fault" | "activity";
export const NOTIFY_KINDS: readonly NotifyKind[] = ["waiting", "headsup", "fault", "activity"];

export const WAITING_TAG = "waiting-on-you";
export const HEADSUP_TAG = "heads-up";
export const FAULT_TAG = "heads-up-fault";

export interface NotifyButton {
  label: string;
  method?: string; // GET | POST — API buttons
  path?: string;   // main-site API path, e.g. /api/storm-alerts/<id>/approve
  /** Link-only button: a dashboard path (/storm-alerts) or absolute URL. Opens; no API call. */
  href?: string;
  /** An explicit "Ignore": resolves the action as dismissed instead of done. */
  dismiss?: boolean;
}

export interface Notification {
  /** Which of the shapes this is. Required: every caller says what it is asking for. */
  kind: NotifyKind;
  title: string;
  body: string;
  /** Page to open on tap. Defaults to the brief. Ignored for "waiting" (always the brief). */
  url?: string;
  /** Who is speaking — shown on the brief's activity list ("news", "storm", "ops"…). */
  source?: string;
  /** Legacy collapse key. Shaping now assigns the tag; kept so old callers still type-check. */
  tag?: string;
  /** Inline buttons (rendered as ntfy HTTP actions; max 2 used). */
  buttons?: NotifyButton[];
  /**
   * "high" unlocks the email floor when push/ntfy deliver nothing — faults get it by shape.
   * "lead" is a customer waiting on Mark (a group-page "I'm interested"): same floor, because
   * a lead nobody sees is lost business (Mark, 2026-10-07: "yes go ahead").
   */
  priority?: "high" | "lead" | "normal";
}

export type NotifyChannel = "ntfy" | "webpush" | "email" | "none" | "activity" | "quiet";

/** Seams for tests. Production passes nothing. */
export interface NotifyDeps {
  push?: typeof sendPush;
  mail?: typeof sendMail;
  activity?: typeof logActivity;
  waiting?: WaitingHandler;
}

export type WaitingHandler = (reason: string) => Promise<WaitingPushResult>;

// The waiting list lives above this module (it reads the brief's sources), so index.ts
// registers the handler at boot instead of this file importing it — no import cycle.
let waitingHandler: WaitingHandler | null = null;
export function setWaitingHandler(h: WaitingHandler | null): void {
  waitingHandler = h;
}

function dashboardBase(): string {
  return (process.env["DASHBOARD_URL"] || "https://dashboard.stillafloatcruising.com").replace(/\/$/, "");
}
function briefUrl(): string {
  return `${dashboardBase()}/brief.html`;
}
function ownerEmail(): string {
  return process.env["OWNER_EMAIL"] || "millham57@outlook.com";
}
function apiBase(): string {
  return (process.env["PUBLIC_URL"] || "https://stillafloatcruising.com").replace(/\/$/, "");
}

/**
 * Build a token-bearing review URL for a main-site API review page. Tapping the
 * notification opens this page; the token rides only in the (private, on-device)
 * notification.
 */
export function reviewUrl(path: string): string {
  const tok = process.env["AGENT_APPROVAL_TOKEN"];
  const sep = path.includes("?") ? "&" : "?";
  return `${apiBase()}${path}${tok ? `${sep}token=${encodeURIComponent(tok)}` : ""}`;
}

export function isNotifyKind(x: unknown): x is NotifyKind {
  return typeof x === "string" && (NOTIFY_KINDS as readonly string[]).includes(x);
}

/**
 * What an incoming request means. An explicit valid kind wins. Callers deployed before this
 * change sent only a tag; the two that asked for a decision or reported a fault keep their
 * meaning, everything else is activity (Mark: "everything else stops pushing").
 */
export function resolveKind(kind: unknown, legacyTag?: unknown): NotifyKind {
  if (isNotifyKind(kind)) return kind;
  switch (String(legacyTag ?? "")) {
    case "editorial-digest": return "waiting";
    case "daily-brief": return "waiting";
    case "editorial-scan-fault": return "fault";
    default: return "activity";
  }
}

/** Strip a leading emoji/symbol run and any prefix we are about to add ourselves. */
export function plainTitle(title: string): string {
  return String(title ?? "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/^(heads-up|fault|alert)\s*[:—-]\s*/i, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim()
    .slice(0, 110) || "Still Afloat";
}

export interface Shaped {
  kind: NotifyKind;
  title: string;
  body: string;
  url: string;
  tag: string;
  priority: "high" | "lead" | "normal";
  /** Whether this shape buzzes the phone at all. */
  pushes: boolean;
}

/** The phone-facing form of a notification. Pure, so the release gate can test it dry. */
export function shapeNotification(n: Pick<Notification, "kind" | "title" | "body" | "url" | "priority">): Shaped {
  const plain = plainTitle(n.title);
  const url = n.url ?? briefUrl();
  switch (n.kind) {
    case "waiting":
      return { kind: n.kind, title: "Waiting on you", body: n.body, url: briefUrl(), tag: WAITING_TAG, priority: n.priority ?? "normal", pushes: true };
    case "headsup":
      return { kind: n.kind, title: `Heads-up: ${plain}`, body: n.body, url, tag: HEADSUP_TAG, priority: n.priority ?? "normal", pushes: true };
    case "fault":
      return { kind: n.kind, title: `Heads-up: ⚠️ ${plain}`, body: n.body, url, tag: FAULT_TAG, priority: "high", pushes: true };
    case "activity":
      return { kind: n.kind, title: plain, body: n.body, url, tag: "", priority: "normal", pushes: false };
  }
}

/** Send Mark exactly one notification. Never throws. Returns the channel used. */
export async function notifyMark(n: Notification, deps: NotifyDeps = {}): Promise<NotifyChannel> {
  return (await notifyMarkDetailed(n, deps)).channel;
}

/** Same, with the waiting-list outcome for callers that report it (the push route). */
export async function notifyMarkDetailed(
  n: Notification,
  deps: NotifyDeps = {},
): Promise<{ channel: NotifyChannel; shaped: Shaped; recorded: boolean; waiting?: WaitingPushResult }> {
  const shaped = shapeNotification(n);
  const record = deps.activity ?? logActivity;

  // Whether the brief page's record was written. Callers that cannot reach a phone from their box
  // (the news agent on dev: no device, DISABLE_NOTIFY_EMAIL=1) read this to tell "on the brief
  // page" from "nowhere" — 2026-10-21 the news agent logged a recorded fault as invisible.
  let recorded = false;
  if (n.kind !== "waiting") {
    // The page is the complete record; the phone is not. Never let the log break the send.
    try {
      recorded = await record({
        source: n.source ?? "backend",
        title: n.kind === "activity" ? shaped.title : shaped.title.replace(/^Heads-up:\s*/, ""),
        body: n.body,
        level: n.kind === "fault" ? "fault" : "info",
        pushed: shaped.pushes,
      });
    } catch (err) {
      logger.warn({ err, title: n.title }, "notify: activity record failed");
    }
  }

  if (n.kind === "activity") return { channel: "activity", shaped, recorded };

  if (n.kind === "waiting") {
    const handler = deps.waiting ?? waitingHandler;
    if (!handler) {
      // Boot order bug or a test without a seam: push the caller's own words under the
      // waiting tag rather than say nothing. Loud in the log so it gets fixed.
      logger.error({ title: n.title }, "notify: no waiting handler registered — pushing the raw text");
      const channel = await deliver({ ...shaped, title: `Waiting on you: ${plainTitle(n.title)}` }, n, deps);
      return { channel, shaped, recorded };
    }
    let r: WaitingPushResult | null = null;
    try {
      r = await handler(n.title);
    } catch (err) {
      logger.error({ err, title: n.title }, "notify: waiting handler threw");
    }
    if (r && r.pushed && r.sent > 0) return { channel: "webpush", shaped, recorded, waiting: r };
    if (r && !r.pushed) return { channel: "quiet", shaped, recorded, waiting: r }; // nothing new — by design
    // Pushed to nobody (or the handler failed): the floor for leads and faults, else a logged fault.
    const channel = await emailFloor(n, shaped, deps);
    return { channel, shaped, recorded, ...(r ? { waiting: r } : {}) };
  }

  const channel = await deliver(shaped, n, deps);
  return { channel, shaped, recorded };
}

/** ntfy → web push → email floor, for the shapes that buzz. */
async function deliver(shaped: Shaped, n: Notification, deps: NotifyDeps): Promise<NotifyChannel> {
  const push = deps.push ?? sendPush;
  const ntfyUrl = process.env["NTFY_URL"];
  const topic = process.env["NTFY_TOPIC"];

  if (ntfyUrl && topic) {
    try {
      // NO CREDENTIALS IN A NOTIFICATION: action buttons are "view" links into the dashboard,
      // where the browser's own session authorises the approve/reject.
      const actions = (n.buttons ?? []).filter((b) => !b.dismiss).slice(0, 2).map((b) => {
        const target = b.href ?? b.path ?? "/";
        const url = /^https?:/i.test(target) ? target : `${dashboardBase()}${target.startsWith("/") ? target : `/${target}`}`;
        return `view, ${b.label.replace(/,/g, "")}, ${url}, clear=true`;
      });
      const headers: Record<string, string> = {
        Title: shaped.title.slice(0, 120),
        Click: shaped.url,
        Priority: "high",
        Tags: "ocean",
        "X-Tags": shaped.tag,
      };
      if (actions.length) headers["Actions"] = actions.join("; ");
      const auth = process.env["NTFY_TOKEN"];
      if (auth) headers["Authorization"] = `Bearer ${auth}`;

      const r = await fetch(`${ntfyUrl.replace(/\/$/, "")}/${topic}`, {
        method: "POST",
        headers,
        body: shaped.body.slice(0, 1000),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) return "ntfy";
      logger.warn({ status: r.status }, "notify: ntfy non-200 — falling back to web push");
    } catch (err) {
      logger.warn({ err }, "notify: ntfy failed — falling back to web push");
    }
  }

  try {
    const res = await push({ title: shaped.title, body: shaped.body, url: shaped.url, tag: shaped.tag });
    if (res.sent > 0) return "webpush";
    logger.warn({ title: shaped.title }, "notify: web push reached no devices");
  } catch (err) {
    logger.warn({ err }, "notify: web push failed");
  }

  return emailFloor(n, shaped, deps);
}

/**
 * Email is a FLOOR FOR FAULTS AND LEADS, not a fallback for everything. DISABLE_NOTIFY_EMAIL=1
 * (dev box): no phone is subscribed to dev by design, so without this every fault mailed
 * Mark's real inbox a daily false alarm (Mark, 2026-10-12).
 */
async function emailFloor(n: Notification, shaped: Shaped, deps: NotifyDeps): Promise<NotifyChannel> {
  const mail = deps.mail ?? sendMail;
  const eligible = shaped.priority === "high" || shaped.priority === "lead";
  const emailOff = process.env["DISABLE_NOTIFY_EMAIL"] === "1";
  if (eligible && emailOff) {
    logger.warn({ title: shaped.title }, "notify: email floor disabled on this box (DISABLE_NOTIFY_EMAIL=1)");
  }
  if (eligible && !emailOff) {
    try {
      const ok = await mail({
        to: ownerEmail(),
        subject: n.title,
        text: `${n.body}\n\n${shaped.url}`,
        fromName: shaped.priority === "lead" ? "Still Afloat Leads" : "Still Afloat Ops",
      });
      if (ok) return "email";
    } catch (err) {
      logger.error({ err }, "notify: email floor failed");
    }
  }
  logger.error({ title: shaped.title, kind: n.kind, priority: shaped.priority }, "notify: NO channel delivered — Mark was not told");
  return "none";
}
