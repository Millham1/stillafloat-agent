import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"] ?? "8080";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  scheduleDailyScan();
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
