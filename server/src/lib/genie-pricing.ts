// genie-pricing.ts — the fare for ONE sailing, by room type, for the Vacation Genie. Pure parts; the one
// network call is handed in.
//
// Source: the RapidAPI "Cruise API" we already pay for (cruise-api.ts). Facts this file leans on, all
// checked against the live API on 2026-11-15 (memory: stillafloat-cruise-api-capabilities):
//   - one search for a ship and a departure date returns a row PER ROOM TYPE (I / O / B / S);
//   - a cruisetour shares the ship, date and length with the plain cruise and costs more, so
//     cruiseType OCEAN_TOUR rows are left out;
//   - the fare is the line's own advertised figure, taxes and fees in, US dollars, and what it COVERS
//     differs by line: Carnival and Royal Caribbean advertise per person, Disney the whole room. The
//     other lines are not checked yet, so their figure is shown as the line's advertised fare and Mark
//     confirms the total. A fare here is never a quote: the page says so and Mark finalizes it.
import type { CruiseApiItem, SearchBody } from "./cruise-api";

export type RoomType = "inside" | "oceanview" | "balcony" | "suite";
const TYPE_BY_CODE: Record<string, RoomType> = { I: "inside", O: "oceanview", B: "balcony", S: "suite" };
export const ROOM_TYPE_ORDER: readonly RoomType[] = ["inside", "oceanview", "balcony", "suite"];

/** What the advertised figure covers, by the API's line code. Only lines checked against the line's own page are listed. */
export const PRICE_BASIS: Record<string, "per-person" | "room"> = { CA: "per-person", RC: "per-person", DI: "room" };

/** Lines whose fares the API only holds for two in a room. */
const DOUBLE_ONLY = new Set(["CO", "HA"]);

export interface Fare {
  type: RoomType;
  /** null when the room type is sold out or the line gave no figure. */
  price: number | null;
  status: "available" | "sold_out" | "unavailable" | "unknown";
  basis: "per-person" | "room" | "unconfirmed";
  /** When the line's figure was last refreshed, ISO, or null. */
  asOf: string | null;
}

export interface SailingFares {
  shipName: string; lineCode: string; start: string; nights: number | null;
  /** How many guests the fare was asked for (1 or 2: larger parties are priced by Mark). */
  guests: number;
  fares: Fare[];
  fetchedAt: string;
}

/** The guest count to ask the API for: it answers for one or two; a fuller room is Mark's to price. */
export function guestsToAsk(perRoom: number, lineCode: string): number {
  return perRoom <= 1 && !DOUBLE_ONLY.has(lineCode) ? 1 : 2;
}

export function fareSearchBody(o: { lineCode: string; shipCode: string; start: string; guests: number }): SearchBody {
  return {
    cruiseLineCodes: [o.lineCode], shipCodes: [o.shipCode], earliestStartDate: o.start, latestStartDate: o.start,
    numberOfGuests: [o.guests], pageSize: 10,
  };
}

const STATUSES = new Set(["available", "sold_out", "unavailable", "unknown"]);

/** Search rows -> one fare per room type for the sailing asked for. Empty fares = the API does not list it. */
export function faresFromRows(
  rows: readonly CruiseApiItem[],
  want: { shipName: string; lineCode: string; start: string; nights: number | null; guests: number },
  now = new Date(),
): SailingFares {
  const basis = PRICE_BASIS[want.lineCode] ?? "unconfirmed";
  const byType = new Map<RoomType, Fare>();
  for (const r of rows) {
    if (r.departureDate !== want.start) continue;
    if ((r.cruiseType ?? "OCEAN") !== "OCEAN") continue;
    if (want.nights !== null && typeof r.duration === "number" && r.duration !== want.nights) continue;
    const type = TYPE_BY_CODE[r.roomTypeCategoryCode ?? ""];
    if (!type) continue;
    const status = (STATUSES.has(r.availabilityStatus ?? "") ? r.availabilityStatus : r.soldOut ? "sold_out" : "unknown") as Fare["status"];
    const price = status === "available" && typeof r.roomPriceWithTaxesFees === "number" && r.roomPriceWithTaxesFees > 0
      ? Math.round(r.roomPriceWithTaxesFees) : null;
    const fare: Fare = { type, price, status, basis, asOf: r.lastUpdateTimestamp ?? null };
    const had = byType.get(type);
    // Two rows for one type (it happens across occupancies): keep the one with a figure, then the lower.
    if (!had || (had.price === null && price !== null) || (had.price !== null && price !== null && price < had.price)) byType.set(type, fare);
  }
  return {
    shipName: want.shipName, lineCode: want.lineCode, start: want.start, nights: want.nights, guests: want.guests,
    fares: ROOM_TYPE_ORDER.filter((t) => byType.has(t)).map((t) => byType.get(t)!),
    fetchedAt: now.toISOString(),
  };
}

/** A fare in words, for Mark's summary and the client's email. No dollar sign tricks: whole dollars, plain. */
export function fareLine(f: Fare, guests: number): string {
  const name = { inside: "Interior", oceanview: "Ocean view", balcony: "Balcony", suite: "Suite" }[f.type];
  if (f.price === null) return `${name}: ${f.status === "sold_out" ? "sold out" : "no fare listed"}`;
  const dollars = `$${f.price.toLocaleString("en-US")}`;
  const covers = f.basis === "per-person" ? `per person, ${guests === 1 ? "one in the room" : "two in a room"}`
    : f.basis === "room" ? `for the room, ${guests === 1 ? "one guest" : "two guests"}`
    : "as the line advertises it";
  return `${name}: ${dollars} ${covers}, taxes and fees included`;
}

// ── sailings a ship offers inside the traveler's dates ───────────────────────

export interface SailingRow { ship_name: string; operator: string | null; start_date: string; end_date: string | null; ports: unknown; source: string }
export interface SailingChoice { start: string; end: string | null; nights: number | null; ports: string[]; from: string | null }

const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);

/**
 * Our planned-sailings rows -> the choices to show: inside the dates, the right length, one row a
 * departure (the table holds the same sailing from more than one source), soonest first.
 */
export function sailingChoices(
  rows: readonly SailingRow[],
  want: { earliest: string; latest: string; nightsMin: number; nightsMax: number },
  limit = 12,
): SailingChoice[] {
  const seen = new Map<string, SailingChoice>();
  for (const r of rows) {
    if (r.start_date < want.earliest || r.start_date > want.latest) continue;
    const nights = r.end_date ? dayDiff(r.start_date, r.end_date) : null;
    if (nights !== null && (nights < want.nightsMin || nights > want.nightsMax)) continue;
    const ports = (Array.isArray(r.ports) ? r.ports : [])
      .map((p) => (p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string" ? (p as { name: string }).name : ""))
      .filter(Boolean);
    const key = `${r.start_date}|${nights ?? "?"}`;
    const had = seen.get(key);
    // Prefer the row that knows its length and names the most ports.
    if (!had || ports.length > had.ports.length) {
      seen.set(key, { start: r.start_date, end: r.end_date, nights, ports: [...new Set(ports)], from: ports[0] ?? null });
    }
  }
  return [...seen.values()].sort((a, b) => a.start.localeCompare(b.start)).slice(0, limit);
}
