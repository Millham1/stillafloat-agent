// address-lookup.ts — the post office's own address service, used to tidy the home address a guest types on the details page
// (Mark 2026-10-24, Road B: "looked up as they type and tidied to the post office's spelling; the guest confirms the correction or fixes it").
//
// WHICH SERVICE: the USPS Addresses API v3 (OAuth2 client credentials; the free tier is rate-limited). Mark's decision: the post office's free service
// first; a paid lookup is NOT wired. With USPS_CLIENT_ID / USPS_CLIENT_SECRET unset, or when the call fails for any reason, the answer is
// `{ available: false }` and the page takes the address as the guest typed it.
//
// WHAT THE SERVICE CAN DO: it standardises ONE full address (street, state and a city or ZIP); it does not complete a half-typed street. So the page asks as
// the street is typed (five characters or more), with whatever city, state and ZIP are already filled in, and this module answers:
//   { available: false }                                  no service, no credentials, over the hourly allowance, or the call failed: take it as typed
//   { available: true, suggestions: [], incomplete: true } not enough typed yet to ask (street + state + a city or a ZIP are needed): say nothing
//   { available: true, suggestions: [] }                  asked, and the post office has no such address: "We couldn't find that one…"
//   { available: true, suggestions: [one…] }              up to FIVE, each { street, city, state, zip, formatted } in the post office's spelling
// The USPS answers at most one. The page is written for up to five (a pick-list), so a second service can be added here without touching the page.
//
// PRIVACY: what the guest typed is a home address. Nothing here logs it (the request log already drops every query string, and the page asks with a POST body).
// A small in-memory cache keeps repeated lookups from spending the free allowance; it holds the normalised query and the answer for an hour and never leaves the process.

import { logger } from "./logger";

export interface Suggestion { street: string; city: string; state: string; zip: string; formatted: string }
export type LookupResult = { available: false } | { available: true; suggestions: Suggestion[]; incomplete?: boolean };
export interface LookupInput { q: string; city?: string; state?: string; zip?: string }
export interface LookupDeps { fetch?: typeof fetch; env?: Record<string, string | undefined>; now?: () => number }

const TOKEN_URL = "https://apis.usps.com/oauth2/v3/token";
const ADDRESS_URL = "https://apis.usps.com/addresses/v3/address";
const TIMEOUT_MS = 6000;
const CACHE_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
/** USPS gives a new application about 60 address calls an hour; stay under it so one busy hour cannot lock the lookup for the rest of the site. */
const DEFAULT_HOURLY_CAP = 50;

export const US_STATES = new Set(("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY " +
  "AS GU MP PR VI AA AE AP").split(" "));

// ── Small helpers (also used by the route and the tests) ─────────────────────────────────────────────────────

/** "123 main st" → "123 Main St"; directions (NE, SW …) stay capitals, ordinals stay "1st", "PO BOX" stays capitals. */
export function titleCaseAddress(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim().split(" ").map((w) => {
    if (/^(n|s|e|w|ne|nw|se|sw|po|us|hwy)$/.test(w)) return w.toUpperCase();
    if (/^\d+(st|nd|rd|th)$/.test(w)) return w;
    return w.replace(/(^|[-'’.\/])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
  }).join(" ");
}

/** The address as one line, the way the group file and the paperwork keep it: "123 Main St, Raleigh, NC 27601". */
export function formatAddress(a: { street: string; city: string; state: string; zip: string }): string {
  return `${a.street}, ${a.city}, ${a.state} ${a.zip}`;
}

/** "123 Main St, Raleigh, NC 27601" typed into the street box → the four parts; anything that is not shaped like that is just a street. */
export function splitOneLine(q: string): { street: string; city?: string; state?: string; zip?: string } {
  const parts = q.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { street: q.trim() };
  const last = /^([A-Za-z]{2})(?:\s+(\d{5})(?:-\d{4})?)?$/.exec(parts[parts.length - 1]!);
  const zipOnly = /^(\d{5})(?:-\d{4})?$/.exec(parts[parts.length - 1]!);
  if (last && parts.length >= 3) return { street: parts.slice(0, -2).join(", "), city: parts[parts.length - 2]!, state: last[1]!.toUpperCase(), ...(last[2] ? { zip: last[2] } : {}) };
  if (last && parts.length === 2) return { street: parts[0]!, state: last[1]!.toUpperCase(), ...(last[2] ? { zip: last[2] } : {}) };
  if (zipOnly) return { street: parts[0]!, ...(parts.length >= 3 ? { city: parts[1]! } : {}), zip: zipOnly[1]! };
  return { street: parts[0]!, city: parts[1]! };
}

const SECONDARY = /^(.*?\S)\s+((?:apt|apartment|unit|ste|suite|bldg|building|fl|floor|rm|room)\b\.?\s*#?\s*[\w-]+|#\s*[\w-]+)$/i;

// ── The service ───────────────────────────────────────────────────────────────────────────────────────────────

let tokenCache: { token: string; expiresAt: number } | null = null;
const results = new Map<string, { at: number; result: LookupResult }>();
let hour = { start: 0, calls: 0 };

/** Forget the cached token, the cached answers and the hourly count (the tests start every case clean). */
export function resetAddressLookupState(): void { tokenCache = null; results.clear(); hour = { start: 0, calls: 0 }; }

async function getToken(env: Record<string, string | undefined>, f: typeof fetch, now: number): Promise<string | null> {
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.token;
  const id = env["USPS_CLIENT_ID"], secret = env["USPS_CLIENT_SECRET"];
  if (!id || !secret) return null;
  const res = await f(TOKEN_URL, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: id, client_secret: secret }), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  const j = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof j.access_token !== "string" || !j.access_token) throw new Error("token missing");
  const seconds = Number(j.expires_in);
  tokenCache = { token: j.access_token, expiresAt: now + (Number.isFinite(seconds) && seconds > 120 ? seconds : 3000) * 1000 };
  return tokenCache.token;
}

type Raw = { street: string; secondary?: string; city?: string; state: string; zip?: string };

/** One call to the address service. null = "no such address"; throws for anything that means "the service could not be used". */
async function askUsps(raw: Raw, env: Record<string, string | undefined>, f: typeof fetch, now: number): Promise<Suggestion | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(env, f, now);
    if (!token) throw new Error("no credentials");
    const u = new URL(ADDRESS_URL);
    u.searchParams.set("streetAddress", raw.street);
    if (raw.secondary) u.searchParams.set("secondaryAddress", raw.secondary);
    if (raw.city) u.searchParams.set("city", raw.city);
    u.searchParams.set("state", raw.state);
    if (raw.zip) u.searchParams.set("ZIPCode", raw.zip);
    const res = await f(u.toString(), { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) { tokenCache = null; continue; }   // a stale token: get a fresh one, once
    if (res.status === 400 || res.status === 404) return null;                       // the post office has no such address
    if (!res.ok) throw new Error(`address ${res.status}`);
    const j = (await res.json()) as { address?: Record<string, unknown> };
    const a = j.address ?? {};
    const text = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");
    const street = [text("streetAddress"), text("secondaryAddress")].filter(Boolean).join(" ");
    const city = text("city"), state = text("state").toUpperCase(), zip = text("ZIPCode");
    if (!street || !city || !state || !/^\d{5}$/.test(zip)) return null;
    const tidy = { street: titleCaseAddress(street), city: titleCaseAddress(city), state, zip };
    return { ...tidy, formatted: formatAddress(tidy) };
  }
  throw new Error("address unauthorised");
}

/**
 * Ask the post office about what the guest has typed. Never throws; never logs the address.
 * `deps` are the seams for the tests (a stubbed fetch, a chosen environment and clock); production passes nothing.
 */
export async function lookupAddress(input: LookupInput, deps: LookupDeps = {}): Promise<LookupResult> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const f = deps.fetch ?? fetch;
  const now = (deps.now ?? Date.now)();
  if (!env["USPS_CLIENT_ID"] || !env["USPS_CLIENT_SECRET"]) return { available: false };

  // What was typed: the street box may hold the whole line ("123 Main St, Raleigh, NC 27601"); the other boxes win when they are filled in.
  const q = typeof input.q === "string" ? input.q.slice(0, 200) : "";
  const one = splitOneLine(q);
  const stateIn = (input.state ?? one.state ?? "").trim().toUpperCase();
  const city = (input.city ?? "").trim().slice(0, 60) || one.city || "";
  const zipText = (input.zip ?? "").trim() || one.zip || "";
  const zip = /^\d{5}(-\d{4})?$/.test(zipText) ? zipText.slice(0, 5) : "";
  const state = US_STATES.has(stateIn) ? stateIn : "";
  let street = one.street.trim();
  let secondary: string | undefined;
  const sec = SECONDARY.exec(street);
  if (sec) { street = sec[1]!; secondary = sec[2]!.trim(); }
  if (street.length < 5 || !state || (!city && !zip)) return { available: true, suggestions: [], incomplete: true };

  const key = JSON.stringify([street, secondary ?? "", city, state, zip].map((x) => x.toLowerCase()));
  const hit = results.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.result;

  const cap = Math.max(1, Number(env["USPS_HOURLY_CAP"]) || DEFAULT_HOURLY_CAP);
  if (now - hour.start > 60 * 60 * 1000) hour = { start: now, calls: 0 };
  if (hour.calls >= cap) return { available: false };
  hour.calls++;

  try {
    const found = await askUsps({ street, ...(secondary ? { secondary } : {}), ...(city ? { city } : {}), state, ...(zip ? { zip } : {}) }, env, f, now);
    const result: LookupResult = { available: true, suggestions: found ? [found] : [] };
    if (results.size >= CACHE_MAX) results.delete(results.keys().next().value as string);
    results.set(key, { at: now, result });
    return result;
  } catch (err) {
    // The reason, never the address: "token 401", "address 429", "no credentials", a timeout.
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "address lookup unavailable (the page takes the address as typed)");
    return { available: false };
  }
}
