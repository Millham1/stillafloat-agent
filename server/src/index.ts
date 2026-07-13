import "./env"; // must be first — populates process.env from the shared .env
import app from "./app";
import { logger } from "./lib/logger";
import { runDuePosts } from "./lib/social-schedule";
import { runAndDeliverBrief } from "./lib/brief";
import { runStormScan } from "./lib/storm-agent";
import { scanAndQueue } from "./lib/social-agent";
import { draftNewsletter, saveDraft } from "./lib/newsletter";
import { notifyTelegram, reviewUrl } from "./lib/telegram";
import { runNewsPrerender } from "./lib/prerender-news";
import { stageWeeklyCommentary } from "./lib/commentary-agent";
import { startShipTracker } from "./lib/ship-tracker";
import { runWatchSweep } from "./lib/wms-alerts";

const rawPort = process.env["PORT"] ?? "8080";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, "0.0.0.0", () => {
  logger.info({ port }, "Server listening on 0.0.0.0");
  // Editorial/news is owned entirely by the standalone news agent
  // (:3003, stillafloat-newsagent). The monorepo no longer contains or runs any
  // editorial scan — it only serves the website + dashboard and reads the
  // news agent's published data via the feeds routes.
  // Homepage YouTube section. Independent of the editorial digest (it emails
  // nothing), so it keeps running on prod even after the editorial scan is
  // retired. Disabled on the dev mirror via DISABLE_YOUTUBE_SCAN=1.
  if (process.env["DISABLE_YOUTUBE_SCAN"] === "1") {
    logger.info("YouTube scan scheduler DISABLED (DISABLE_YOUTUBE_SCAN=1)");
  } else {
    scheduleYouTubeScan();
  }
  // Social poster — drips approved/scheduled posts out at their slot times.
  // Disabled on the dev mirror so dev never posts publicly.
  if (process.env["DISABLE_SOCIAL_POSTER"] === "1") {
    logger.info("Social poster DISABLED (DISABLE_SOCIAL_POSTER=1)");
  } else {
    scheduleSocialPoster();
  }
  // Daily brief — assemble + push + email once each morning. Disabled on the dev
  // mirror so the brief isn't sent twice (same pattern as the poster).
  if (process.env["DISABLE_DAILY_BRIEF"] === "1") {
    logger.info("Daily brief DISABLED (DISABLE_DAILY_BRIEF=1)");
  } else {
    scheduleDailyBrief();
  }
  // Storm-alert scan — pull NHC, draft alerts, nudge Mark to review. Never sends
  // to subscribers on its own (approval-gated). Disabled on the dev mirror so dev
  // never pushes/emails; enable on prod only.
  if (process.env["DISABLE_STORM_SCAN"] === "1") {
    logger.info("Storm-alert scan DISABLED (DISABLE_STORM_SCAN=1)");
  } else {
    scheduleStormScan();
  }
  // Weekly marketing cadence — Monday: scan recent uploads into grounded social
  // drafts; Thursday: assemble the newsletter draft. Both land in the review
  // queue with a Telegram nudge; Mark's approval stays the only human gate.
  // Disabled on the dev mirror so nudges/drafts aren't produced twice.
  if (process.env["DISABLE_WEEKLY_MARKETING"] === "1") {
    logger.info("Weekly marketing cadence DISABLED (DISABLE_WEEKLY_MARKETING=1)");
  } else {
    scheduleWeeklyMarketing();
  }
  // News pre-renderer — writes static, crawlable news pages (SEO). Local file
  // writes only, so it runs on BOTH boxes (dev gets testable pages).
  scheduleNewsPrerender();
  // Where's-My-Ship AIS tracker — reads the free aisstream.io feed into an
  // in-memory position cache. No-ops without AISSTREAM_API_KEY. Runs on BOTH
  // boxes (each writes only to its own Supabase; dev makes the page testable).
  void startShipTracker();
  // WMS watch alerts — hourly sweep that emails subscribers who saved a
  // sailing. Disabled on the dev mirror so watchers are never emailed twice.
  if (process.env["DISABLE_WMS_ALERTS"] === "1") {
    logger.info("WMS watch alerts DISABLED (DISABLE_WMS_ALERTS=1)");
  } else {
    scheduleWmsAlerts();
  }
});

// ── WMS watch-alert scheduler ─────────────────────────────────────────────────
// Hourly sweep of active ship watches: itinerary changes, weather threats, and
// cruise-line news, emailed via the ops-manager Gmail sender with per-event
// dedup. First tick waits 15 minutes so the AIS cache has positions to check.
function scheduleWmsAlerts() {
  const tick = async () => {
    try {
      await runWatchSweep();
    } catch (err) {
      logger.error({ err }, "WMS watch sweep failed");
    }
  };
  setTimeout(() => { tick().catch(() => {}); }, 15 * 60 * 1000);
  setInterval(() => { tick().catch(() => {}); }, 60 * 60 * 1000);
  logger.info("WMS watch-alert scheduler active — hourly");
}

// ── News pre-render scheduler ─────────────────────────────────────────────────
// Regenerates the static news listing + story pages from platform_state on boot
// (deploys reset the tracked listing pages) and hourly (the newsagent updates
// once a day, so hourly is generous).
function scheduleNewsPrerender() {
  const tick = async () => {
    try {
      await runNewsPrerender();
    } catch (err) {
      logger.error({ err }, "News prerender tick failed");
    }
  };
  setTimeout(() => { tick().catch(() => {}); }, 40_000);
  setInterval(() => { tick().catch(() => {}); }, 60 * 60 * 1000);
  logger.info("News prerender scheduler active — on boot + hourly");
}

// ── Social poster scheduler ───────────────────────────────────────────────────
// Every 10 minutes, post any scheduled social items whose time has arrived. No-op
// (and harmless) until the Make webhooks are configured — unconfigured posts stay
// scheduled and go out once the env vars land.
function scheduleSocialPoster() {
  const tick = async () => {
    try {
      await runDuePosts();
    } catch (err) {
      logger.error({ err }, "Social poster tick failed");
    }
  };
  setTimeout(() => { tick().catch(() => {}); }, 20_000);
  setInterval(() => { tick().catch(() => {}); }, 10 * 60 * 1000);
  logger.info("Social poster active — every 10m");
}

// ── YouTube channel scan scheduler ────────────────────────────────────────────
// Keeps the homepage YouTube section current. The scan endpoint refreshes the
// cached video list (newest-first); /api/youtube-featured then surfaces the
// latest upload. Nothing was triggering this after the front/back split, so the
// homepage went stale — run it on boot and every 6 hours.

function scheduleYouTubeScan() {
  const runScan = async () => {
    try {
      const res = await fetch(`http://localhost:${port}/api/youtube-scan`);
      const body = await res.json() as { success?: boolean; videos?: unknown[] };
      logger.info({ success: body.success, videos: body.videos?.length ?? 0 }, "Scheduled YouTube scan complete");
    } catch (err) {
      logger.error({ err }, "Scheduled YouTube scan failed");
    }
  };

  // Initial scan shortly after boot (let the listener settle), then every 6 hours.
  setTimeout(() => { runScan().catch(() => {}); }, 10_000);
  setInterval(() => { runScan().catch(() => {}); }, 6 * 60 * 60 * 1000);
  logger.info("YouTube scan scheduler active — on boot + every 6h");
}

// ── Daily brief scheduler ─────────────────────────────────────────────────────
// Fires once per local day at DAILY_BRIEF_HOUR (default 7am, in TIMEZONE). We poll
// every 5 minutes and gate on local hour + date so it's timezone-correct without a
// scheduling dependency — the same approach the Python ops-manager uses.
function scheduleDailyBrief() {
  const TZ = process.env["TIMEZONE"] || "America/New_York";
  const briefHour = Number(process.env["DAILY_BRIEF_HOUR"] ?? "7");
  let lastBriefDate: string | null = null;

  const localHourDate = (): { hour: number; date: string } => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hour12: false, hour: "2-digit",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return { hour: Number(get("hour")) % 24, date: `${get("year")}-${get("month")}-${get("day")}` };
  };

  const tick = async () => {
    const { hour, date } = localHourDate();
    if (hour === briefHour && lastBriefDate !== date) {
      lastBriefDate = date;
      try {
        await runAndDeliverBrief();
      } catch (err) {
        logger.error({ err }, "Daily brief tick failed");
      }
    }
  };

  setInterval(() => { tick().catch(() => {}); }, 5 * 60 * 1000);
  logger.info({ briefHour, tz: TZ }, "Daily brief scheduler active — checks every 5m");
}

// ── Weekly marketing scheduler ────────────────────────────────────────────────
// The campaign's standing cadence (goal: $2k/mo, bookings are the KPI):
//   • Monday 09:00 local — social scan: queue grounded draft batches for recent
//     channel uploads (de-duped by videoId+track) + ONE Telegram review nudge.
//   • Tuesday 09:00 local — commentary draft from the week's featured story +
//     Telegram nudge asking for Mark's take (weave → publish is his call).
//   • Thursday 09:00 local — newsletter draft (EN; ES once that list exists) +
//     Telegram nudge. Sending stays behind the review page's explicit Send.
// Same timezone-gated polling pattern as the daily brief.
function scheduleWeeklyMarketing() {
  const TZ = process.env["TIMEZONE"] || "America/New_York";
  const runHour = Number(process.env["WEEKLY_MARKETING_HOUR"] ?? "9");
  let lastRunDate: string | null = null;

  const localNow = (): { weekday: string; hour: number; date: string } => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hour12: false, hour: "2-digit", weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return {
      weekday: get("weekday"),
      hour: Number(get("hour")) % 24,
      date: `${get("year")}-${get("month")}-${get("day")}`,
    };
  };

  const tick = async () => {
    const { weekday, hour, date } = localNow();
    if (hour !== runHour || lastRunDate === date) return;
    if (weekday !== "Mon" && weekday !== "Tue" && weekday !== "Thu") return;
    lastRunDate = date;
    try {
      if (weekday === "Tue") {
        const draft = await stageWeeklyCommentary(); // notifies via Telegram itself
        logger.info({ lead: draft.stories[0]?.title }, "Weekly commentary staged — awaiting Mark's take");
      } else if (weekday === "Mon") {
        const created = await scanAndQueue(4);
        logger.info({ created: created.length }, "Weekly social scan complete");
        if (created.length > 0) {
          void notifyTelegram({
            heading: `📱 <b>${created.length} new social draft(s) ready</b> (weekly scan)`,
            lines: created.map((b) => `Track ${b.track}: ${b.title}`),
            url: reviewUrl("/api/social/review"),
            buttonLabel: `Review ${created.length} →`,
          });
        }
      } else {
        const draft = await draftNewsletter("en");
        await saveDraft(draft);
        logger.info({ subject: draft.subject }, "Weekly newsletter draft complete");
        void notifyTelegram({
          heading: "📨 <b>Newsletter draft ready (EN)</b> (weekly)",
          lines: [draft.subject],
          url: reviewUrl("/api/newsletter/review"),
          buttonLabel: "Review & send →",
        });
      }
    } catch (err) {
      logger.error({ err }, "Weekly marketing tick failed");
    }
  };

  setInterval(() => { tick().catch(() => {}); }, 5 * 60 * 1000);
  logger.info({ runHour, tz: TZ }, "Weekly marketing scheduler active — Mon social scan / Tue commentary / Thu newsletter");
}

// ── Storm-alert scan scheduler ────────────────────────────────────────────────
// Pull NHC (active systems + Tropical Weather Outlook) on boot and hourly, draft
// alerts for anything threatening cruising grounds, and nudge Mark to review.
// Approval-gated: this never emails subscribers on its own.
function scheduleStormScan() {
  const tick = async () => {
    try {
      const r = await runStormScan();
      if (r.drafted || r.updated) logger.info(r, "Storm scan produced drafts");
    } catch (err) {
      logger.error({ err }, "Storm scan tick failed");
    }
  };
  setTimeout(() => { tick().catch(() => {}); }, 30_000);
  setInterval(() => { tick().catch(() => {}); }, 60 * 60 * 1000);
  logger.info("Storm-alert scan scheduler active — on boot + hourly");
}
