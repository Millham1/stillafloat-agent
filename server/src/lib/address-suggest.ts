// address-suggest.ts — type-ahead for a home address (Mark 2026-10-26: "when I start typing, USPS should match what I'm typing and as soon
// as it gets a hit it provides the whole address for me to approve, then fill in the blanks").
//
// WHICH SERVICE: the post office's free service only checks an address that is already whole (address-lookup.ts), so the type-ahead is
// Smarty's US Autocomplete Pro, built on the post office's own address list (Mark: "we can try Smarty"). Secret key pair, server side only:
// SMARTY_AUTH_ID / SMARTY_AUTH_TOKEN. With either unset, or when the call fails for any reason, the answer is { available: false } and the
// page falls back to the post office's whole-address check.
//
// PRIVACY: what is typed is part of a home address. Nothing here logs it; the page asks with a POST body. A small in-memory cache keeps
// repeated keystrokes from spending the allowance; it never leaves the process.

import { logger } from "./logger";
import type { Suggestion } from "./address-lookup";

export type SuggestResult = { available: false } | { available: true; suggestions: Suggestion[] };
export interface SuggestDeps { fetch?: typeof fetch; env?: Record<string, string | undefined>; now?: () => number }

const URL_PRO = "https://us-autocomplete-pro.api.smarty.com/lookup";
const TIMEOUT_MS = 4000;
const CACHE_MS = 60 * 60 * 1000;
const CACHE_MAX = 1000;
const MAX_RESULTS = 5;
/** Smarty's free plan is small: stay well under it so one busy hour cannot use it up. */
const DEFAULT_HOURLY_CAP = 300;
export const MIN_TYPED = 4;

const cache = new Map<string, { at: number; result: SuggestResult }>();
let hour = { start: 0, calls: 0 };
export function resetAddressSuggestState(): void { cache.clear(); hour = { start: 0, calls: 0 }; }

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Smarty answers in the post office's spelling already; the street line and an apartment (when it has one) are kept together. */
export function fromSmarty(raw: unknown): Suggestion | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const street = [str(r["street_line"]), str(r["secondary"])].filter(Boolean).join(" ");
  const city = str(r["city"]), state = str(r["state"]).toUpperCase(), zip = str(r["zipcode"]).slice(0, 5);
  if (!street || !city || !/^[A-Z]{2}$/.test(state) || !/^\d{5}$/.test(zip)) return null;
  return { street, city, state, zip, formatted: `${street}, ${city}, ${state} ${zip}` };
}

/** Full addresses that start with what has been typed. Never throws; never logs the address. */
export async function suggestAddresses(q: unknown, deps: SuggestDeps = {}): Promise<SuggestResult> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const f = deps.fetch ?? fetch;
  const now = (deps.now ?? Date.now)();
  const id = env["SMARTY_AUTH_ID"], token = env["SMARTY_AUTH_TOKEN"];
  if (!id || !token) return { available: false };
  const search = (typeof q === "string" ? q : "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (search.length < MIN_TYPED) return { available: true, suggestions: [] };

  const key = search.toLowerCase();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.result;

  const cap = Math.max(1, Number(env["SMARTY_HOURLY_CAP"]) || DEFAULT_HOURLY_CAP);
  if (now - hour.start > 60 * 60 * 1000) hour = { start: now, calls: 0 };
  if (hour.calls >= cap) return { available: false };
  hour.calls++;

  try {
    const u = new URL(URL_PRO);
    u.searchParams.set("auth-id", id);
    u.searchParams.set("auth-token", token);
    u.searchParams.set("search", search);
    u.searchParams.set("max_results", String(MAX_RESULTS));
    const res = await f(u.toString(), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`suggest ${res.status}`);
    const j = (await res.json()) as { suggestions?: unknown };
    const list = Array.isArray(j.suggestions) ? j.suggestions : [];
    const seen = new Set<string>();
    const suggestions = list.map(fromSmarty).filter((s): s is Suggestion => !!s && !seen.has(s.formatted) && !!seen.add(s.formatted)).slice(0, MAX_RESULTS);
    const result: SuggestResult = { available: true, suggestions };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: now, result });
    return result;
  } catch (err) {
    // The reason, never the address: "suggest 401", "suggest 429", a timeout.
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "address type-ahead unavailable (the page falls back to the post office check)");
    return { available: false };
  }
}
