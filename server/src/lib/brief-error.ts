/**
 * brief-error.ts — one readable line out of whatever a failure turns out to be.
 *
 * Deliberately dependency-free: it is imported by tests, and anything that
 * reaches for the logger drags pino into the bundle, which does not survive
 * being bundled as ESM for node:test.
 *
 * Why it exists: on 2026-09-23 the itinerary refresh's first live run hit a
 * Supabase blip and `logger.error({ err })` serialised Cloudflare's entire 522
 * HTML page into the log — roughly four thousand characters of markup whose
 * only useful content was "522: Connection timed out".
 */

/**
 * Node's timers are 32-bit: a delay over 2^31-1 ms (~24.8 days) does not fit,
 * so Node CLAMPS IT TO 1 ms AND FIRES ALMOST IMMEDIATELY — it does not throw,
 * it only prints a TimeoutOverflowWarning that is easy to miss.
 *
 * This is not hypothetical. `setInterval(tick, 30 * 24 * 60 * 60 * 1000)` —
 * a perfectly innocent-looking "once a month" — shipped to prod on 2026-09-23
 * and fired every millisecond instead. Within twenty minutes it had the server
 * at 56% CPU, 2.9 GB of memory on an 8 GB box, and a 19 GB log file.
 *
 * So: never hand a multi-week delay straight to setTimeout/setInterval. This
 * chains full-length waits until the remainder fits.
 */
export const MAX_TIMER_MS = 2_147_483_647;

export function after(ms: number, fn: () => void): void {
  // unref: a pending 24-day wait must not keep a process alive on its own. The
  // server's listening socket keeps prod running; a test or a one-off script
  // that imports this must still be able to exit (a referenced 2^31-1 ms timer
  // hung the test runner on 2026-09-24).
  if (ms <= MAX_TIMER_MS) {
    setTimeout(fn, Math.max(0, ms)).unref();
    return;
  }
  setTimeout(() => after(ms - MAX_TIMER_MS, fn), MAX_TIMER_MS).unref();
}

/** One readable line from an error, capped, with HTML error pages reduced to their title. */
export function briefly(err: unknown, max = 200): string {
  const raw = err instanceof Error ? err.message : String(err);
  const title = /<title>([^<]{1,120})<\/title>/i.exec(raw);
  const text = title ? title[1]!.trim() : (raw.split("\n")[0] ?? raw);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
