// newsletter-delivery.ts — the per-subscriber delivery ledger behind a newsletter send.
//
// Why a ledger (2026-09-18): the Friday auto-send pushed 11 emails through the domain alias in
// 18 seconds. Zoho, the alias's outbound relay, accepted ten, refused the eleventh with
// "550 5.4.6 Unusual sending activity detected", and then blocked the mailbox. The send loop
// still logged 11/11, because /send-email answers 200 the moment Gmail ACCEPTS a message and the
// refusal comes back later as a mailer-daemon email. So a send now:
//   1. goes out slowly (one email per paceMs),
//   2. asks the ops-manager which addresses bounced and reports the TRUE delivered count,
//   3. retries, once and later, the mail our own relay turned away (the address is fine);
//      a refusal by the recipient's server is final and is never retried.
// The ledger is saved after every email, so a deploy restart mid-send resumes with the people
// still queued instead of dropping them or mailing the whole list twice.
//
// Pure: every side effect arrives through DeliveryDeps (tests drive it with fakes).

export type RecipientState = "queued" | "sent" | "failed" | "bounced" | "undeliverable";

export interface DeliveryRecipient {
  email: string;
  name: string;
  state: RecipientState;
  attempts: number;
  note?: string; // the mail server's own words when it refused
}

export interface NewsletterDelivery {
  startedAt: string;
  round: 1 | 2; // 2 = the single retry round
  roundAt: string; // bounces are looked up from here, so round 2 never re-reads round 1's
  recipients: DeliveryRecipient[];
  auto?: boolean; // Friday auto-send, not Mark's Approve & Send
  checkedAt?: string; // this round's bounce check is done
  bounceCheck?: "ok" | "unavailable";
  retryAt?: string;
  finishedAt?: string;
}

/** A delivery failure as the ops-manager's GET /mail-bounces reports it. */
export interface Bounce {
  recipient: string;
  status: string;
  diagnostic: string;
  relay_refused: boolean;
  at: number; // epoch seconds
}

export interface DeliveryDeps {
  send: (r: DeliveryRecipient) => Promise<boolean>;
  bounces: (sinceEpochSec: number) => Promise<Bounce[] | null>; // null = the lookup itself failed
  save: (d: NewsletterDelivery) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  paceMs: number;
  settleMs: number;
  retryDelayMs: number;
}

export type RoundOutcome = "not-due" | "waiting-retry" | "finished";

export function newDelivery(list: Array<{ email: string; name: string }>, nowMs: number): NewsletterDelivery {
  const at = new Date(nowMs).toISOString();
  return {
    startedAt: at,
    round: 1,
    roundAt: at,
    recipients: list.map((s) => ({ email: s.email, name: s.name, state: "queued" as const, attempts: 0 })),
  };
}

const held = (d: NewsletterDelivery): DeliveryRecipient[] =>
  d.recipients.filter((r) => r.state === "bounced" || r.state === "failed");

/** True when a worker has something to do right now (the scheduler's resume test). */
export function deliveryIsDue(d: NewsletterDelivery | undefined, nowMs: number): boolean {
  if (!d || d.finishedAt) return false;
  if (d.recipients.some((r) => r.state === "queued") || !d.checkedAt) return true;
  return Boolean(d.retryAt) && nowMs >= Date.parse(d.retryAt as string);
}

/**
 * Run the ledger as far as it can go now: send everyone queued, check for bounces, then either
 * finish or park until retryAt. Safe to call again at any point — it picks up where the saved
 * ledger says it stopped.
 */
export async function runDeliveryRound(d: NewsletterDelivery, deps: DeliveryDeps): Promise<RoundOutcome> {
  if (d.finishedAt) return "finished";

  const parked = Boolean(d.checkedAt) && !d.recipients.some((r) => r.state === "queued");
  if (parked) {
    if (!d.retryAt || deps.now() < Date.parse(d.retryAt)) return "not-due";
    for (const r of held(d)) r.state = "queued";
    d.round = 2;
    d.roundAt = new Date(deps.now()).toISOString();
    delete d.checkedAt;
    delete d.retryAt;
    await deps.save(d);
  }

  const queue = d.recipients.filter((r) => r.state === "queued");
  for (const [i, r] of queue.entries()) {
    const ok = await deps.send(r);
    r.attempts += 1;
    r.state = ok ? "sent" : "failed";
    if (!ok) r.note = "The mail service did not accept the message.";
    // Saved straight after the send: a restart can then re-mail at most this one person.
    await deps.save(d);
    if (i < queue.length - 1) await deps.sleep(deps.paceMs);
  }

  // A refusal lands within seconds of the send; settle first so the last one is in the inbox.
  await deps.sleep(deps.settleMs);
  const since = Math.floor(Date.parse(d.roundAt) / 1000);
  const found = await deps.bounces(since);
  d.bounceCheck = found ? "ok" : "unavailable";
  for (const b of found ?? []) {
    if (b.at < since) continue;
    const r = d.recipients.find((x) => x.state === "sent" && x.email.toLowerCase() === b.recipient.toLowerCase());
    if (!r) continue;
    r.state = b.relay_refused ? "bounced" : "undeliverable";
    r.note = b.diagnostic || b.status;
  }
  d.checkedAt = new Date(deps.now()).toISOString();

  if (d.round === 1 && held(d).length) {
    d.retryAt = new Date(deps.now() + deps.retryDelayMs).toISOString();
    await deps.save(d);
    return "waiting-retry";
  }
  for (const r of held(d)) r.state = "undeliverable";
  d.finishedAt = d.checkedAt;
  await deps.save(d);
  return "finished";
}

export interface DeliveryCounts {
  total: number;
  delivered: number;
  retrying: DeliveryRecipient[];
  undeliverable: DeliveryRecipient[];
  queued: number;
}

export function deliveryCounts(d: NewsletterDelivery): DeliveryCounts {
  return {
    total: d.recipients.length,
    delivered: d.recipients.filter((r) => r.state === "sent").length,
    retrying: held(d),
    undeliverable: d.recipients.filter((r) => r.state === "undeliverable"),
    queued: d.recipients.filter((r) => r.state === "queued").length,
  };
}

/** The push Mark gets after a round: true counts, who was held back and the server's own reason. */
export function deliveryNotice(
  d: NewsletterDelivery,
  lang: string,
  subject: string,
  timeZone: string,
): { title: string; body: string } {
  const c = deliveryCounts(d);
  const L = lang.toUpperCase();
  const lines = [subject];
  const list = (rs: DeliveryRecipient[]): string => rs.map((r) => `${r.email}${r.note ? ` (${r.note})` : ""}`).join("\n");

  let title = `📬 Newsletter ${L} ${d.auto ? "auto-sent, " : ""}delivered to ${c.delivered} of ${c.total}`;
  if (d.round === 2) title = `📬 Newsletter ${L} after the retry: delivered to ${c.delivered} of ${c.total}`;
  if (c.retrying.length && d.retryAt) {
    const at = new Date(d.retryAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
    title += ` — ${c.retrying.length} held by the mail server`;
    lines.push(`Trying again at ${at}:`, list(c.retrying));
  }
  if (c.undeliverable.length) {
    if (!c.retrying.length) title = `⚠️ Newsletter ${L}: ${c.undeliverable.length} of ${c.total} not delivered`;
    lines.push("Not delivered:", list(c.undeliverable));
  }
  if (d.bounceCheck === "unavailable") {
    lines.push("The bounce check could not run, so this count is what was handed to the mail service, not confirmed delivery.");
  }
  return { title, body: lines.join("\n") };
}
