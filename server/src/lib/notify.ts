// notify.ts — THE single notification channel to Mark. Every agent calls
// notifyMark(); nothing else may push/email/DM him. One action = one notification.
//
// Primary channel: self-hosted ntfy (real iOS app, reliable delivery, inline
// action buttons). Falls back to in-house Web Push until ntfy is configured, so
// dev keeps working before the ntfy server exists. Swapping channels later means
// editing THIS file only.
//
// Third tier: email via the ops-manager Gmail sender. This is the ONE channel
// proven to reach Mark (storm alerts arrive this way), so it is the floor for
// FAULTS — notifications marked priority:"high". Routine review nudges stop at
// web push on purpose: they already sit in the dashboard queue, and fanning all
// 14 call sites out to email would rebuild the noise Telegram was retired for.
//
// Env: NTFY_URL (e.g. https://ntfy.stillafloatcruising.com), NTFY_TOPIC,
//      NTFY_TOKEN (optional bearer auth), DASHBOARD_URL, OWNER_EMAIL.

import { logger } from "./logger";
import { sendPush } from "./push";
import { sendMail } from "./mailer";

export interface NotifyButton {
  label: string;
  method: string; // GET | POST
  path: string;   // main-site API path, e.g. /api/storm-alerts/<id>/approve
}

export interface Notification {
  title: string;
  body: string;
  /** Page to open on tap. Defaults to the brief. */
  url?: string;
  /** Collapse key — replaces an earlier notification with the same tag. */
  tag?: string;
  /** Inline buttons (rendered as ntfy HTTP actions; max 2 used). */
  buttons?: NotifyButton[];
  /**
   * "high" unlocks the email floor when push/ntfy deliver nothing. Reserve it
   * for FAULTS — a dead step, a broken channel — not for "a draft is ready".
   * Every routine review nudge is "normal" (the default): it already sits in
   * the dashboard queue, so emailing it adds noise, not information. Telegram
   * was retired for exactly that noise; a 14-call-site email fan-out would
   * rebuild it under a new name.
   */
  priority?: "high" | "normal";
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
 * notification. Moved here from lib/telegram.ts so review nudges depend only on
 * THE notification channel.
 */
export function reviewUrl(path: string): string {
  const tok = process.env["AGENT_APPROVAL_TOKEN"];
  const sep = path.includes("?") ? "&" : "?";
  return `${apiBase()}${path}${tok ? `${sep}token=${encodeURIComponent(tok)}` : ""}`;
}

/**
 * Seams for tests. Production passes nothing. Lets a test assert the real
 * fallback chain — in particular that a NORMAL notification which reaches no
 * device never touches email.
 */
export interface NotifyDeps {
  push?: typeof sendPush;
  mail?: typeof sendMail;
}

/** Send Mark exactly one notification. Never throws. Returns the channel used. */
export async function notifyMark(
  n: Notification,
  deps: NotifyDeps = {},
): Promise<"ntfy" | "webpush" | "email" | "none"> {
  const push = deps.push ?? sendPush;
  const mail = deps.mail ?? sendMail;
  const ntfyUrl = process.env["NTFY_URL"];
  const topic = process.env["NTFY_TOPIC"];

  if (ntfyUrl && topic) {
    try {
      // NO CREDENTIALS IN A NOTIFICATION. The earlier version embedded
      // AGENT_APPROVAL_TOKEN in each action URL, which put full dashboard write
      // access inside every message relayed by (and retained on) the ntfy server —
      // a topic anyone holding the name can subscribe to. One-tap approve is not
      // worth handing out the key to the dashboard.
      //
      // Actions are therefore "view" links: they open the dashboard, where the
      // browser's own session authorises the approve/reject. One extra tap, no
      // secret in flight.
      const actions = (n.buttons ?? []).slice(0, 2).map((b) => {
        const url = `${dashboardBase()}${b.path.startsWith("/") ? b.path : `/${b.path}`}`;
        return `view, ${b.label.replace(/,/g, "")}, ${url}, clear=true`;
      });
      const headers: Record<string, string> = {
        Title: n.title.slice(0, 120),
        Click: n.url ?? briefUrl(),
        Priority: "high",
        Tags: "ocean",
      };
      if (n.tag) headers["X-Tags"] = n.tag;
      if (actions.length) headers["Actions"] = actions.join("; ");
      const auth = process.env["NTFY_TOKEN"];
      if (auth) headers["Authorization"] = `Bearer ${auth}`;

      const r = await fetch(`${ntfyUrl.replace(/\/$/, "")}/${topic}`, {
        method: "POST",
        headers,
        body: n.body.slice(0, 1000),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) return "ntfy";
      logger.warn({ status: r.status }, "notify: ntfy non-200 — falling back to web push");
    } catch (err) {
      logger.warn({ err }, "notify: ntfy failed — falling back to web push");
    }
  }

  try {
    const res = await push({ title: n.title, body: n.body, url: n.url ?? briefUrl(), ...(n.tag ? { tag: n.tag } : {}) });
    if (res.sent > 0) return "webpush";
    logger.warn("notify: web push reached no devices");
  } catch (err) {
    logger.warn({ err }, "notify: web push failed");
  }

  // Email is a FLOOR FOR FAULTS, not a fallback for everything. Gating it here
  // is what keeps "never silently fail" from turning into "email me 14 times a
  // day". A normal nudge that lands nowhere is still a real fault — it is just
  // one to fix at the channel, which the push-health check raises separately.
  if (n.priority === "high") {
    try {
      const ok = await mail({
        to: ownerEmail(),
        subject: n.title,
        text: `${n.body}\n\n${n.url ?? briefUrl()}`,
        fromName: "Still Afloat Ops",
      });
      if (ok) return "email";
    } catch (err) {
      logger.error({ err }, "notify: email floor failed");
    }
  }

  // Every eligible tier failed. This is the state the system sat in for months —
  // ntfy unconfigured, zero push subscriptions — while returning a value nobody
  // read. Log at ERROR so it shows up as a fault rather than a shrug.
  logger.error(
    { title: n.title, priority: n.priority ?? "normal" },
    "notify: NO channel delivered — Mark was not told",
  );
  return "none";
}
