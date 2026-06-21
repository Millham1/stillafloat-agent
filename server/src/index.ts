import "./env"; // must be first — populates process.env from the shared .env
import app from "./app";
import { logger } from "./lib/logger";
import { runDuePosts } from "./lib/social-schedule";

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
});

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
