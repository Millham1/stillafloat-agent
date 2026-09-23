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

/** One readable line from an error, capped, with HTML error pages reduced to their title. */
export function briefly(err: unknown, max = 200): string {
  const raw = err instanceof Error ? err.message : String(err);
  const title = /<title>([^<]{1,120})<\/title>/i.exec(raw);
  const text = title ? title[1]!.trim() : (raw.split("\n")[0] ?? raw);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
