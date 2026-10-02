// lib/turnstile.ts — Cloudflare Turnstile server-side check, shared by every public form.
//
// Moved here from routes/contact.ts on 2026-10-02 so the newsletter sign-up could use the
// same check. Bots were signing strangers up through POST /api/subscribe (21 fake sign-ups
// on Oct 1, 28 on Oct 2), and every one sent a confirmation email from
// mark@stillafloatcruising.com through Zoho — the mailbox Zoho already blocked once for
// sending too fast (Sep 18). The contact forms had Turnstile; the sign-up did not.
//
// Behaviour is exactly what contact.ts had:
//   • TURNSTILE_SECRET_KEY unset (the dev box) → log a warning and let the request through;
//   • secret set, no token                      → fail, without calling Cloudflare;
//   • secret set, token                         → ask Cloudflare's siteverify; pass only on success:true;
//   • siteverify unreachable or not JSON        → fail (closed), and log the error.

import { logger } from "./logger";

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface VerifyTurnstileOpts {
  /** Which form is asking, for the logs. Omitted by contact.ts, so its log lines are unchanged. */
  form?: string;
  /** Injected by the tests so they never reach Cloudflare. */
  fetchImpl?: typeof fetch;
}

/** True when the server will insist on a Turnstile token (the secret is configured). */
export function turnstileEnforced(): boolean {
  return Boolean(process.env["TURNSTILE_SECRET_KEY"]);
}

export async function verifyTurnstile(token: string | null, opts: VerifyTurnstileOpts = {}): Promise<boolean> {
  const secret = process.env["TURNSTILE_SECRET_KEY"];
  if (!secret) {
    if (opts.form) logger.warn({ form: opts.form }, "TURNSTILE_SECRET_KEY not set — skipping Turnstile verification");
    else logger.warn("TURNSTILE_SECRET_KEY not set — skipping Turnstile verification");
    return true;
  }
  if (!token) return false;
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token }),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    logger.error({ err }, "Turnstile verification request failed");
    return false;
  }
}
