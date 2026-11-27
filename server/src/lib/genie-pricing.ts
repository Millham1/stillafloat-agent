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
// Each checked against the line's own page for a live sailing (API figure, two guests, interior):
//   CA, RC  per person (checked 2026-11-15, carnival.com / royalcaribbean.com)      DI  whole room
//   PR  2026-11-27  princess.com: "$999 ... Price in USD, avg/person, 2 guests, includes taxes and fees" (API 999)
//   CU  2026-11-27  cunard.com: "From $2,579 per person ... based on double occupancy, includes taxes" (API 2579)
//   CE  2026-11-27  celebritycruises.com: "Starting from price displayed is per person" (API 1074.88; one guest 2337.38)
//   HA  2026-11-27  hollandamerica.com: "INSIDE FROM $749 pp" (API 869: per person, the page's headline is lower)
//   CO  2026-11-27  costacruises.com: "Total 2 Guests from $3,481 / Price per person from $1,740" (API 1780.65 = the per-person figure)
//   VI  2026-11-27  virginvoyages.com: "Estimated voyage total for 2 Sailors from: $1,490" (API 1490 = the total for two)
//   MS, NO  2026-11-27  Mark: "MSC is per person. Norwegian is per person." (My own page checks did not settle them:
//           msccruisesusa.com showed "Total Price $1,676.42" for two against an API 913; ncl.com's page could not be read.)
// All eleven lines the API carries are now listed. A line code that is not here still reads as unconfirmed.
export const PRICE_BASIS: Record<string, "per-person" | "room"> = {
  CA: "per-person", RC: "per-person", DI: "room", PR: "per-person", CU: "per-person", CE: "per-person", HA: "per-person", CO: "per-person", VI: "room", MS: "per-person", NO: "per-person",
};

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
 * Which of the Genie's destinations a sailing goes to, read from its own itinerary: the port list that
 * arrives with the sailing's dates, from the same source, in the same pass. No map positions (Mark,
 * 2026-11-27: "the itinerary should be coming from the same API we get the sailing dates. It does not
 * need to rely on geopositioning"). The source prints every port with its island or country
 * ("Oranjestad Aruba, Netherlands Antilles", "Juneau, Alaska", "Cozumel, Mexico, Riviera Maya"), so the
 * name says where it is. A sailing goes to a destination when at least one port of call is there; the
 * home port usually is not, which is the point (Miami is not the Bahamas).
 *
 * The lines between Eastern and Southern (Guadeloupe and south is Southern, Antigua and north Eastern)
 * and what counts as Western are a judgment; they are here, in one place, to be corrected. "Dominicana"
 * is the Dominican Republic (Eastern), "Dominica" the island (Southern). Spain and France have Atlantic
 * coasts too, so their Mediterranean ports are named one by one or by "Riviera" / "Costa".
 */
const DESTINATION_PORTS: readonly [string, RegExp][] = [
  ["alaska", /\bAlaska\b/i],
  ["bahamas", /\bBahamas\b/i],
  ["mexican_riviera", /Mexic\w* Riviera|\bBaja\b|\b(Sonora|Sinaloa|Jalisco|Nayarit|Colima|Guerrero|Oaxaca|Chiapas)\b/i],
  ["w_caribbean", /Cozumel|Costa Maya|Riviera Maya|Yucatan|Progreso|\bBelize\b|Roatan|\bHonduras\b|Cayman|\bJamaica\b|Lim[oó]n\b|\bColon\b.*Panama|Santo Tomas de Castilla/i],
  ["e_caribbean", /Puerto Rico|Virgin Islands|\bUSVI\b|\bBVI\b|St\.? Thomas|St\.? Croix|Tortola|Virgin Gorda|Jost Van Dyke|S(?:ain)?t\.? Maarten|Sint Maarten|S(?:ain)?t\.? Martin|S(?:ain)?t\.? Kitts|\bNevis\b|\bAntigua\b|\bAnguilla\b|St\.? Barth|\bSaba\b|Montserrat|Dominicana|Dominican Republic|Turks|\bHaiti\b/i],
  ["s_caribbean", /\bAruba\b|\bBonaire\b|Cura[cç]ao|\bBarbados\b|S(?:ain)?t\.? Lucia|\bGrenada\b|Grenadines|S(?:ain)?t\.? Vincent|Martinique|\bDominica\b|Guadeloupe|Trinidad|\bTobago\b|Cartagena.*Colombia|Santa Marta/i],
  ["mediterranean", /\b(Italy|Sicily|Sardinia|Greece|Crete|Croatia|Montenegro|Slovenia|Albania|Malta|Cyprus|Corsica|Monaco|Turkey|Tunisia|Balearic|Gibraltar)\b|France Riviera|Spain Costa (Brava|Daurada|del Sol)|\b(Barcelona|Valencia|Malaga|Alicante|Tarragona|Almeria|Motril|Castellon)\b|Cartagena Spain/i],
];

/** The destinations a sailing's ports put it in, by each port's printed name. */
export function regionsOfPorts(ports: unknown): Set<string> {
  const out = new Set<string>();
  for (const p of Array.isArray(ports) ? ports : []) {
    const name = (p as { name?: unknown } | null)?.name;
    if (typeof name !== "string") continue;
    for (const [region, re] of DESTINATION_PORTS) if (re.test(name)) out.add(region);
  }
  return out;
}

/**
 * Our planned-sailings rows -> the choices to show: inside the dates, the right length, one row a
 * departure (the table holds the same sailing from more than one source), soonest first.
 */
export function sailingChoices(
  rows: readonly SailingRow[],
  want: { earliest: string; latest: string; nightsMin: number; nightsMax: number; destination?: string },
  limit = 12,
): SailingChoice[] {
  const seen = new Map<string, SailingChoice>();
  const region = want.destination && want.destination !== "surprise" ? want.destination : null;
  for (const r of rows) {
    if (r.start_date < want.earliest || r.start_date > want.latest) continue;
    const nights = r.end_date ? dayDiff(r.start_date, r.end_date) : null;
    if (nights !== null && (nights < want.nightsMin || nights > want.nightsMax)) continue;
    // They named where they want to go: a sailing counts only when one of its ports of call is there.
    if (region && !regionsOfPorts(r.ports).has(region)) continue;
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
