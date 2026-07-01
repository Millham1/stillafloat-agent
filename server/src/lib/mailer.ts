import { logger } from "./logger";

const OPS_URL = process.env["OPS_MANAGER_URL"] || "http://127.0.0.1:5000";

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
        from_addr: opts.fromAddr,
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
