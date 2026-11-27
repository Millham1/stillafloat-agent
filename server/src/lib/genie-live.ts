// genie-live.ts — the Vacation Genie's ship search on the fare service's own destination search.
//
// Mark, 2026-11-27: "you are thinking about it backwards I think. itinerary follows destination." and
// "the destination should be pulled with the pricing." The traveler names where they want to go; we ask
// the fare service (RapidAPI Cruise API) for sailings TO THAT DESTINATION inside their dates and length,
// and what comes back is the itinerary and the price together. Checked live the same day: his own trip
// (May 2027, six to eight nights, Southern Caribbean, interior) came back as 20 sailings in 2 searches.
//
// The service carries eleven lines. For a ship it does not carry (Margaritaville at Sea, a few others)
// the caller falls back to our own planned_sailings table; see routes/genie.ts.
//
// Cost: one search a page of ten, one request a second. A page cap keeps a wide-open request ("any
// length, six months") from spending the month's allowance; past the cap the answer is marked incomplete
// and the caller checks the table for the ships the pages did not reach.

import { searchCruiseRows, type SearchBody } from "./cruise-api";
import { shipNameKeys, type CruiseApiItem } from "./cruise-api-core";
import { PRICE_BASIS, type SailingChoice } from "./genie-pricing";

/** The Genie's destination words in the fare service's own codes (GET /destinations, read 2026-11-27). */
export const DESTINATION_CODES: Record<string, string> = {
  e_caribbean: "CE",      // Caribbean (Eastern)
  w_caribbean: "CW",      // Caribbean (Western)
  s_caribbean: "CS",      // Caribbean (Southern)
  bahamas: "BH",          // Bahamas
  alaska: "AK",           // Alaska
  mediterranean: "MA",    // Mediterranean (All)
  mexican_riviera: "MC",  // Mexico & Central America: the service has no narrower word for the Riviera
};

/** Pages read for one question (ten sailings a page, a second apart). */
export const LIVE_MAX_PAGES = 8;
const TTL_MS = 6 * 60 * 60 * 1000;

export interface LiveTrip { earliest: string; latest: string; nightsMin: number; nightsMax: number; destination: string }

/** A sailing as the fare service lists it: the choice the page shows, plus whose it is and the interior fare. */
export interface LiveSailing extends SailingChoice {
  ship: string;
  lineCode: string;
  /** The service's own name for the cruise ("7-Day Western Caribbean from Galveston, TX"). */
  name: string | null;
  /** The service's destination names for it ("Caribbean (Western)", …). */
  destinations: string[];
  /** Interior fare for two, taxes and fees in, as the line advertises it. null when sold out or not given. */
  fromPrice: number | null;
  /** What that figure covers for this line. */
  basis: "per-person" | "room" | "unconfirmed";
}

/**
 * The search for one page of the traveler's question, or null when the service cannot be asked it:
 * "surprise me" names no destination, and a window that is already over has nothing to search.
 * The service refuses a start date before today (HTTP 422), so the window is pulled up to today.
 */
export function liveSearchBody(trip: LiveTrip, today: string, page: number): SearchBody | null {
  const code = DESTINATION_CODES[trip.destination];
  if (!code) return null;
  const from = trip.earliest < today ? today : trip.earliest;
  if (trip.latest < from) return null;
  return {
    earliestStartDate: from, latestStartDate: trip.latest, durationMin: trip.nightsMin, durationMax: trip.nightsMax,
    destinations: [code], roomTypeCategoryCodes: ["I"], numberOfGuests: [2], cruiseTypes: ["OCEAN"], page, pageSize: 10,
  };
}

const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

/** Search rows -> sailings, one per departure of a ship, soonest first. Days at sea are not ports. */
export function liveSailingsFromRows(rows: readonly CruiseApiItem[]): LiveSailing[] {
  const seen = new Map<string, LiveSailing>();
  for (const r of rows) {
    const ship = r.shipHydrated?.fullName, start = r.departureDate;
    if (!ship || !start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) continue;
    if ((r.cruiseType ?? "OCEAN") !== "OCEAN") continue;
    const nights = typeof r.duration === "number" ? r.duration : null;
    const names = new Map((r.itineraryPortsHydrated ?? []).map((h) => [h.portCode ?? "", h.portName ?? ""]));
    const ports: string[] = [];
    for (const code of r.itineraryPorts ?? []) {
      if (/^XZ/.test(code)) continue;                       // "XZAS1" and its kin: a day at sea
      const name = names.get(code);
      if (name && ports[ports.length - 1] !== name) ports.push(name);
    }
    const lineCode = r.cruiseLineCode ?? r.shipHydrated?.cruiseLineCode ?? "";
    const price = r.availabilityStatus === "available" && typeof r.roomPriceWithTaxesFees === "number" && r.roomPriceWithTaxesFees > 0
      ? Math.round(r.roomPriceWithTaxesFees) : null;
    const key = `${ship}|${start}|${nights ?? "?"}`;
    const had = seen.get(key);
    if (had && (had.fromPrice !== null || price === null)) continue;
    seen.set(key, {
      start, end: nights !== null ? addDays(start, nights) : null, nights, ports: [...new Set(ports)], from: ports[0] ?? null,
      ship, lineCode, name: r.cruiseName ?? null,
      destinations: (r.itineraryDestinationsHydrated ?? []).map((d) => d.name ?? "").filter(Boolean),
      fromPrice: price, basis: PRICE_BASIS[lineCode] ?? "unconfirmed",
    });
  }
  return [...seen.values()].sort((a, b) => a.start.localeCompare(b.start) || a.ship.localeCompare(b.ship));
}

export interface LiveAnswer {
  /** false = the pages ran out before the list did, or a later page failed: ships not listed may still sail. */
  complete: boolean;
  /** Every spelling of a ship's name (shipNameKeys) -> her sailings. */
  byShip: Map<string, LiveSailing[]>;
  sailings: number;
}

/** Index sailings under every spelling of their ship's name. Exported for tests. */
export function indexByShip(sailings: readonly LiveSailing[]): Map<string, LiveSailing[]> {
  const byName = new Map<string, LiveSailing[]>();
  for (const s of sailings) { const l = byName.get(s.ship) ?? []; l.push(s); byName.set(s.ship, l); }
  const out = new Map<string, LiveSailing[]>();
  for (const [name, list] of byName) out.set(shipNameKeys(name)[0]!, list);
  for (const [name, list] of byName) for (const k of shipNameKeys(name).slice(1)) if (!out.has(k)) out.set(k, list);
  return out;
}

const cache = new Map<string, { at: number; out: LiveAnswer }>();

/**
 * Ask the fare service for the traveler's sailings. null = it could not be asked (no destination named,
 * the service is off, the day's allowance is spent, or the first page failed): use the table.
 */
export async function liveSailings(
  trip: LiveTrip,
  search: (b: SearchBody) => Promise<{ rows: CruiseApiItem[]; totalResults: number; totalPages: number } | null> = (b) => searchCruiseRows(b),
  now = new Date(),
): Promise<LiveAnswer | null> {
  const today = now.toISOString().slice(0, 10);
  if (!liveSearchBody(trip, today, 1)) return null;
  const key = [trip.earliest, trip.latest, trip.nightsMin, trip.nightsMax, trip.destination].join("|");
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < TTL_MS) return hit.out;

  const rows: CruiseApiItem[] = [];
  let complete = false;
  for (let page = 1; page <= LIVE_MAX_PAGES; page++) {
    const r = await search(liveSearchBody(trip, today, page)!);
    if (!r) { if (page === 1) return null; break; }
    rows.push(...r.rows);
    if (page >= r.totalPages || r.rows.length === 0) { complete = true; break; }
  }
  const sailings = liveSailingsFromRows(rows);
  const out: LiveAnswer = { complete, byShip: indexByShip(sailings), sailings: sailings.length };
  if (cache.size > 200) cache.clear();
  cache.set(key, { at: now.getTime(), out });
  return out;
}

/** Her sailings in a live answer, by any spelling of her name. */
export function liveSailingsOf(answer: LiveAnswer, shipName: string): LiveSailing[] | null {
  for (const k of shipNameKeys(shipName)) { const l = answer.byShip.get(k); if (l) return l; }
  return null;
}
