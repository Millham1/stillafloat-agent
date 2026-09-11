// cruise-api-core.ts — RapidAPI "Cruise API" (cruise-api1) as an operator-itinerary source, pure parts.
//
// Subscribed 2026-09-11 on the Basic plan: 50 searches + 50 basic reference
// calls a month, 10 rows per page, one row PER ROOM TYPE (so a sailing shows
// up to four times unless the search is filtered to one room type). Lines:
// Carnival, Celebrity, Costa, Cunard, Disney, Holland America, MSC, Norwegian,
// Princess, Royal Caribbean, Virgin. A basic-tier search item carries what the
// planned-route table needs: departureDate, duration (nights), the ordered
// itineraryPorts (LOCODE-style codes, "XZAS1" = at sea) with hydrated names,
// and the ship's full name — verified with a live call on 2026-09-11.
import { resolvePortName, type ResolvedPort } from "./world-ports";
import type { PlannedSailing, PlannedPort } from "./planned-sailings";
import portsRef from "../../data/cruise-api-ports.json";

export const CRUISE_API_DEFAULT_HOST = "cruise-api1.p.rapidapi.com";
export const CRUISE_API_LINES: Record<string, string> = {
  CA: "Carnival", CE: "Celebrity", CO: "Costa", CU: "Cunard", DI: "Disney Cruise Line", HA: "Holland America",
  MS: "MSC", NO: "Norwegian", PR: "Princess", RC: "Royal Caribbean", VI: "Virgin Voyages",
};
export const AT_SEA_CODES = new Set(["XZAS1", "XZAS2", "XZAS3", "XZSEA"]);

interface PortRef { portCode: string; portName: string; portCountryCode: string; scenicCruising?: boolean; landPort?: boolean }
const PORT_NAME_BY_CODE = new Map<string, PortRef>((portsRef as PortRef[]).map((p) => [p.portCode, p]));

/** A Cruise API port code → a routable coordinate: by the API's own port name, then by the LOCODE tail. */
export function resolveCruiseApiPort(code: string, hydratedName?: string | null): ResolvedPort | null {
  if (!code || AT_SEA_CODES.has(code)) return null;
  const ref = PORT_NAME_BY_CODE.get(code);
  if (ref?.scenicCruising || ref?.landPort) return null;   // glacier viewing / land tour days are not ports
  const name = hydratedName || ref?.portName || "";
  return (name ? resolvePortName(name) : null) ?? null;
}

export interface CruiseApiItem {
  cruiseId?: string; cruiseName?: string; cruiseType?: string; cruiseLineCode?: string;
  departureDate?: string; duration?: number; itineraryPorts?: string[];
  itineraryPortsHydrated?: Array<{ portCode?: string; portName?: string; portCountryCode?: string }>;
  shipCode?: string; shipHydrated?: { code?: string; fullName?: string; shortName?: string; cruiseLineCode?: string };
  roomTypeCategoryCode?: string; soldOut?: boolean; itineraryUrl?: string;
  cruiseLineHydrated?: { code?: string; fullName?: string; shortName?: string };
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
}

/** Stable per-sailing key: the API's cruiseId differs per room type, the ship/date/length does not. */
export function cruiseApiRef(item: CruiseApiItem): string | null {
  const ship = item.shipCode ?? item.shipHydrated?.code;
  if (!ship || !item.departureDate || !/^\d{4}-\d{2}-\d{2}$/.test(item.departureDate)) return null;
  return `rapidapi:${item.cruiseLineCode ?? "?"}:${ship}:${item.departureDate}:${item.duration ?? "?"}`;
}

/** Search items → one PlannedSailing per sailing (room-type duplicates collapsed). */
export function parseCruiseApiItems(items: readonly CruiseApiItem[], source = "rapidapi-cruise"): PlannedSailing[] {
  const out = new Map<string, PlannedSailing>();
  for (const it of items) {
    const ref = cruiseApiRef(it);
    if (!ref || out.has(ref)) continue;
    const shipName = (it.shipHydrated?.fullName ?? "").trim();
    if (!shipName) continue;
    const nights = typeof it.duration === "number" && it.duration > 0 ? it.duration : null;
    const codes = Array.isArray(it.itineraryPorts) ? it.itineraryPorts : [];
    const hydrated = new Map((it.itineraryPortsHydrated ?? []).map((h) => [h.portCode ?? "", h.portName ?? ""]));
    const ports: PlannedPort[] = [];
    for (const code of codes) {
      if (AT_SEA_CODES.has(code)) continue;
      const r = resolveCruiseApiPort(code, hydrated.get(code) ?? null);
      const name = hydrated.get(code) || PORT_NAME_BY_CODE.get(code)?.portName || code;
      ports.push(r ? { name: r.name, slug: r.slug, lat: r.lat, lon: r.lon } : { name, slug: null, lat: null, lon: null });
    }
    out.set(ref, {
      source, ref, shipName,
      operator: CRUISE_API_LINES[it.cruiseLineCode ?? ""] ?? it.cruiseLineHydrated?.fullName ?? it.cruiseLineCode ?? null,
      startDate: it.departureDate!,
      endDate: nights !== null ? addDays(it.departureDate!, nights) : null,
      fromCode: codes[0] ?? null, toCode: codes.length ? codes[codes.length - 1]! : null,
      nights, ordered: true, ports,
    });
  }
  return [...out.values()];
}

/**
 * Keys under which a ship name should be findable. The API prefixes some names
 * with the line ("Cunard Queen Mary 2", "Virgin Scarlet Lady", "Carnival Mardi
 * Gras") where the registry does not, so index both spellings.
 */
export function shipNameKeys(fullName: string): string[] {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const n = norm(fullName);
  const stripped = n.replace(/^(cunard|virgin|carnival|disney|celebrity|norwegian|msc|princess|costa|holland america|royal caribbean) /, "");
  return stripped && stripped !== n ? [n, stripped] : [n];
}
