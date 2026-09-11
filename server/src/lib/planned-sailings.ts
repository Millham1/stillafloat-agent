// planned-sailings.ts — operator itineraries as planned routes (pure parts).
//
// Mark, 2026-09-11: "the itinerary data is there to build the route ... you
// don't have to look back for anything" and "shouldn't that come from the
// operators? that way we can build out planned itineraries years in the
// future". First source: the July 2026 Widgety archive (ship.json per ship,
// `cruises[]` = the operator's published sailings, MSC + NCL, to Nov 2028).
// Each sailing is an ordered port list with a start date; the water route is
// assembled from stored port-pair legs (port_routes) at request time.
import { resolvePortName, resolvePortCode, type ResolvedPort } from "./world-ports";

export interface PlannedPort { name: string; slug: string | null; lat: number | null; lon: number | null }
export interface PlannedSailing {
  source: string;
  ref: string;
  shipName: string;        // provider's ship title (matched to the registry by the loader)
  operator: string | null;
  startDate: string;       // YYYY-MM-DD
  endDate: string | null;  // next sailing's start when the provider gives no length
  fromCode: string | null;
  toCode: string | null;
  nights: number | null;   // when the provider encodes it (NCL refs do)
  ordered: boolean;        // false when the provider gave headline ports, not the day order
  ports: PlannedPort[];
}

/**
 * Widgety refs come in two shapes:
 *   MSC:  MSCMR20281021SOUSOU          line+ship, YYYYMMDD, from, to
 *   NCL:  NCLVIV-20281020-10-IST-BCN   line+ship, YYYYMMDD, nights, from, to
 */
export function parseWidgetyRef(ref: string): { startDate: string; nights: number | null; fromCode: string | null; toCode: string | null } | null {
  const r = ref.trim();
  let y = 0, mo = 0, d = 0, nights: number | null = null, from: string | null = null, to: string | null = null;
  const ncl = /^[A-Z0-9]+-(\d{4})(\d{2})(\d{2})-(\d{1,3})-([A-Z0-9]{3})-([A-Z0-9]{3})$/.exec(r);
  const msc = /^[A-Z0-9]*?(\d{4})(\d{2})(\d{2})([A-Z0-9]{3})?([A-Z0-9]{3})?$/.exec(r);
  if (ncl) { y = Number(ncl[1]); mo = Number(ncl[2]); d = Number(ncl[3]); nights = Number(ncl[4]); from = ncl[5] ?? null; to = ncl[6] ?? null; }
  else if (msc) { y = Number(msc[1]); mo = Number(msc[2]); d = Number(msc[3]); from = msc[4] ?? null; to = msc[5] ?? null; }
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (isNaN(date.getTime()) || date.getUTCMonth() !== mo - 1) return null;
  return { startDate: date.toISOString().slice(0, 10), nights, fromCode: from, toCode: to };
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The provider's sailing name is either the day-by-day port list
 * ("Kiel,Copenhagen,Hellesylt,Alesund,Flaam,Kiel"), a headline
 * ("Greek Isles: Mykonos, Kusadasi & Athens"), or a repositioning pair
 * ("Barcelona, Copenhagen"). Headlines give the ports but not their order, so
 * the sequence is bracketed by the from/to codes and marked unordered.
 */
export function portNamesFromSailingName(name: string, fromCode: string | null, toCode: string | null): { names: string[]; ordered: boolean } {
  const raw = name.trim();
  const labelled = raw.includes(":") || raw.includes("&");
  if (labelled) {
    const after = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
    const heads = after.split(/,|&/).map((s) => s.trim()).filter(Boolean);
    const from = resolvePortCode(fromCode)?.name ?? null, to = resolvePortCode(toCode)?.name ?? null;
    const names = [...(from ? [from] : []), ...heads, ...(to ? [to] : [])];
    return { names, ordered: false };
  }
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length >= 3) return { names: list, ordered: true };
  // Two entries: a repositioning "A, B", or two countries; fall back to the codes.
  const from = resolvePortCode(fromCode)?.name ?? null, to = resolvePortCode(toCode)?.name ?? null;
  const resolvedList = list.filter((n) => resolvePortName(n));
  if (resolvedList.length === 2) return { names: resolvedList, ordered: true };
  return { names: [...(from ? [from] : []), ...(to && to !== from ? [to] : [])], ordered: true };
}

export function resolvePorts(names: readonly string[]): PlannedPort[] {
  return names.map((name) => {
    const r: ResolvedPort | null = resolvePortName(name);
    return r ? { name: r.name, slug: r.slug, lat: r.lat, lon: r.lon } : { name: name.trim(), slug: null, lat: null, lon: null };
  });
}

/** Parse one archived Widgety ship record into sailings (unsorted, no end dates yet). */
export function parseWidgetyShip(record: unknown, source = "widgety-archive"): PlannedSailing[] {
  if (!record || typeof record !== "object") return [];
  const r = record as Record<string, unknown>;
  const shipName = typeof r["title"] === "string" ? r["title"].trim() : "";
  const op = r["operator"];
  const operator = op && typeof op === "object" && typeof (op as Record<string, unknown>)["name"] === "string"
    ? String((op as Record<string, unknown>)["name"]) : typeof op === "string" ? op : null;
  const out: PlannedSailing[] = [];
  const seen = new Set<string>();
  for (const c of Array.isArray(r["cruises"]) ? (r["cruises"] as unknown[]) : []) {
    if (!c || typeof c !== "object") continue;
    const cr = c as Record<string, unknown>;
    const ref = typeof cr["ref"] === "string" ? cr["ref"].trim() : "";
    const parsed = ref ? parseWidgetyRef(ref) : null;
    if (!parsed || seen.has(ref) || !shipName) continue;
    seen.add(ref);
    const { names, ordered } = portNamesFromSailingName(typeof cr["name"] === "string" ? cr["name"] : "", parsed.fromCode, parsed.toCode);
    out.push({
      source, ref, shipName, operator, startDate: parsed.startDate,
      endDate: parsed.nights !== null ? addDays(parsed.startDate, parsed.nights) : null,
      fromCode: parsed.fromCode, toCode: parsed.toCode, nights: parsed.nights, ordered, ports: resolvePorts(names),
    });
  }
  return out;
}

/** Sort per ship by start date and set each sailing's end to the next one's start. */
export function withEndDates(sailings: readonly PlannedSailing[]): PlannedSailing[] {
  const byShip = new Map<string, PlannedSailing[]>();
  for (const s of sailings) byShip.set(s.shipName, [...(byShip.get(s.shipName) ?? []), s]);
  const out: PlannedSailing[] = [];
  for (const list of byShip.values()) {
    list.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.ref.localeCompare(b.ref));
    for (let i = 0; i < list.length; i++) {
      const next = list[i + 1];
      out.push({ ...list[i]!, endDate: list[i]!.endDate ?? (next ? next.startDate : null) });
    }
  }
  return out;
}

/** The sailing under way on `date` (YYYY-MM-DD): started on or before it and not yet ended. */
export function currentSailing<T extends { startDate: string; endDate: string | null }>(sailings: readonly T[], date: string): T | null {
  let best: T | null = null;
  for (const s of sailings) {
    if (s.startDate > date) continue;
    if (s.endDate && s.endDate <= date) continue;
    if (!best || s.startDate > best.startDate) best = s;
  }
  return best;
}

export type LegLookup = (fromSlug: string, toSlug: string) => readonly [number, number][] | null;

/**
 * Join stored legs into one line through the resolved ports, in order. A leg
 * with no stored route, or an unresolved port, leaves a gap rather than a
 * straight line — a ship cannot go through an island. Returns the polyline
 * segments (one per continuous run) and the resolved ports on the way.
 */
export function assembleRoute(ports: readonly PlannedPort[], legFor: LegLookup): { segments: [number, number][][]; nm: number | null; legs: number; missing: number } {
  const resolved = ports.filter((p): p is PlannedPort & { slug: string; lat: number; lon: number } => Boolean(p.slug && p.lat !== null && p.lon !== null));
  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  let legs = 0, missing = 0;
  for (let i = 0; i + 1 < resolved.length; i++) {
    const a = resolved[i]!, b = resolved[i + 1]!;
    if (a.slug === b.slug) continue;
    const leg = legFor(a.slug, b.slug);
    legs += 1;
    if (!leg || leg.length < 2) { missing += 1; if (current.length > 1) segments.push(current); current = []; continue; }
    if (current.length === 0) current.push([leg[0]![0], leg[0]![1]]);
    for (let j = 1; j < leg.length; j++) current.push([leg[j]![0], leg[j]![1]]);
  }
  if (current.length > 1) segments.push(current);
  return { segments, nm: null, legs, missing };
}
