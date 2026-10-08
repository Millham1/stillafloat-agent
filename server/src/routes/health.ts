import { Router, type IRouter, type Request, type Response } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { subscriptionCount, getVapidPublicKey } from "../lib/push";
import { requireToken } from "../lib/http-auth";
import { jobHealthReport } from "../lib/job-health";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// ── Canary surface ────────────────────────────────────────────────────────────
// Read by the watchdog on the OTHER box. A canary that runs inside the process it
// watches cannot report that process dying, and the alert channel cannot report
// its own silence — on 2026-08-26 web push had zero devices for five days and the
// only thing that noticed wrote it to a log file.
//
// Gated by CANARY_TOKEN, a single-purpose read-only secret: the device count is
// exactly the fact an attacker would want ("is the operator receiving alerts right
// now?"), so it is not public, and the canary never needs the dashboard token.
router.get("/healthz/alerts", (req: Request, res: Response) => {
  const expected = process.env["CANARY_TOKEN"];
  const got = req.get("x-canary-token") || "";
  if (!expected || got.length !== expected.length || got !== expected) {
    res.status(401).json({ ok: false });
    return;
  }
  void (async () => {
    try {
      res.json({
        ok: true,
        devices: await subscriptionCount(),
        vapid: Boolean(getVapidPublicKey()),
        ts: new Date().toISOString(),
      });
    } catch {
      // Reachable but unable to read its own state is a FAULT, not a 200 — the
      // canary must be able to tell "healthy" from "cannot tell".
      res.status(503).json({ ok: false, error: "state unreadable" });
    }
  })();
});

// ── Job-health ledger ─────────────────────────────────────────────────────────
// Every scheduled job's last start / success / error / streak, plus the error counter (lib/job-health.ts,
// lib/error-ledger.ts). Token-gated: it names jobs, errors and timings. `ok` is false when any job is
// overdue; the release gate (e2e/checks/vitals.mjs) reads this on every sweep.
router.get("/healthz/jobs", requireToken, (_req: Request, res: Response) => {
  const report = jobHealthReport();
  res.set("Cache-Control", "no-store");
  res.status(report.ok ? 200 : 503).json({ success: true, ...report });
});

export default router;
