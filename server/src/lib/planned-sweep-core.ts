// planned-sweep-core.ts — the pure rules for keeping operator itineraries current.
//
// Mark bought the Cruise API Pro plan on 2026-09-13 (4,000 searches and 2,000
// reference calls a month). The refresh was written for the free plan: one
// ten-sailing page per ship, which is about six weeks of itinerary for a ship
// on short cruises. His goal is itineraries years ahead, from the operators,
// so each ship is now paged through a two-year window.
//
// Measured against the live API on 2026-09-13:
//   - pageSize above 10 is rejected ("Number must be less than or equal to 10")
//   - Utopia of the Seas, the worst case, has 166 sailings in two years = 17 pages
//   - 156 of our 315 registry ships are on lines the API carries
// A full fleet pass is roughly 1,400 searches, so the fleet refreshes about
// twice a month inside the allowance.
//
// Everything here is pure; planned-sailings-refresh.ts does the calls and writes.

export const CRUISE_API_PAGE_SIZE = 10;       // the API's maximum
export const DEFAULT_HORIZON_DAYS = 730;      // two years ahead
export const LOOKBACK_DAYS = 15;              // keeps the sailing already under way in the window
export const UNKNOWN_SHIP_PAGES = 20;          // budget held for a ship never swept before
export const LIVE_SOURCE = "rapidapi-cruise";

export interface SweepPage<T> { sailings: T[]; totalResults: number; totalPages: number }
export interface SweepResult<T> {
  sailings: T[];
  pagesUsed: number;
  /** Every page came back and the result count never moved while we read. */
  complete: boolean;
  totalResults: number | null;
  /** The page count the API reported, so the next run can hold enough budget. */
  totalPages: number | null;
}

/**
 * Read a ship's sailings page by page. Stops at the first failed page. A sweep
 * is only `complete` when every page arrived and the API's total did not
 * change mid-read; a shifted total means page boundaries moved and a sailing
 * may have been skipped, so nothing may be removed on the strength of it.
 */
export async function sweepShip<T>(
  fetchPage: (page: number) => Promise<SweepPage<T> | null>,
  maxPages: number,
): Promise<SweepResult<T>> {
  const sailings: T[] = [];
  let pagesUsed = 0;
  let firstTotal: number | null = null;
  let totalPages = 1;
  for (let page = 1; page <= totalPages && page <= maxPages; page++) {
    const res = await fetchPage(page);
    pagesUsed += 1;
    if (!res) return { sailings, pagesUsed, complete: false, totalResults: firstTotal, totalPages: firstTotal === null ? null : totalPages };
    if (firstTotal === null) {
      firstTotal = res.totalResults;
      totalPages = Math.max(1, res.totalPages);
    } else if (res.totalResults !== firstTotal) {
      sailings.push(...res.sailings);
      return { sailings, pagesUsed, complete: false, totalResults: res.totalResults, totalPages: Math.max(1, res.totalPages) };
    }
    sailings.push(...res.sailings);
  }
  const complete = firstTotal !== null && pagesUsed >= totalPages;
  return { sailings, pagesUsed, complete, totalResults: firstTotal, totalPages: firstTotal === null ? null : totalPages };
}

/**
 * The dates a sweep can vouch for. The API lists only sailings that have not
 * departed, whatever earliestStartDate asks for (measured 2026-09-13: Carnival
 * Sunrise, asked from 15 days back, came back starting tomorrow). So a sailing
 * already under way is absent from every sweep, and must never be read as
 * cancelled — it is the one the map is drawing. Removal starts tomorrow.
 */
export function removableWindow(today: string, to: string): { from: string; to: string } {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return { from: d.toISOString().slice(0, 10), to };
}

/**
 * Stored live-source sailings in the swept window that the operator no longer
 * lists — cancelled or re-planned. Nothing is removed unless the sweep was
 * complete, and an empty sweep never wipes a ship: an API that suddenly
 * returns nothing for a ship with a stored plan is more likely broken than
 * the ship retired.
 */
export function refsToRemove(
  stored: readonly { ref: string; startDate: string }[],
  seenRefs: ReadonlySet<string>,
  window: { from: string; to: string },
  complete: boolean,
): string[] {
  if (!complete || seenRefs.size === 0) return [];
  return stored
    .filter((s) => s.startDate >= window.from && s.startDate <= window.to && !seenRefs.has(s.ref))
    .map((s) => s.ref);
}

/**
 * Where the live operator feed covers a ship's dates, it wins: rows from any
 * other source (the one-time Widgety archive) that start inside the live
 * source's date span are dropped. Outside that span the older rows still
 * stand, so a ship keeps its long-range plan where the API has not reached.
 * Read-time only — nothing Mark loaded is deleted.
 */
export function preferLiveSailings<T extends { source: string; startDate: string }>(rows: readonly T[]): T[] {
  const live = rows.filter((r) => r.source === LIVE_SOURCE);
  if (!live.length) return [...rows];
  let from = live[0]!.startDate, to = live[0]!.startDate;
  for (const r of live) { if (r.startDate < from) from = r.startDate; if (r.startDate > to) to = r.startDate; }
  return rows.filter((r) => r.source === LIVE_SOURCE || r.startDate < from || r.startDate > to);
}

/**
 * Searches that may be spent now, from the API's own remaining count. The API
 * resets on its billing cycle, not on the calendar month our ledger uses, so
 * its header is the authority. A reserve of 5% (at least 5) stays untouched
 * for checks by hand. Unknown (no header seen yet) means no limit from here;
 * the ledger cap still applies.
 */
export function searchAllowance(api: { remaining: number | null; limit: number | null }): number {
  if (api.remaining === null || !Number.isFinite(api.remaining)) return Number.POSITIVE_INFINITY;
  const reserve = Math.max(5, Math.ceil((api.limit ?? 0) * 0.05));
  return Math.max(0, api.remaining - reserve);
}

/** Pages to hold before starting a ship, so a sweep never straddles two runs. */
export function pagesToHold(lastPages: number | undefined): number {
  return Number.isFinite(lastPages) && (lastPages ?? 0) > 0 ? (lastPages as number) + 1 : UNKNOWN_SHIP_PAGES;
}
