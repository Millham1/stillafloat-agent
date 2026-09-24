// storm-send.ts — email for the storm-alert feature.
//   • emailReviewNudge  → to Mark, with one-tap approve/dismiss links.
//   • emailSubscribers  → to opted-in confirmed subscribers, on approval.
// Sends via the ops-manager Gmail transport (lib/mailer → /send-email). If that
// is unconfigured, sends are skipped (logged) rather than throwing, so approval
// still succeeds.

import { getSupabase } from "./persistence";
import { logger } from "./logger";
import { labelGrounds } from "./storm-grounds";
import { unsubscribeUrl } from "../routes/subscribe";
import { sendMail } from "./mailer";
import { stormAlertEmailHtml, allClearEmailHtml, emailLang, type AffectedShip } from "./storm-email-content";

// Subscriber-facing links use the PUBLIC site, never the dashboard host. DASHBOARD_URL
// is the private admin origin (a bare IP:8080 on the dev box) and a 2026-09-05 alert
// went out with "Unsubscribe" pointing at http://178.156.154.144:8080/... — a link a
// reader cannot use. Mark 2026-09-09: "the emails we do send need an unsubscribe link".
export function siteBase(): string {
  return (process.env["PUBLIC_URL"] || "https://stillafloatcruising.com").replace(/\/$/, "");
}

function markToHtml(md: string): string {
  return md
    .split(/\n{2,}/)
    .map((block) => {
      const b = block.trim();
      if (!b) return "";
      const inline = b
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      if (/^#{1,3}\s/.test(b)) return `<h3 style="margin:16px 0 6px">${inline.replace(/^#{1,3}\s/, "")}</h3>`;
      return `<p style="margin:0 0 12px;line-height:1.55">${inline.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  // Transactional email goes through the ops-manager Gmail sender (post-Resend).
  return sendMail({ to, subject, html, fromName: "Still Afloat", fromAddr: "noreply@stillafloatcruising.com" });
}

/**
 * Storm mail goes out ONE AT A TIME with a gap between sends.
 *
 * 2026-09-18: the Friday newsletter pushed 11 emails through the domain alias in 18 seconds.
 * Zoho — the alias's outbound relay — accepted ten, refused the eleventh with "550 5.4.6 Unusual
 * sending activity detected", then BLOCKED mark@stillafloatcruising.com outright. The newsletter
 * was paced in response; these two loops were not, and they send to the SAME 11 confirmed
 * opted-in subscribers. Worse, they fire on weather rather than on a schedule Mark controls, so
 * the next named storm would have re-blocked the mailbox unattended.
 *
 * 45s x 11 recipients is about eight minutes for a full storm send — immaterial for a weather
 * advisory, and the alternative is not "faster", it is "blocked". STORM_PACE_MS is separate from
 * NEWSLETTER_PACE_MS so an urgent case can be tuned without touching the weekly send; 0 disables
 * the gap (tests, and a single-recipient send never waits at all).
 */
export async function sendPaced<T>(
  list: readonly T[],
  send: (item: T) => Promise<boolean>,
  opts: { paceMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ sent: number; failed: number }> {
  const paceMs = opts.paceMs ?? Number(process.env["STORM_PACE_MS"] ?? "45000");
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let sent = 0, failed = 0;
  for (let i = 0; i < list.length; i++) {
    (await send(list[i] as T)) ? sent++ : failed++;
    if (i < list.length - 1 && paceMs > 0) await sleep(paceMs);
  }
  return { sent, failed };
}

/**
 * One send per alert, and the caller never waits for it.
 *
 * 2026-09-24, on prod: Fay was approved at 03:42:12 and again at 03:43:07. The
 * approve route awaited the whole paced send (~7.5 min for 11 recipients) before
 * answering, so the first click showed nothing and invited the second; and the
 * only guard was `status === "sent"`, which a row mid-send does not satisfy. Both
 * clicks sent — eleven subscribers got the same alert twice, a minute apart.
 *
 * The claim is the lock: `deps.claim` must flip the row to a "sending" state
 * ATOMICALLY (an UPDATE whose WHERE excludes sending/sent, returning the row) so
 * two callers cannot both win, even across a restart. `inFlight` is the cheap
 * in-process short-circuit in front of it. The send then runs in the background;
 * `markSent`/`markFailed` record the outcome. Same shape as newsletter-delivery.
 */
export interface AlertSendDeps {
  claim: (id: string) => Promise<boolean>;
  send: () => Promise<{ sent: number; failed: number; total: number }>;
  markSent: (counts: { sent: number; failed: number; total: number }) => Promise<void>;
  markFailed: (err: unknown) => Promise<void>;
}
const inFlight = new Set<string>();

export async function startAlertSend(id: string, deps: AlertSendDeps): Promise<"started" | "already"> {
  if (inFlight.has(id)) return "already";
  inFlight.add(id);
  let claimed = false;
  try {
    claimed = await deps.claim(id);
  } finally {
    if (!claimed) inFlight.delete(id);
  }
  if (!claimed) return "already";
  void (async () => {
    try {
      const counts = await deps.send();
      await deps.markSent(counts);
    } catch (err) {
      logger.error({ err, id }, "storm-send: background send failed");
      try { await deps.markFailed(err); } catch (e2) { logger.error({ err: e2, id }, "storm-send: could not record the failure"); }
    } finally {
      inFlight.delete(id);
    }
  })();
  return "started";
}

/** Test seam: forget in-process locks (never used by the app). */
export function _resetInFlightForTests(): void { inFlight.clear(); }

/** How many people a storm send will reach — for the immediate response. */
export async function subscriberCount(): Promise<number> {
  const supabase = getSupabase();
  const { count } = await supabase.from("subscribers").select("email", { count: "exact", head: true })
    .eq("status", "confirmed").eq("alerts_opt_in", true);
  return count ?? 0;
}

// NOTE (2026-07-06): the email review nudge was REMOVED by Mark's directive —
// agents never email him actions. Review requests now flow through the unified
// action queue (lib/actions.ts → one notification → inline brief buttons).
// emailSubscribers below is unaffected: that's the OUTBOUND alert to subscribers
// after Mark approves, which is the product itself, not a notification to Mark.

/** The ships pinned to this storm by the lifecycle (storm_tracked_ships). A read
 *  failure means an email without the list, never a failed send. */
export async function affectedShips(alertId: string, opts: { includeReleased?: boolean } = {}): Promise<AffectedShip[]> {
  try {
    const supabase = getSupabase();
    let q = supabase.from("storm_tracked_ships").select("ship_name, cruise_line, released_at").eq("alert_id", alertId);
    if (!opts.includeReleased) q = q.is("released_at", null);
    const { data, error } = await q;
    if (error) { logger.warn({ err: error, alertId }, "storm-send: affected ships read failed"); return []; }
    return ((data ?? []) as unknown as Array<{ ship_name: string; cruise_line: string | null }>).map((r) => ({ ship_name: r.ship_name, cruise_line: r.cruise_line }));
  } catch (err) {
    logger.warn({ err, alertId }, "storm-send: affected ships read threw");
    return [];
  }
}

export interface AlertRow {
  id: string; name: string; headline: string | null; body_md: string | null;
  affected_grounds: string[];
}

/** Send an approved alert to opted-in confirmed subscribers. Returns counts. */
export async function emailSubscribers(a: AlertRow): Promise<{ sent: number; failed: number; total: number }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("subscribers").select("email, name, lang")
    .eq("status", "confirmed").eq("alerts_opt_in", true);
  if (error) throw new Error(`emailSubscribers: ${error.message}`);
  const list = (data ?? []) as unknown as Array<{ email: string; name: string; lang?: string | null }>;
  if (!list.length) return { sent: 0, failed: 0, total: 0 };
  const subject = a.headline || `Storm update: ${a.name}`;
  const bodyHtml = markToHtml(a.body_md || "");
  const ships = await affectedShips(a.id);
  const started = Date.now();
  const { sent, failed } = await sendPaced(list, (sub) => {
    const html = stormAlertEmailHtml({
      headline: a.headline ?? a.name, name: a.name, groundsLabel: labelGrounds(a.affected_grounds), bodyHtml,
      ships, unsubscribeUrl: unsubscribeUrl(sub.email, siteBase()), base: siteBase(), lang: emailLang(sub.lang),
    });
    return sendEmail(sub.email, subject, html);
  });
  logger.info({ alert: a.name, sent, failed, ships: ships.length, tookMs: Date.now() - started },
    "storm-send: subscriber send complete");
  return { sent, failed, total: list.length };
}

export interface AllClearRow {
  id: string; name: string; affected_grounds: string[];
  all_clear_headline: string | null; all_clear_body_md: string | null;
}

/** Send the all-clear to the same opted-in subscriber base the storm alert went
 *  to. Called autonomously by the lifecycle when a sent alert's storm dies
 *  (Mark 2026-09-05), and by the /all-clear endpoint as the manual/retry path. */
export async function emailAllClear(a: AllClearRow): Promise<{ sent: number; failed: number; total: number }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("subscribers").select("email, name, lang")
    .eq("status", "confirmed").eq("alerts_opt_in", true);
  if (error) throw new Error(`emailAllClear: ${error.message}`);
  const list = (data ?? []) as unknown as Array<{ email: string; name: string; lang?: string | null }>;
  if (!list.length) return { sent: 0, failed: 0, total: 0 };
  const subject = a.all_clear_headline || `All clear: ${a.name}`;
  const bodyHtml = markToHtml(a.all_clear_body_md || "");
  // The ships that were watched for this storm, released or not: a reader who
  // followed one wants to see her name on the all-clear too.
  const ships = await affectedShips(a.id, { includeReleased: true });
  const started = Date.now();
  const { sent, failed } = await sendPaced(list, (sub) => {
    const html = allClearEmailHtml({
      headline: subject, name: a.name, groundsLabel: labelGrounds(a.affected_grounds), bodyHtml,
      ships, unsubscribeUrl: unsubscribeUrl(sub.email, siteBase()), base: siteBase(), lang: emailLang(sub.lang),
    });
    return sendEmail(sub.email, subject, html);
  });
  logger.info({ alert: a.name, sent, failed, ships: ships.length, tookMs: Date.now() - started },
    "storm-send: all-clear send complete");
  return { sent, failed, total: list.length };
}
