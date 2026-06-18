import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"] ?? "8080";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, "0.0.0.0", () => {
  logger.info({ port }, "Server listening on 0.0.0.0");
  // Daily scan can be disabled per-environment: set DISABLE_DAILY_SCAN=1.
  // Used to keep the dev mirror quiet, and to retire the monorepo's scheduler
  // in favor of the standalone newsagent (ends the double digest).
  if (process.env["DISABLE_DAILY_SCAN"] === "1") {
    logger.info("Daily editorial scan DISABLED (DISABLE_DAILY_SCAN=1)");
  } else {
    scheduleDailyScan();
  }
  // Homepage YouTube section. Independent of the editorial digest (it emails
  // nothing), so it keeps running on prod even after the editorial scan is
  // retired. Disabled on the dev mirror via DISABLE_YOUTUBE_SCAN=1.
  if (process.env["DISABLE_YOUTUBE_SCAN"] === "1") {
    logger.info("YouTube scan scheduler DISABLED (DISABLE_YOUTUBE_SCAN=1)");
  } else {
    scheduleYouTubeScan();
  }
});

// ── Daily news scan scheduler ─────────────────────────────────────────────────
// Fires once per day at 8:00 AM Eastern (UTC-4 summer / UTC-5 winter).
// We approximate with a simple interval that checks the current hour each minute.

function scheduleDailyScan() {
  let lastRunDate = "";

  const tick = async () => {
    const now = new Date();
    // Eastern offset: UTC-4 (EDT, Mar–Nov) or UTC-5 (EST, Nov–Mar)
    const month = now.getUTCMonth(); // 0=Jan, 11=Dec
    const isDST = month >= 2 && month <= 10; // rough DST window
    const offsetHours = isDST ? 4 : 5;
    const easternHour = (now.getUTCHours() - offsetHours + 24) % 24;
    const dateKey = now.toISOString().slice(0, 10);

    if (easternHour === 8 && dateKey !== lastRunDate) {
      lastRunDate = dateKey;
      logger.info("Scheduled daily scan starting");
      try {
        const apiKey = process.env["AGENT_APPROVAL_TOKEN"] || "";
        const url = `http://localhost:${port}/api/scan-news${apiKey ? `?token=${apiKey}` : ""}`;
        const res = await fetch(url, { method: "POST" });
        const body = await res.json() as { success?: boolean; curatedStories?: number };
        logger.info({ success: body.success, curatedStories: body.curatedStories }, "Scheduled daily scan complete");
      } catch (err) {
        logger.error({ err }, "Scheduled daily scan failed");
      }
    }
  };

  // Check every minute
  setInterval(() => { tick().catch(() => {}); }, 60_000);
  logger.info("Daily scan scheduler active — fires at 08:00 Eastern");
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
