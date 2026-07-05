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

function siteBase(): string {
  return (process.env["PUBLIC_URL"] || process.env["DASHBOARD_URL"] || "https://stillafloatcruising.com")
    .replace(/\/$/, "");
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

export async function emailReviewNudge(a: {
  name: string; classification: string; headline: string; grounds: string[];
}): Promise<void> {
  const to = process.env["ALERT_REVIEW_EMAIL"] || process.env["BRIEF_EMAIL_TO"] || "mmillham1@gmail.com";
  const dash = `${siteBase()}/storm-alerts`;
  const html = `
    <div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto">
      <p style="font-size:15px">A storm alert is drafted and waiting for your review.</p>
      <table style="border-collapse:collapse;margin:8px 0">
        <tr><td style="padding:2px 10px 2px 0;color:#555">System</td><td><strong>${a.name}</strong> (${a.classification})</td></tr>
        <tr><td style="padding:2px 10px 2px 0;color:#555">Grounds</td><td>${labelGrounds(a.grounds) || "—"}</td></tr>
        <tr><td style="padding:2px 10px 2px 0;color:#555">Draft</td><td>${a.headline}</td></tr>
      </table>
      <p><a href="${dash}" style="display:inline-block;background:#0d2a4a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Review on the dashboard →</a></p>
      <p style="color:#888;font-size:12px">Approve/edit/dismiss from the Storm Alerts queue. Nothing goes to subscribers until you approve it.</p>
    </div>`;
  await sendEmail(to, `🌀 Review storm alert: ${a.name}`, html);
}

export interface AlertRow {
  id: string; name: string; headline: string | null; body_md: string | null;
  affected_grounds: string[];
}

/** Send an approved alert to opted-in confirmed subscribers. Returns counts. */
export async function emailSubscribers(a: AlertRow): Promise<{ sent: number; failed: number; total: number }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("subscribers").select("email, name")
    .eq("status", "confirmed").eq("alerts_opt_in", true);
  if (error) throw new Error(`emailSubscribers: ${error.message}`);
  const list = (data ?? []) as unknown as Array<{ email: string; name: string }>;
  if (!list.length) return { sent: 0, failed: 0, total: 0 };

  const subject = a.headline || `Storm update: ${a.name}`;
  const bodyHtml = markToHtml(a.body_md || "");
  let sent = 0, failed = 0;
  for (const sub of list) {
    const unsub = unsubscribeUrl(sub.email, siteBase());
    const html = `
      <div style="font-family:system-ui,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a2330">
        <h2 style="color:#0d2a4a;margin:0 0 6px">${a.headline ?? a.name}</h2>
        <p style="color:#5a6b7a;margin:0 0 16px;font-size:13px">Still Afloat · Cruise Weather Alert · ${labelGrounds(a.affected_grounds)}</p>
        ${bodyHtml}
        <hr style="border:none;border-top:1px solid #e3e8ee;margin:20px 0">
        <p style="color:#98a4b0;font-size:12px">You're getting this because you opted into Still Afloat cruise alerts.
          <a href="${unsub}" style="color:#98a4b0">Unsubscribe</a>.</p>
      </div>`;
    (await sendEmail(sub.email, subject, html)) ? sent++ : failed++;
  }
  logger.info({ alert: a.name, sent, failed }, "storm-send: subscriber send complete");
  return { sent, failed, total: list.length };
}
