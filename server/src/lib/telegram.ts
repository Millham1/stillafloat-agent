import { logger } from "./logger";
import { sendPush } from "./push";

// DEPRECATED — kept for one release, no longer imported anywhere.
//
// Marketing/approval nudges formerly went out via Telegram, then via this shim
// (raw Web Push). All callers (social, newsletter, affiliate, commentary,
// index) now use notifyMark() + reviewUrl() from ./notify — THE single
// notification channel (ntfy-primary, Web Push fallback). This shim bypassed
// the ntfy path, so nothing may import it; delete the file next release.

const SITE = "https://stillafloatcruising.com";

function stripHtml(s: string): string {
  return String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

// Build a token-bearing review URL. Tapping the push opens this page; the token
// rides only in the (private, on-device) notification, same as before.
/** @deprecated Use reviewUrl from ./notify (handles paths that already carry a query string). */
export function reviewUrl(path: string): string {
  const tok = process.env["AGENT_APPROVAL_TOKEN"];
  return `${SITE}${path}${tok ? `?token=${encodeURIComponent(tok)}` : ""}`;
}

/** @deprecated Use notifyMark from ./notify — the single channel (ntfy + Web Push fallback). */
export async function notifyTelegram(opts: {
  heading: string; // may contain HTML (e.g. <b>…</b>) — stripped for the push title
  lines?: string[];
  url?: string;
  buttonLabel?: string;
}): Promise<{ success: boolean; reason?: string }> {
  try {
    const title = stripHtml(opts.heading) || "Still Afloat";
    const body = (opts.lines ?? []).map(stripHtml).filter(Boolean).join("\n");
    const result = await sendPush({
      title,
      body: body || (opts.buttonLabel ?? "Tap to review"),
      url: opts.url || "/brief.html",
      tag: "saf-review",
    });
    if (result.sent > 0) return { success: true };
    return { success: false, reason: "no subscribed devices" };
  } catch (err) {
    logger.warn({ err }, "Web Push notify failed");
    return { success: false, reason: (err as Error).message };
  }
}
