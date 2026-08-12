// subscriber-hygiene.ts — daily lifecycle sweep for the subscribers table.
//
// Two jobs, both operating only on status='pending' (never-confirmed) rows:
//   1. sendPendingReminders  — after REMINDER_AFTER_DAYS with no confirmation,
//      send ONE reminder (reuses the same confirm-email template/flow as the
//      original signup — it's the same ask, so no separate template to
//      maintain). Never sends a second reminder (gated on reminder_sent_at).
//   2. archiveStaleUnconfirmed — after ARCHIVE_AFTER_DAYS (well past the
//      reminder window) still-unconfirmed rows are archived: status set to
//      'archived', kept in the table (not deleted) for future re-permission
//      marketing, and excluded from all active-subscriber queries since those
//      all filter on status='confirmed'.
//
// Bounce handling (status='bounced') is NOT done here — that's
// saf-ops-manager's Gmail bounce-scanner, which writes directly to this same
// table. This file only owns the pending → reminder → archive lifecycle.
import crypto from "node:crypto";
import { getSupabase } from "./persistence";
import { logger } from "./logger";
import { sendVerificationEmail } from "../routes/subscribe";

const REMINDER_AFTER_DAYS = 3;
const ARCHIVE_AFTER_DAYS = 21; // well past the reminder window — gives it time to land + be acted on
// Same hardcoded-prod-URL pattern as lib/newsletter.ts's SITE constant — this runs
// on a cron with no request object to derive host/proto from, and real sends only
// ever happen on prod anyway (dev sets DISABLE_WEEKLY_MARKETING/etc.).
const SITE = "https://stillafloatcruising.com";

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export async function sendPendingReminders(
  baseUrl: string = SITE,
): Promise<{ reminded: number; failed: number }> {
  const supabase = getSupabase();
  const { data: pending, error } = await supabase
    .from("subscribers")
    .select("id, name, email, lang")
    .eq("status", "pending")
    .is("reminder_sent_at", null)
    .lte("created_at", daysAgoIso(REMINDER_AFTER_DAYS));

  if (error) {
    logger.error({ err: error }, "sendPendingReminders: query failed");
    return { reminded: 0, failed: 0 };
  }
  if (!pending || pending.length === 0) return { reminded: 0, failed: 0 };

  let reminded = 0;
  let failed = 0;

  for (const sub of pending) {
    try {
      // Fresh token — the original may be stale/lost, and a reminder is a good
      // time to invalidate any old link (same pattern as /api/resend-verification).
      const newToken = crypto.randomUUID();
      const { error: updateErr } = await supabase
        .from("subscribers")
        .update({ token: newToken, reminder_sent_at: new Date().toISOString() })
        .eq("id", sub.id);

      if (updateErr) {
        logger.error({ err: updateErr, email: sub.email }, "Reminder: token update failed");
        failed++;
        continue;
      }

      const lang = (sub as { lang?: string }).lang === "es" ? "es" : "en";
      const result = await sendVerificationEmail(sub.name, sub.email, newToken, baseUrl, lang);
      if (result.success) {
        reminded++;
      } else {
        failed++;
        logger.warn({ email: sub.email }, "Reminder email send failed");
      }
      await new Promise((r) => setTimeout(r, 500)); // pace the Gmail send path
    } catch (err) {
      failed++;
      logger.error({ err, email: sub.email }, "Reminder: unexpected error");
    }
  }

  logger.info({ reminded, failed, total: pending.length }, "Pending-subscriber reminders complete");
  return { reminded, failed };
}

export async function archiveStaleUnconfirmed(): Promise<{ archived: number }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("subscribers")
    .update({ status: "archived", archived_at: new Date().toISOString() })
    .eq("status", "pending")
    .lte("created_at", daysAgoIso(ARCHIVE_AFTER_DAYS))
    .select("id");

  if (error) {
    logger.error({ err: error }, "archiveStaleUnconfirmed: update failed");
    return { archived: 0 };
  }

  const archived = data?.length ?? 0;
  if (archived > 0) logger.info({ archived }, "Archived stale unconfirmed subscribers");
  return { archived };
}
