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
  let sent = 0, failed = 0;
  for (const sub of list) {
    const html = stormAlertEmailHtml({
      headline: a.headline ?? a.name, name: a.name, groundsLabel: labelGrounds(a.affected_grounds), bodyHtml,
      ships, unsubscribeUrl: unsubscribeUrl(sub.email, siteBase()), base: siteBase(), lang: emailLang(sub.lang),
    });
    (await sendEmail(sub.email, subject, html)) ? sent++ : failed++;
  }
  logger.info({ alert: a.name, sent, failed, ships: ships.length }, "storm-send: subscriber send complete");
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
  let sent = 0, failed = 0;
  for (const sub of list) {
    const html = allClearEmailHtml({
      headline: subject, name: a.name, groundsLabel: labelGrounds(a.affected_grounds), bodyHtml,
      ships, unsubscribeUrl: unsubscribeUrl(sub.email, siteBase()), base: siteBase(), lang: emailLang(sub.lang),
    });
    (await sendEmail(sub.email, subject, html)) ? sent++ : failed++;
  }
  logger.info({ alert: a.name, sent, failed, ships: ships.length }, "storm-send: all-clear send complete");
  return { sent, failed, total: list.length };
}
