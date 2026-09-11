// cruise-api.ts — RapidAPI "Cruise API" calls with a monthly ledger. See cruise-api-core.ts.
import { PATHS, readJson, writeJson } from "./persistence";
import { logger } from "./logger";
import { CRUISE_API_DEFAULT_HOST, parseCruiseApiItems, type CruiseApiItem } from "./cruise-api-core";
import type { PlannedSailing } from "./planned-sailings";
export * from "./cruise-api-core";

interface Ledger { month: string; searchUsed: number; refUsed: number; lastError: { at: string; status: number | string } | null }
let ledger: Ledger | null = null;

function monthKey(now = new Date()): string { return now.toISOString().slice(0, 7); }
function unq(s: string | undefined): string { return (s ?? "").replace(/^["']+|["']+$/g, "").trim(); }
export function cruiseApiEnabled(): boolean { return Boolean(unq(process.env["RAPIDAPI_KEY"])); }
export function cruiseApiHost(): string { return unq(process.env["RAPIDAPI_CRUISE_HOST"]) || CRUISE_API_DEFAULT_HOST; }
/** Basic plan: 50 searches + 50 basic reference calls a month. Leave a few for checks by hand. */
export function cruiseApiSearchCap(): number { const n = Number(process.env["CRUISE_API_SEARCH_CAP"]); return Number.isFinite(n) && n > 0 ? n : 45; }
export function cruiseApiRefCap(): number { const n = Number(process.env["CRUISE_API_REF_CAP"]); return Number.isFinite(n) && n > 0 ? n : 45; }

async function loadLedger(now: Date): Promise<Ledger> {
  if (!ledger) {
    const stored = await readJson<Partial<Ledger>>(PATHS.cruiseApiLedger, {});
    ledger = { month: stored.month ?? monthKey(now), searchUsed: stored.searchUsed ?? 0, refUsed: stored.refUsed ?? 0, lastError: stored.lastError ?? null };
  }
  if (ledger.month !== monthKey(now)) ledger = { month: monthKey(now), searchUsed: 0, refUsed: 0, lastError: null };
  return ledger;
}
async function saveLedger(): Promise<void> {
  if (!ledger) return;
  try { await writeJson(PATHS.cruiseApiLedger, ledger); } catch (err) { logger.warn({ err }, "cruise-api: ledger persist failed"); }
}
export async function cruiseApiUsage(now = new Date()): Promise<Ledger & { searchCap: number; refCap: number; enabled: boolean }> {
  const l = await loadLedger(now);
  return { ...l, searchCap: cruiseApiSearchCap(), refCap: cruiseApiRefCap(), enabled: cruiseApiEnabled() };
}

async function call(path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(`https://${cruiseApiHost()}${path}`, {
    ...init,
    headers: { "x-rapidapi-key": unq(process.env["RAPIDAPI_KEY"]), "x-rapidapi-host": cruiseApiHost(), "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(40_000),
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

export interface SearchBody {
  cruiseLineCodes?: string[]; shipCodes?: string[]; earliestStartDate?: string; latestStartDate?: string;
  roomTypeCategoryCodes?: string[]; page?: number; pageSize?: number; sortBy?: string; sortOrder?: string; includeDetailedMetadata?: boolean;
}

/** One search page (counted BEFORE the call). null when the cap is reached or the call fails. */
export async function searchCruises(body: SearchBody, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<{ sailings: PlannedSailing[]; totalResults: number; totalPages: number } | null> {
  if (!cruiseApiEnabled()) return null;
  const l = await loadLedger(now);
  if (l.searchUsed >= cruiseApiSearchCap()) { logger.warn({ used: l.searchUsed, cap: cruiseApiSearchCap() }, "cruise-api: search cap reached"); return null; }
  l.searchUsed += 1;
  try {
    const { status, body: b } = await call("/cruises/search", { method: "POST", body: JSON.stringify({ pageSize: 10, sortBy: "departureDate", sortOrder: "asc", includeDetailedMetadata: true, ...body }) }, fetchImpl);
    if (status !== 200 || !b || typeof b !== "object") {
      l.lastError = { at: now.toISOString(), status: status || String((b as Record<string, unknown> | null)?.["message"] ?? "error") };
      logger.warn({ status, body: b, searchUsed: l.searchUsed }, "cruise-api: search failed");
      return null;
    }
    const d = b as { data?: CruiseApiItem[]; total_results?: number; total_pages?: number };
    l.lastError = null;
    const sailings = parseCruiseApiItems(d.data ?? []);
    logger.info({ body, rows: d.data?.length ?? 0, sailings: sailings.length, totalResults: d.total_results, searchUsed: l.searchUsed }, "cruise-api: search");
    return { sailings, totalResults: d.total_results ?? 0, totalPages: d.total_pages ?? 0 };
  } catch (err) {
    l.lastError = { at: now.toISOString(), status: (err as Error)?.name ?? "error" };
    logger.warn({ err }, "cruise-api: search threw");
    return null;
  } finally {
    await saveLedger();
  }
}

/** Ship codes (2 letters, per line) for shipCodes filters — basic reference call, cached 30 days. */
export async function shipCodes(fetchImpl: typeof fetch = fetch, now = new Date()): Promise<Map<string, { code: string; line: string }>> {
  const cached = await readJson<{ at?: string; ships?: Array<{ code: string; fullName: string; cruiseLineCode: string }> }>(PATHS.cruiseApiShips, {});
  const fresh = cached.at && now.getTime() - Date.parse(cached.at) < 30 * 86_400_000 && Array.isArray(cached.ships) && cached.ships.length > 0;
  let ships = fresh ? cached.ships! : [];
  if (!fresh && cruiseApiEnabled()) {
    const l = await loadLedger(now);
    if (l.refUsed < cruiseApiRefCap()) {
      l.refUsed += 1;
      try {
        const { status, body } = await call("/ships", { method: "GET" }, fetchImpl);
        const d = body as { data?: Array<{ code?: string; fullName?: string; cruiseLineCode?: string }> } | null;
        if (status === 200 && Array.isArray(d?.data)) {
          ships = d!.data!.filter((s) => s.code && s.fullName && s.cruiseLineCode).map((s) => ({ code: s.code!, fullName: s.fullName!, cruiseLineCode: s.cruiseLineCode! }));
          try { await writeJson(PATHS.cruiseApiShips, { at: now.toISOString(), ships }); } catch (err) { logger.warn({ err }, "cruise-api: ships cache persist failed"); }
          logger.info({ ships: ships.length, refUsed: l.refUsed }, "cruise-api: ships reference");
        } else logger.warn({ status, body }, "cruise-api: ships reference failed");
      } catch (err) { logger.warn({ err }, "cruise-api: ships threw"); }
      await saveLedger();
    }
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return new Map(ships.map((s) => [norm(s.fullName), { code: s.code, line: s.cruiseLineCode }]));
}
