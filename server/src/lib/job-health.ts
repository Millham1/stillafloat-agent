// lib/job-health.ts — the job-health ledger (release gate item 1, 2026-10-08).
//
// Every scheduled job the website server runs (the schedule…() functions in index.ts) reports
// here: when it last started, last succeeded, last failed, how long it took, how many failures
// in a row, and a one-line result. The logger's error channel is counted too. Until now a job
// could stop for weeks and nothing said so — the prod audit (2026-10-08) found no error
// alerting, a health check that always said ok, and jobs whose only sign of life was a log
// line on a box. GET /api/healthz/jobs (token) serves the ledger; the release gate's
// vitals.mjs reads it on every sweep; the subscriber-hygiene check reads it to see the daily
// clean-up ran even when nobody is pending.
//
// The ledger survives restarts: it is persisted to platform_state "job-health" (debounced) and
// loaded on boot, so a daily job's last run is still known after a deploy. A job whose
// DISABLE_* flag is set on this box registers as disabled, and the gate treats that as a
// declared condition rather than a stopped job.

import { logger } from "./logger";
import { readJson, writeJson } from "./persistence";
import { errorLedger, type ErrorLedger } from "./error-ledger";

export const JOB_HEALTH_KEY = "job-health";

export interface JobRecord {
  name: string;
  /** Human cadence, e.g. "hourly", "daily 10:00 America/New_York". */
  every: string;
  /** The longest normal gap between two successful runs, in ms. */
  everyMs: number;
  disabled: boolean;
  disabledWhy?: string;
  registeredAt: string;
  lastStartedAt: string | null;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  lastResult: string | null;
  consecutiveFailures: number;
  runs: number;
  ok: number;
  failed: number;
}

export type { ErrorLedger };

export interface JobHealthReport {
  ok: boolean;
  now: string;
  bootedAt: string;
  uptimeSec: number;
  jobs: Array<JobRecord & { stale: boolean; why: string | null }>;
  errors: ErrorLedger;
}

type Persisted = { jobs?: Record<string, Partial<JobRecord>> };

const jobs = new Map<string, JobRecord>();
let bootedAt = new Date().toISOString();
let loaded = false;
let saveTimer: NodeJS.Timeout | null = null;
let persist: (key: string, payload: unknown) => Promise<unknown> = writeJson;
let now: () => number = () => Date.now();

/** Tests swap the clock and the writer. */
export function _configureForTests(opts: { now?: () => number; persist?: typeof persist } = {}): void {
  if (opts.now) now = opts.now;
  if (opts.persist) persist = opts.persist;
}
export function _resetForTests(): void {
  jobs.clear(); loaded = true; bootedAt = new Date(now()).toISOString();
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
}

const iso = () => new Date(now()).toISOString();

/** Load the persisted ledger once, keeping whatever has already been registered this boot. */
export async function loadJobHealth(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const saved = await readJson<Persisted>(JOB_HEALTH_KEY, {});
    for (const [name, rec] of Object.entries(saved.jobs ?? {})) {
      const cur = jobs.get(name);
      if (!cur) continue; // a job that no longer exists in the code is not carried forward
      // what survives a restart: the last known times and the failure streak — not this boot's counts
      cur.lastStartedAt = cur.lastStartedAt ?? rec.lastStartedAt ?? null;
      cur.lastOkAt = cur.lastOkAt ?? rec.lastOkAt ?? null;
      cur.lastErrorAt = cur.lastErrorAt ?? rec.lastErrorAt ?? null;
      cur.lastError = cur.lastError ?? rec.lastError ?? null;
      cur.lastResult = cur.lastResult ?? rec.lastResult ?? null;
      cur.lastDurationMs = cur.lastDurationMs ?? rec.lastDurationMs ?? null;
      if (cur.runs === 0) cur.consecutiveFailures = rec.consecutiveFailures ?? 0;
    }
  } catch (err) {
    logger.warn({ err }, "job-health: could not load the persisted ledger (starting fresh)");
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const out: Persisted = { jobs: {} };
    for (const [k, v] of jobs) out.jobs![k] = v;
    persist(JOB_HEALTH_KEY, out).catch((err: unknown) => logger.warn({ err }, "job-health: ledger save failed"));
  }, 5_000);
  // never keep the process alive for a bookkeeping write
  if (typeof saveTimer.unref === "function") saveTimer.unref();
}

/** Declare a job. Call once per schedule…() function, before its first tick. */
export function registerJob(name: string, spec: { every: string; everyMs: number; disabled?: boolean; disabledWhy?: string }): void {
  const cur = jobs.get(name);
  if (cur) { cur.every = spec.every; cur.everyMs = spec.everyMs; cur.disabled = Boolean(spec.disabled); cur.disabledWhy = spec.disabledWhy; return; }
  jobs.set(name, {
    name, every: spec.every, everyMs: spec.everyMs, disabled: Boolean(spec.disabled), disabledWhy: spec.disabledWhy,
    registeredAt: iso(), lastStartedAt: null, lastOkAt: null, lastErrorAt: null, lastError: null,
    lastDurationMs: null, lastResult: null, consecutiveFailures: 0, runs: 0, ok: 0, failed: 0,
  });
}

/** A one-line, bounded description of what a run produced. */
export function summarize(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === "string") return result.slice(0, 200);
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  if (Array.isArray(result)) return `${result.length} item(s)`;
  if (typeof result === "object") {
    const parts = Object.entries(result as Record<string, unknown>)
      .filter(([, v]) => ["number", "string", "boolean"].includes(typeof v))
      .slice(0, 8).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`);
    return parts.join(" ").slice(0, 200) || null;
  }
  return null;
}

/**
 * Run one tick of a job and record it. Errors are logged (same message the job logged before)
 * and swallowed — a scheduler tick must never throw into setInterval — but they are counted.
 * `name` must be registered first (registerJob); unknown names register themselves with no cadence.
 */
export async function runJob<T>(name: string, fn: () => Promise<T>, opts: { logFail?: string } = {}): Promise<T | undefined> {
  if (!jobs.has(name)) registerJob(name, { every: "unknown", everyMs: 0 });
  const rec = jobs.get(name)!;
  const started = now();
  rec.lastStartedAt = new Date(started).toISOString();
  rec.runs++;
  try {
    const result = await fn();
    rec.lastOkAt = iso();
    rec.lastDurationMs = now() - started;
    rec.lastResult = summarize(result);
    rec.consecutiveFailures = 0;
    rec.ok++;
    scheduleSave();
    return result;
  } catch (err) {
    rec.lastErrorAt = iso();
    rec.lastDurationMs = now() - started;
    rec.lastError = String((err as Error)?.message ?? err).slice(0, 300);
    rec.consecutiveFailures++;
    rec.failed++;
    scheduleSave();
    logger.error({ err, job: name, consecutiveFailures: rec.consecutiveFailures }, opts.logFail ?? `${name} tick failed`);
    return undefined;
  }
}

/** Is this job overdue? A disabled job never is; a never-run job is once the box has been up long enough. */
export function staleness(rec: JobRecord, nowMs: number, bootedMs: number): { stale: boolean; why: string | null } {
  if (rec.disabled) return { stale: false, why: null };
  if (!rec.everyMs) return { stale: false, why: null };
  const allowance = rec.everyMs * 2 + 10 * 60_000; // two cadences plus ten minutes of slack
  if (rec.lastOkAt) {
    const age = nowMs - Date.parse(rec.lastOkAt);
    if (age > allowance) return { stale: true, why: `last success ${Math.round(age / 60_000)} min ago; expected within ${Math.round(allowance / 60_000)} min` };
    if (rec.consecutiveFailures >= 3) return { stale: true, why: `${rec.consecutiveFailures} failures in a row: ${rec.lastError ?? ""}`.trim() };
    return { stale: false, why: null };
  }
  const up = nowMs - bootedMs;
  if (up > rec.everyMs * 1.5 + 10 * 60_000) {
    return { stale: true, why: rec.lastError ? `never succeeded since boot; last error: ${rec.lastError}` : "never ran since boot" };
  }
  return { stale: false, why: null };
}

export function jobHealthReport(): JobHealthReport {
  const nowMs = now();
  const bootedMs = Date.parse(bootedAt);
  const list = [...jobs.values()].sort((a, b) => a.name.localeCompare(b.name)).map((rec) => ({ ...rec, ...staleness(rec, nowMs, bootedMs) }));
  return {
    ok: list.every((j) => !j.stale),
    now: new Date(nowMs).toISOString(),
    bootedAt,
    uptimeSec: Math.round((nowMs - bootedMs) / 1000),
    jobs: list,
    errors: errorLedger(),
  };
}
