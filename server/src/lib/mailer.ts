import { logger } from "./logger";
import type { Bounce } from "./newsletter-delivery";

const OPS_URL = process.env["OPS_MANAGER_URL"] || "http://127.0.0.1:5000";

/**
 * The address subscriber email comes from. Mark, 2026-09-15: "we should move the website to the
 * domain emails". Set MAIL_FROM per box in shared.env (prod: mark@stillafloatcruising.com, which
 * Zoho signs with the domain's own key so the mail passes the domain's DMARC rule instead of
 * arriving as a gmail.com address). Unset — as on dev, whose sender is a different Gmail account —
 * leaves the ops-manager's own account as the sender, exactly as before.
 */
function fromAddress(): string | undefined {
  const addr = process.env["MAIL_FROM"]?.trim().replace(/^["']|["']$/g, "");
  return addr || undefined;
}

export interface MailOpts {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  fromName?: string;
  fromAddr?: string;
  replyTo?: string;
}

/**
 * Send a transactional email via the ops-manager Gmail sender (replaces Resend).
 * Best-effort: returns true on success, false otherwise, never throws.
 */
export async function sendMail(opts: MailOpts): Promise<boolean> {
  const key = process.env["IDEAS_API_KEY"];
  if (!key) {
    logger.warn("mailer: IDEAS_API_KEY unset — email skipped");
    return false;
  }
  try {
    const r = await fetch(`${OPS_URL}/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
        from_name: opts.fromName,
        from_addr: opts.fromAddr ?? fromAddress(),
        reply_to: opts.replyTo,
      }),
    });
    if (!r.ok) {
      logger.warn({ status: r.status }, "mailer: /send-email non-200");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err }, "mailer: send failed");
    return false;
  }
}

/**
 * Delivery failures that came back since `sinceEpochSec`, read from the sending inbox by the
 * ops-manager. sendMail() only knows Gmail ACCEPTED a message; a refusal further along arrives
 * afterwards as a mailer-daemon email, so a bulk sender asks here for the true delivered count.
 * Returns null when the lookup itself failed — never an empty list, which would read as "no bounces".
 */
export async function fetchBounces(sinceEpochSec: number): Promise<Bounce[] | null> {
  const key = process.env["IDEAS_API_KEY"];
  if (!key) return null;
  try {
    const r = await fetch(`${OPS_URL}/mail-bounces?since=${Math.floor(sinceEpochSec)}`, { headers: { "x-api-key": key } });
    if (!r.ok) {
      logger.warn({ status: r.status }, "mailer: /mail-bounces non-200");
      return null;
    }
    const j = (await r.json()) as { bounces?: Bounce[] };
    return Array.isArray(j.bounces) ? j.bounces : null;
  } catch (err) {
    logger.warn({ err }, "mailer: bounce lookup failed");
    return null;
  }
}
