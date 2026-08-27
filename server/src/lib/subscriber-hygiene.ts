// subscriber-hygiene.ts — daily lifecycle sweep for the subscribers table.
//
// Three jobs. The first two operate only on status='pending' (never-confirmed)
// rows; the third clears status='bounced'.
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
//   3. purgeBounced — a confirmation that bounced went to an address that does
//      not exist, so the row is junk rather than a lapsed subscriber. Detection
//      already happened (saf-ops-manager's Gmail bounce-scanner sets
//      status='bounced' / bounced_at); nothing ever cleared them, so they
//      accumulated in the table forever. This deletes them after a grace period.
//
// Bounce DETECTION is not done here — that's saf-ops-manager's Gmail
// bounce-scanner, which writes directly to this same table. This file owns the
// lifecycle: pending → reminder → archive, and bounced → purge.
import crypto from "node:crypto";
import { getSupabase } from "./persistence";
import { logger } from "./logger";
import { sendVerificationEmail } from "../routes/subscribe";

const REMINDER_AFTER_DAYS = 3;
const ARCHIVE_AFTER_DAYS = 21; // well past the reminder window — gives it time to land + be acted on
// A bounce can be transient (mailbox full, greylisting), so give the address a
// week to start working again before the row is destroyed. Deletion is not
// reversible; archiving a real person's row is.
export const PURGE_BOUNCED_AFTER_DAYS = 7;

/** Just enough of the Supabase query builder for buildPurgeQuery to be testable. */
export interface PurgeTable {
  delete(): PurgeTable;
  eq(column: string, value: unknown): PurgeTable;
  lte(column: string, value: unknown): PurgeTable;
  select(columns: string): PurgeTable & PromiseLike<{ data: { email: string }[] | null; error: unknown }>;
}
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

/**
 * The delete query, as a pure function of the table handle and "now".
 *
 * Extracted so the FILTERS are testable without a database. The risk in this
 * function was never that it fails to run — it is that it deletes something it
 * shouldn't, and unlike every other write in this file that cannot be undone.
 * A test that can assert "exactly one status filter, and it is 'bounced'" is
 * worth more than one that checks the happy path.
 */
export type PurgeResult = { data: { email: string }[] | null; error: unknown };

export function buildPurgeQuery(
  table: PurgeTable,
  now: number = Date.now(),
): PurgeTable & PromiseLike<PurgeResult> {
  return table
    .delete()
    .eq("status", "bounced")
    .lte("bounced_at", new Date(now - PURGE_BOUNCED_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString())
    .select("email");
}

/**
 * Delete subscribers whose confirmation email bounced.
 *
 * Mark, 2026-08-26: "the bounces were subscription confirmations that bounced on
 * false emails ... i need a way to move them out of the DB." The bounce-scanner
 * has been marking these since it shipped, and nothing has ever removed them, so
 * they sat in the table indefinitely — inflating counts and, because a bounced
 * row keeps its email, quietly blocking that address from ever signing up again.
 *
 * Deleting (not archiving) is deliberate and differs from archiveStaleUnconfirmed:
 * an archived row is a real person who never got round to confirming and is kept
 * for future re-permission marketing. A bounced row is an address that does not
 * exist. There is nobody to re-permission.
 *
 * The grace period matters — a mailbox-full or greylisting DSN also produces a
 * bounce, and that address may start working again. PURGE_AFTER_DAYS gives a
 * transient failure time to resolve before the row is destroyed. Only ever
 * touches status='bounced'; confirmed subscribers are never deleted here whatever
 * their bounce history, because losing a real subscriber is far worse than
 * carrying a stale row.
 */
export async function purgeBounced(): Promise<{ purged: number; emails: string[] }> {
  const supabase = getSupabase();
  const { data, error } = await buildPurgeQuery(
    supabase.from("subscribers") as unknown as PurgeTable,
  );

  if (error) {
    logger.error({ err: error }, "purgeBounced: delete failed");
    return { purged: 0, emails: [] };
  }

  const emails = (data ?? []).map((r: { email: string }) => r.email);
  if (emails.length > 0) {
    // Logged by address on purpose: this is the only remaining record that the
    // row ever existed, so a wrongly-purged subscriber can still be traced.
    logger.info({ purged: emails.length, emails }, "Purged bounced subscribers");
  }
  return { purged: emails.length, emails };
}
