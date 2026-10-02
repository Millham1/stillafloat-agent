// lib/verification-send-cap.ts — a site-wide ceiling on confirmation ("please confirm your
// subscription") emails, whoever triggers them.
//
// Why (2026-10-02): bots signed strangers up through POST /api/subscribe — 21 on Oct 1, 28 on
// Oct 2 — and each sign-up sent one confirmation email from mark@stillafloatcruising.com
// through Zoho. Turnstile now stops the bots at the form; this cap is the backstop for the
// day something gets past it, or a route we have not thought of starts sending.
//
// The number, 10 an hour:
//   • Genuine sign-ups run about 0–3 a DAY, so 10 in one hour is several days of real traffic.
//   • Zoho is the constraint. On Sep 18 it accepted 10 mails in a burst and refused the 11th
//     ("550 5.4.6 Unusual sending activity"), then blocked the mailbox until Mark unblocked
//     it by hand. A cap of 10 means even a worst-case burst stays at what Zoho took that day.
//   • Over a whole day the most this cap can let through is 240 (10 × 24), under the paid
//     plan's ~300 sends per user per day, leaving room for the newsletter (11), storm alerts
//     (11 per alert) and contact replies. A cap of 20 an hour (480 a day) could not promise that.
// Override with VERIFICATION_SEND_CAP_PER_HOUR (read once at boot); no shared.env change needed.
//
// Counted: /api/subscribe, /api/resend-verification, /api/wms/track-signup (new or unconfirmed
// subscribers) and the daily pending-subscriber reminder sweep. In memory, one count for the
// whole process — saf-full-server runs as a single pm2 process, so every route shares it. A
// restart starts the count again, which is acceptable for a backstop.

import { logger } from "./logger";

export interface SendCap {
  /** Take one slot if the rolling window has room. False = over the cap: do not insert, do not send. */
  tryReserve(): boolean;
  /** Give back the most recent slot (the reserved send did not happen, e.g. the insert failed). */
  release(): void;
  /** Sends counted in the current window. */
  count(): number;
  readonly limit: number;
  readonly windowMs: number;
}

export const DEFAULT_VERIFICATION_SENDS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

export function createSendCap(opts: { limit: number; windowMs?: number; now?: () => number }): SendCap {
  const limit = opts.limit;
  const windowMs = opts.windowMs ?? HOUR_MS;
  const now = opts.now ?? Date.now;
  const stamps: number[] = [];
  const prune = () => {
    const cutoff = now() - windowMs;
    while (stamps.length && stamps[0]! <= cutoff) stamps.shift();
  };
  return {
    limit,
    windowMs,
    tryReserve() {
      prune();
      if (stamps.length >= limit) return false;
      stamps.push(now());
      return true;
    },
    release() {
      stamps.pop();
    },
    count() {
      prune();
      return stamps.length;
    },
  };
}

function limitFromEnv(): number {
  const raw = Number(process.env["VERIFICATION_SEND_CAP_PER_HOUR"]);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_VERIFICATION_SENDS_PER_HOUR;
}

/** The one cap every confirmation-email path in this process shares. */
export const verificationSendCap: SendCap = createSendCap({ limit: limitFromEnv() });

/** Log line for a refused send, so a cap hit is visible in the server log. */
export function logCapHit(cap: SendCap, where: string): void {
  logger.warn(
    { where, limit: cap.limit, windowMinutes: Math.round(cap.windowMs / 60000) },
    "Verification email cap reached — this send refused, nothing saved or sent",
  );
}
