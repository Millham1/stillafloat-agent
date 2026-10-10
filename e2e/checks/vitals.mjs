// e2e/checks/vitals.mjs — the job-health ledger: every scheduled job the website server runs has
// run on time, none is failing in a row, and the error counter is readable.
//
// Incidents this check exists for:
//   2026-10-08  Prod audit highs 4–7: a Gmail sign-in expiry silently stopped triage and all site
//               email for six days; the health check always said ok; there was no error alerting
//               and logs before 9/23 were gone; the daily canary never tested the paid API. A job
//               could stop for weeks with nothing to say so. GET /api/healthz/jobs (token) now
//               reports each job's last start / success / error / streak and counts error lines.
import { keysOf } from "../lib/harness.mjs";

const JOB_FIELDS = ["name", "every", "everyMs", "disabled", "registeredAt", "consecutiveFailures", "runs", "ok", "failed", "stale"];

export default [
  {
    id: "vitals.jobs-ran-on-time",
    basis: "ruling: mark-whole-site-e2e-release-gate.md — Mark 10/4 rule 6: a failure tells Mark; the site may degrade gracefully for visitors but never silently for him (job-health ledger, routes/health.ts)",
    title: "Every scheduled job on the website server has succeeded within its cadence, none is failing in a row, and the ledger refuses strangers",
    covers: ["GET /api/healthz/jobs", "job scheduleWmsAlerts", "job scheduleLiveAisCredits", "job scheduleNewsletterDelivery", "job scheduleDailyBrief"],
    modes: ["dev", "prod"],
    incident: "2026-10-08 prod audit: no error alerting, health always ok, jobs whose only sign of life was a log line on the box",
    run: async (t) => {
      const anon = await t.get("/api/healthz/jobs");
      t.equal(anon.status, 401, `the job ledger must refuse a request with no token (${anon.describe()})`);
      const res = await t.get("/api/healthz/jobs", { auth: true });
      // 503 is the ledger's own verdict (a job is overdue); the body is still the report
      t.ok(res.status === 200 || res.status === 503, `the job ledger answered ${res.describe()}`);
      // 503 is the ledger's own verdict (a job is overdue) and still carries the report — read it as such
      const r = res.json && typeof res.json === "object" ? res.json : t.json(res);
      t.fields(r, ["ok", "now", "bootedAt", "uptimeSec", "jobs", "errors"], "the job-health report");
      t.ok(Array.isArray(r.jobs), "the report has no jobs list");
      t.atLeast(r.jobs.length, 10, "scheduled jobs in the ledger");
      t.ok(Number.isFinite(Date.parse(r.now)) && Number.isFinite(Date.parse(r.bootedAt)), "the report's clock is unreadable");
      t.ok(Math.abs(Date.parse(r.now) - t.now()) < 5 * 60_000, `the box's clock (${r.now}) is more than five minutes from ours`);

      const stale = [];
      const failing = [];
      const neverRan = [];
      for (const j of r.jobs) {
        t.fields(j, JOB_FIELDS, `job ${j?.name}`);
        t.ok(/^schedule[A-Z]/.test(j.name), `a ledger entry is not a schedule…() job: ${j.name}`);
        if (j.disabled) { t.ok(typeof j.disabledWhy === "string" && j.disabledWhy.length > 5, `job ${j.name} is disabled with no reason`); continue; }
        if (j.stale) stale.push(`${j.name} (${j.every}): ${j.why}`);
        if (j.consecutiveFailures >= 3) failing.push(`${j.name}: ${j.consecutiveFailures} in a row — ${j.lastError}`);
        if (j.runs > 0 && !j.lastOkAt && j.lastErrorAt) failing.push(`${j.name}: has only ever failed since boot — ${j.lastError}`);
        if (!j.lastStartedAt && r.uptimeSec * 1000 > j.everyMs * 1.5 + 600_000) neverRan.push(`${j.name} (${j.every})`);
        if (j.lastOkAt) t.ok(Number.isFinite(Date.parse(j.lastOkAt)), `job ${j.name}: lastOkAt is unreadable`);
      }
      t.ok(stale.length === 0, `${stale.length} job(s) are overdue: ${stale.join(" · ")}`);
      t.ok(failing.length === 0, `${failing.length} job(s) are failing: ${failing.join(" · ")}`);
      t.ok(neverRan.length === 0, `${neverRan.length} job(s) never started although the box has been up long enough: ${neverRan.join(", ")}`);
      // the report's own verdict must agree with what we just read
      t.equal(r.ok, stale.length === 0, "the report's ok flag vs its own jobs");

      t.fields(r.errors, ["sinceBoot", "byMessage", "recent"], "the error counter");
      t.ok(Number.isInteger(r.errors.sinceBoot) && r.errors.sinceBoot >= 0, "the error count is not a number");
      const top = Object.entries(r.errors.byMessage).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m, n]) => `${n}× ${m}`);
      t.observe("errors since boot", r.errors.sinceBoot, "info");
      t.observe("top error messages", top.join(" | ") || "none");
      t.observe("uptime hours", Math.round(r.uptimeSec / 360) / 10, "info");
      t.observe("jobs", r.jobs.map((j) => `${j.name}${j.disabled ? "(off)" : ""}`).join(" "));
      t.observe("disabled jobs", r.jobs.filter((j) => j.disabled).map((j) => `${j.name}: ${j.disabledWhy}`).join(" | ") || "none");
      t.observe("report keys", keysOf(r));
    },
  },
];
