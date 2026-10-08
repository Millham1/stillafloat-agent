// job-health.test.ts — the job-health ledger: runs, failures, staleness, summaries, the error counter.
import { test, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import { registerJob, runJob, jobHealthReport, staleness, summarize, _configureForTests, _resetForTests, type JobRecord } from "./job-health";
import { countError, errorLedger, pinoErrorHook, _resetErrorLedgerForTests } from "./error-ledger";

let clock = Date.parse("2026-10-08T12:00:00Z");
const saved: unknown[] = [];
beforeEach(() => {
  _resetForTests(); _resetErrorLedgerForTests();
  clock = Date.parse("2026-10-08T12:00:00Z");
  _configureForTests({ now: () => clock, persist: async (_k, p) => { saved.push(p); return true; } });
});

test("runJob records a success with its duration and a one-line result", async () => {
  registerJob("scheduleStormScan", { every: "hourly", everyMs: 3_600_000 });
  const out = await runJob("scheduleStormScan", async () => { clock += 1500; return { scanned: 4, drafted: 1 }; });
  assert.deepEqual(out, { scanned: 4, drafted: 1 });
  const j = jobHealthReport().jobs.find((x) => x.name === "scheduleStormScan")!;
  assert.equal(j.runs, 1); assert.equal(j.ok, 1); assert.equal(j.failed, 0);
  assert.equal(j.lastDurationMs, 1500); assert.equal(j.lastResult, "scanned=4 drafted=1");
  assert.equal(j.consecutiveFailures, 0); assert.equal(j.stale, false);
});

test("runJob swallows a failure, counts the streak, and the report says so; a success resets it", async () => {
  registerJob("scheduleNewsPrerender", { every: "hourly", everyMs: 3_600_000 });
  for (let i = 0; i < 3; i++) await runJob("scheduleNewsPrerender", async () => { throw new Error("disk full"); });
  let j = jobHealthReport().jobs.find((x) => x.name === "scheduleNewsPrerender")!;
  assert.equal(j.consecutiveFailures, 3); assert.equal(j.failed, 3); assert.equal(j.lastError, "disk full");
  assert.equal(j.lastOkAt, null);
  assert.ok(errorLedger().sinceBoot >= 3, "each failure is an error-level log line");
  await runJob("scheduleNewsPrerender", async () => "ok");
  j = jobHealthReport().jobs.find((x) => x.name === "scheduleNewsPrerender")!;
  assert.equal(j.consecutiveFailures, 0); assert.ok(j.lastOkAt);
});

test("staleness: overdue after two cadences; never-ran after 1.5 cadences of uptime; disabled never; 3 failures in a row with an old success", () => {
  const base: JobRecord = { name: "x", every: "hourly", everyMs: 3_600_000, disabled: false, registeredAt: "", lastStartedAt: null, lastOkAt: null, lastErrorAt: null, lastError: null, lastDurationMs: null, lastResult: null, consecutiveFailures: 0, runs: 0, ok: 0, failed: 0 };
  const t0 = clock;
  assert.equal(staleness({ ...base, lastOkAt: new Date(t0 - 90 * 60_000).toISOString() }, t0, t0 - 86_400_000).stale, false, "90 min ago is within two hours + slack");
  assert.equal(staleness({ ...base, lastOkAt: new Date(t0 - 3 * 3_600_000).toISOString() }, t0, t0 - 86_400_000).stale, true, "three hours ago is overdue");
  assert.equal(staleness(base, t0, t0 - 30 * 60_000).stale, false, "booted 30 min ago: not yet expected");
  assert.equal(staleness(base, t0, t0 - 2 * 3_600_000).stale, true, "booted two hours ago and never ran");
  assert.equal(staleness({ ...base, disabled: true }, t0, t0 - 86_400_000).stale, false, "disabled on this box");
  assert.equal(staleness({ ...base, lastOkAt: new Date(t0 - 60_000).toISOString(), consecutiveFailures: 3 }, t0, t0 - 86_400_000).stale, true, "three failures in a row");
});

test("the report is not ok when any job is overdue, and lists disabled jobs with their flag", () => {
  registerJob("scheduleWmsAlerts", { every: "hourly", everyMs: 3_600_000, disabled: true, disabledWhy: "DISABLE_WMS_ALERTS=1 on this box" });
  registerJob("scheduleGuidesPrerender", { every: "hourly", everyMs: 3_600_000 });
  clock += 3 * 3_600_000; // three hours of uptime, guides never ran
  const r = jobHealthReport();
  assert.equal(r.ok, false);
  const g = r.jobs.find((x) => x.name === "scheduleGuidesPrerender")!;
  assert.equal(g.stale, true); assert.match(g.why ?? "", /never ran/);
  const w = r.jobs.find((x) => x.name === "scheduleWmsAlerts")!;
  assert.equal(w.stale, false); assert.equal(w.disabledWhy, "DISABLE_WMS_ALERTS=1 on this box");
});

test("summarize keeps a result to one short line", () => {
  assert.equal(summarize(null), null);
  assert.equal(summarize("x".repeat(300))!.length, 200);
  assert.equal(summarize([1, 2, 3]), "3 item(s)");
  assert.equal(summarize({ a: 1, b: "two", c: { nested: true }, d: false }), "a=1 b=two d=false");
});

test("the error counter counts only error-level lines, by message, and keeps the last 25", () => {
  countError(30, "info line"); countError(50, "Storm scan tick failed"); countError(60, "Storm scan tick failed"); countError(50, "");
  const e = errorLedger();
  assert.equal(e.sinceBoot, 3);
  assert.equal(e.byMessage["Storm scan tick failed"], 2);
  assert.equal(e.byMessage["(no message)"], 1);
  for (let i = 0; i < 30; i++) countError(50, `e${i}`);
  assert.equal(errorLedger().recent.length, 25);
  // the pino hook passes the call through and reads the message from either argument position
  const calls: unknown[][] = [];
  const method = function (this: unknown, ...a: unknown[]) { calls.push(a); };
  pinoErrorHook.call({}, [{ err: 1 }, "WMS watch sweep failed"], method, 50);
  pinoErrorHook.call({}, ["plain message"], method, 50);
  assert.equal(calls.length, 2);
  assert.equal(errorLedger().byMessage["WMS watch sweep failed"], 1);
  assert.equal(errorLedger().byMessage["plain message"], 1);
});
