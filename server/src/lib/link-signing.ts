// link-signing.ts — the signature on every one-click link in a subscriber email: unsubscribe,
// stop tracking a ship, keep tracking a ship.
//
// Until 2026-09-15 neither box set UNSUBSCRIBE_SECRET, so every link was signed with a
// default written into this repo, which is public: anyone who knew a subscriber's address
// could build a working unsubscribe link for it. Mark: "fix the security gap". Links are now
// signed with UNSUBSCRIBE_SECRET from /opt/stillafloat/shared.env.
//
// Links already sitting in inboxes carry the old signature, and an unsubscribe link has to
// keep working for at least 30 days after the email went out (CAN-SPAM). So an unsubscribe
// or stop-tracking link signed the old way is still accepted through LEGACY_SIGNATURES_UNTIL,
// logged each time, and refused after that date with no redeploy. Keep-tracking links never
// went out the old way, so they get no grace period.

import crypto from "node:crypto";
import { logger } from "./logger";

export type LinkPurpose = "unsubscribe" | "watch-stop" | "watch-restart";

/** The last day a link signed with the old public default still works (46 days after the switch). */
export const LEGACY_SIGNATURES_UNTIL = "2026-10-31";

const LEGACY_DEFAULT = "still-afloat-unsub-v1";
const LEGACY_ACCEPTED: ReadonlySet<LinkPurpose> = new Set(["unsubscribe", "watch-stop"]);
const SIG_RE = /^[0-9a-f]{24}$/;

type Env = Record<string, string | undefined>;

/** What gets signed. These are the exact formats the old links used, so old signatures still check. */
function message(purpose: LinkPurpose, subject: string): string {
  switch (purpose) {
    case "unsubscribe": return subject.toLowerCase();
    case "watch-stop": return `watch:${subject}`;
    case "watch-restart": return `watch-restart:${subject}`;
  }
}

function hmac(secret: string, text: string): string {
  return crypto.createHmac("sha256", secret).update(text).digest("hex").slice(0, 24);
}

let warnedUnset = false;

function secretFrom(env: Env): string {
  const secret = env["UNSUBSCRIBE_SECRET"]?.trim().replace(/^["']|["']$/g, "");
  if (secret) return secret;
  if (!warnedUnset) {
    warnedUnset = true;
    logger.error("UNSUBSCRIBE_SECRET is not set: email links are signed with the public default. Set it in /opt/stillafloat/shared.env.");
  }
  return LEGACY_DEFAULT;
}

function sameSig(a: string, b: string): boolean {
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function signLink(purpose: LinkPurpose, subject: string, env: Env = process.env): string {
  return hmac(secretFrom(env), message(purpose, subject));
}

export function verifyLink(
  purpose: LinkPurpose,
  subject: string,
  sig: unknown,
  opts: { env?: Env; today?: string } = {},
): boolean {
  if (typeof sig !== "string" || !SIG_RE.test(sig) || !subject) return false;
  const env = opts.env ?? process.env;
  if (sameSig(sig, signLink(purpose, subject, env))) return true;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  if (LEGACY_ACCEPTED.has(purpose) && today <= LEGACY_SIGNATURES_UNTIL && sameSig(sig, hmac(LEGACY_DEFAULT, message(purpose, subject)))) {
    logger.warn({ purpose }, "link-signing: accepted a link signed with the old public default");
    return true;
  }
  return false;
}
