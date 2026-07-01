import { logger } from "./logger";
import { sendPush } from "./push";

// Marketing/approval nudges. Formerly Telegram — now in-house Web Push to the
// dashboard PWA (no third-party service, no phone number). The export name and
// signature are unchanged so existing callers (social, newsletter, affiliate)
// keep working; only the transport changed. No-ops cleanly if push isn't set up.

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
export function reviewUrl(path: string): string {
  const tok = process.env["AGENT_APPROVAL_TOKEN"];
  return `${SITE}${path}${tok ? `?token=${encodeURIComponent(tok)}` : ""}`;
}

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
