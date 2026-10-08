// lib/error-ledger.ts — counts every error-level log line, by message, since boot.
//
// Separate from job-health.ts only to avoid an import cycle: the logger reports here, and
// job-health (which logs) reads from here. The prod audit (2026-10-08) found no error alerting
// and a health check that always said ok; this is the counter the job-health endpoint and the
// release gate's vitals check read.

export interface ErrorLedger {
  sinceBoot: number;
  byMessage: Record<string, number>;
  recent: Array<{ at: string; msg: string }>;
}

const errors: ErrorLedger = { sinceBoot: 0, byMessage: {}, recent: [] };
let now: () => number = () => Date.now();

export function _configureErrorLedgerForTests(opts: { now?: () => number } = {}): void { if (opts.now) now = opts.now; }
export function _resetErrorLedgerForTests(): void { errors.sinceBoot = 0; errors.byMessage = {}; errors.recent = []; }

/** The logger hook: count every error-level line (pino level >= 50) by its message. Pure; tested. */
export function countError(level: number, msg: unknown): void {
  if (!(level >= 50)) return;
  errors.sinceBoot++;
  const key = String(msg || "(no message)").slice(0, 120);
  errors.byMessage[key] = (errors.byMessage[key] ?? 0) + 1;
  errors.recent.push({ at: new Date(now()).toISOString(), msg: key });
  if (errors.recent.length > 25) errors.recent.shift();
}

export function errorLedger(): ErrorLedger {
  return { sinceBoot: errors.sinceBoot, byMessage: { ...errors.byMessage }, recent: [...errors.recent] };
}

/** pino's `hooks.logMethod`: the message is the first string argument (pino puts an object first when there is one). */
export function pinoErrorHook(this: { levelVal?: number } | unknown, args: unknown[], method: (...a: unknown[]) => void, level: number): void {
  try {
    const msg = typeof args[0] === "string" ? args[0] : typeof args[1] === "string" ? args[1] : "";
    countError(level, msg);
  } catch { /* counting must never break logging */ }
  method.apply(this, args);
}
