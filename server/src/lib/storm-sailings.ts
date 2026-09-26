// storm-sailings.ts — itinerary-level (date + region aware) impacted-ship matching.
//
// A ship counts as impacted only if a sailing's regions overlap the storm's
// affected grounds AND its dates overlap the storm's forecast window. This
// replaces the coarse region-tag match (a Miami sailing isn't affected by an
// ABC-islands storm). Populated manually today; a real itinerary feed is the
// tracked follow-up.

import { getSupabase } from "./persistence";
import { logger } from "./logger";
import { portBySlug, distanceKm, CRUISE_LOCATIONS } from "./ports";
import { resolvePortSlug, resolvePortName } from "./port-resolve";
import { groundsForPoint } from "./storm-grounds";

/** Forward-looking deployments whose region overlaps the storm's grounds and
 *  whose season contains any part of the forecast window. Complements the
 *  AIS-derived current sailings — this is the "real itinerary feed" follow-up
 *  (ship_deployments, migration 0015), populated from the lines' published
 *  seasonal deployments. */
export async function deploymentsForStorm(
  grounds: string[], windowStart: string, windowEnd: string,
): Promise<Sailing[]> {
  if (!grounds.length) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("ship_deployments")
    .select("ship_name, cruise_line, homeport, region, season_start, season_end")
    .in("region", grounds)
    .lte("season_start", windowEnd)
    .gte("season_end", windowStart);
  if (error) return [];
  return (data ?? []).map((d: { ship_name: string; cruise_line: string | null; homeport: string | null; region: string; season_start: string; season_end: string }) => ({
    ship_name: d.ship_name,
    cruise_line: d.cruise_line ?? "",
    depart_port: d.homeport,
    start_date: d.season_start,
    end_date: d.season_end,
    regions: [d.region],
  }));
}

export interface Sailing {
  ship_name: string;
  cruise_line: string;
  depart_port: string | null;
  start_date: string; // YYYY-MM-DD
  end_date: string;
  regions: string[];
}

/** A sailing as the storm pages list it, with whether the ship can be tracked. */
export type TrackableSailing = Sailing & { trackable: boolean };

/**
 * Mark, 2026-09-15: "on the storm alerts, we should have a CTA for tracking their ship next
 * to each ship in the affected area. right now you have to go down several level to get to
 * the ship tracker, end then search for the specific ship. this is another path to
 * subscribers." Then: "it should be a direct link to sign up to the tracker with
 * subscription." Only a ship the tracker's registry knows gets the link, so the sign-up
 * never lands on "unknown ship". The link carries no dates: a storm-page watch runs 15 days
 * from the day it starts (ship-watch.ts). Pure: the registry lookup is passed in.
 */
export function withTrackable(
  sailings: readonly Sailing[],
  inRegistry: (shipName: string) => boolean,
): TrackableSailing[] {
  return sailings.map((s) => ({ ...s, trackable: Boolean(s.ship_name) && inRegistry(s.ship_name) }));
}

/** Default forecast window: today .. today+5 days (used when an alert has none). */
export function defaultWindow(): { start: string; end: string } {
  const now = new Date();
  const start = now.toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 5 * 86_400_000).toISOString().slice(0, 10);
  return { start, end };
}

/**
 * Sailings whose regions overlap `grounds` AND whose date range overlaps
 * [windowStart, windowEnd]. Overlap test: start_date <= windowEnd AND
 * end_date >= windowStart.
 */
export async function sailingsForStorm(
  grounds: string[], windowStart: string, windowEnd: string,
): Promise<Sailing[]> {
  if (!grounds.length) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("sailings")
    .select("ship_name, cruise_line, depart_port, start_date, end_date, regions")
    .eq("active", true)
    .overlaps("regions", grounds)
    .lte("start_date", windowEnd)
    .gte("end_date", windowStart);
  if (error) throw new Error(`sailingsForStorm: ${error.message}`);
  return ((data ?? []) as unknown as Sailing[]).sort(
    (a, b) => a.start_date.localeCompare(b.start_date) || a.ship_name.localeCompare(b.ship_name),
  );
}

// ── Published itineraries → impacted ships (2026-09-26, with the NWS source) ──
//
// `sailings` is AIS-derived and `ship_deployments` is hand-kept, so the two
// grounds added for nor'easters and Gulf of Alaska storms would have pinned
// nothing. planned_sailings (CruiseMapper, refreshed monthly) lists every
// published port call; 95% carry a slug and 18% a lat/lon, so a slug is
// resolved through the curated ports first and the world-ports table second.

export interface PlannedSailingRow {
  ship_name: string;
  operator: string | null;
  source: string;
  start_date: string;
  end_date: string | null;
  /** `date` (YYYY-MM-DD) is present on CruiseMapper rows — each call's day. */
  ports: Array<{ name?: string | null; slug?: string | null; lat?: number | null; lon?: number | null; date?: string | null }> | null;
}

export interface DateWindow { start: string; end: string }

/**
 * Does this port call happen inside the storm window? A call with a date is
 * judged by it; a call without one (the Widgety and Cruise API rows) can only
 * be judged by the sailing's overlap, which the caller already applied.
 */
export function callInWindow(port: { date?: string | null }, win: DateWindow | undefined): boolean {
  if (!win) return true;
  const d = typeof port.date === "string" ? port.date.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return true;
  return d >= win.start && d <= win.end;
}

export type PortLocator = (p: { slug?: string | null; lat?: number | null; lon?: number | null }) => { lat: number; lon: number } | null;

/** Curated ports, then the world-ports table, then the row's own coordinates. */
export const locatePort: PortLocator = (p) => {
  const slug = typeof p.slug === "string" ? p.slug.trim() : "";
  if (slug) {
    const c = portBySlug(slug);
    if (c) return { lat: c.lat, lon: c.lon };
    const w = resolvePortSlug(slug);
    if (w) return { lat: w.lat, lon: w.lon };
  }
  if (typeof p.lat === "number" && typeof p.lon === "number") return { lat: p.lat, lon: p.lon };
  return null;
};

/**
 * Sailings with a port inside any of `grounds` (a port is in a region box or
 * it is not — no margin). One entry per ship, the earliest sailing wins; the
 * same sailing from two sources collapses. Pure; tested.
 */
export function plannedRowsInGrounds(
  rows: readonly PlannedSailingRow[], grounds: readonly string[], locate: PortLocator = locatePort, win?: DateWindow,
): Sailing[] {
  const byShip = new Map<string, Sailing>();
  for (const row of rows) {
    if (!row.ship_name) continue;
    const regions = new Set<string>();
    for (const port of row.ports ?? []) {
      if (!callInWindow(port, win)) continue;
      const loc = locate(port);
      if (!loc) continue;
      for (const r of groundsForPoint(loc.lat, loc.lon, 0)) if (grounds.includes(r)) regions.add(r);
    }
    if (!regions.size) continue;
    const key = row.ship_name.trim().toLowerCase();
    const cur = byShip.get(key);
    if (cur && cur.start_date <= row.start_date) continue;
    const first = (row.ports ?? []).find((p) => p?.name)?.name ?? null;
    byShip.set(key, {
      ship_name: row.ship_name.trim(),
      cruise_line: row.operator ?? "",
      depart_port: first,
      start_date: row.start_date,
      end_date: row.end_date ?? row.start_date,
      regions: [...regions].sort(),
    });
  }
  return [...byShip.values()].sort((a, b) => a.start_date.localeCompare(b.start_date) || a.ship_name.localeCompare(b.ship_name));
}

// The window query returns ~1,000 rows with their port lists; every live alert
// asks for the same window during one scan or one dashboard load, so the raw
// rows are kept for a minute and the grounds filter runs in memory.
const PLANNED_CACHE_MS = 60_000;
const plannedCache = new Map<string, { at: number; rows: PlannedSailingRow[] }>();

async function plannedRowsForWindow(windowStart: string, windowEnd: string): Promise<PlannedSailingRow[]> {
  const key = `${windowStart}|${windowEnd}`;
  const hit = plannedCache.get(key);
  if (hit && Date.now() - hit.at < PLANNED_CACHE_MS) return hit.rows;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("planned_sailings")
    .select("ship_name, operator, source, start_date, end_date, ports")
    .lte("start_date", windowEnd)
    .or(`end_date.gte.${windowStart},end_date.is.null`)
    .limit(3000);
  if (error) {
    // A read failure pins nothing extra; the other two sources still apply.
    logger.warn({ err: error, windowStart, windowEnd }, "storm-sailings: planned_sailings read failed");
    return [];
  }
  const rows = (data ?? []) as unknown as PlannedSailingRow[];
  plannedCache.set(key, { at: Date.now(), rows });
  return rows;
}

export async function plannedSailingsForStorm(
  grounds: string[], windowStart: string, windowEnd: string,
): Promise<Sailing[]> {
  if (!grounds.length) return [];
  return plannedRowsInGrounds(await plannedRowsForWindow(windowStart, windowEnd), grounds, locatePort, { start: windowStart, end: windowEnd });
}

// ── Pinning by the storm's PATH (Mark, 2026-09-26) ────────────────────────────
//
// "We only ping a ship if the itinerary says it's in the path of the storm, or
// a client inquires about it." A region box is not a path: "U.S. East Coast"
// runs from Miami to Sandy Hook, so a nor'easter off New Jersey judged by the
// box pinned every Florida turnaround (50 ships for a storm that touched 5 or
// 6). An alert that knows where the storm is (NWS marine events carry the low,
// its 24/48 h positions and the waters under warning in `raw.path`) pins by
// distance to those points instead. Alerts with no path — NHC systems until
// their forecast points are parsed, and hand-declared storms — keep the
// grounds rule, which is what they have always used.

export interface PathPoint { kind: "low" | "f24" | "f48" | "zone"; lat: number; lon: number; label?: string }

/** A port call this close to warned waters is in the storm. */
export const PATH_ZONE_NM = 150;
/** …or this close to the low's position / forecast positions. */
export const PATH_LOW_NM = 250;

export function pathOf(raw: unknown): PathPoint[] {
  const p = (raw as { path?: unknown } | null)?.path;
  if (!Array.isArray(p)) return [];
  return p.filter((x): x is PathPoint =>
    Boolean(x) && typeof (x as PathPoint).lat === "number" && typeof (x as PathPoint).lon === "number" &&
    ["low", "f24", "f48", "zone"].includes(String((x as PathPoint).kind)));
}

const NM_PER_KM = 1 / 1.852;

/** Pure: is this point inside the storm's reach? Returns the reason, or null. */
export function nearPath(lat: number, lon: number, path: readonly PathPoint[]): string | null {
  for (const p of path) {
    const nm = distanceKm(lat, lon, p.lat, p.lon) * NM_PER_KM;
    const limit = p.kind === "zone" ? PATH_ZONE_NM : PATH_LOW_NM;
    if (nm <= limit) return `${Math.round(nm)} nm from ${p.label ?? p.kind}`;
  }
  return null;
}

/**
 * Sailings with a port call in the storm's reach DURING the window; one per
 * ship, earliest first. Pure. Mark, 2026-09-26: "I still can't see 30 ships
 * heading to or sailing out of the northeast" — without the call dates a
 * 12-day Montreal → New York cruise counted all week while it was still on the
 * St Lawrence. With them, only ships actually in the corridor this week count.
 */
export function plannedRowsNearPath(
  rows: readonly PlannedSailingRow[], path: readonly PathPoint[], locate: PortLocator = locatePort, win?: DateWindow,
): Sailing[] {
  if (!path.length) return [];
  const byShip = new Map<string, Sailing>();
  for (const row of rows) {
    if (!row.ship_name) continue;
    let hit = false;
    for (const port of row.ports ?? []) {
      if (!callInWindow(port, win)) continue;
      const loc = locate(port);
      if (loc && nearPath(loc.lat, loc.lon, path)) { hit = true; break; }
    }
    if (!hit) continue;
    const key = row.ship_name.trim().toLowerCase();
    const cur = byShip.get(key);
    if (cur && cur.start_date <= row.start_date) continue;
    const first = (row.ports ?? []).find((p) => p?.name)?.name ?? null;
    byShip.set(key, {
      ship_name: row.ship_name.trim(),
      cruise_line: row.operator ?? "",
      depart_port: first,
      start_date: row.start_date,
      end_date: row.end_date ?? row.start_date,
      regions: [],
    });
  }
  return [...byShip.values()].sort((a, b) => a.start_date.localeCompare(b.start_date) || a.ship_name.localeCompare(b.ship_name));
}

/** Where a port named the way `sailings.depart_port` names it sits. */
export function locatePortName(name: string | null | undefined): { lat: number; lon: number } | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  const c = CRUISE_LOCATIONS.find((p) => p.name.toLowerCase() === n || p.slug === n);
  if (c) return { lat: c.lat, lon: c.lon };
  const w = resolvePortName(name);
  return w ? { lat: w.lat, lon: w.lon } : null;
}

/** The AIS-derived current sailings whose departure port is in the storm's reach. Pure. */
export function sailingsNearPath(
  sailings: readonly Sailing[], path: readonly PathPoint[], locate: (name: string | null | undefined) => { lat: number; lon: number } | null = locatePortName,
): Sailing[] {
  if (!path.length) return [];
  return sailings.filter((s) => {
    const loc = locate(s.depart_port);
    return loc ? nearPath(loc.lat, loc.lon, path) !== null : false;
  });
}

/**
 * THE impacted-ships answer for an alert — used by the lifecycle (pins) and the
 * public/dashboard lists, so they always agree. Path when the alert has one;
 * grounds otherwise. One entry per ship.
 */
export async function impactedShipsForAlert(
  a: { affected_grounds: string[]; raw?: unknown }, windowStart: string, windowEnd: string,
): Promise<Sailing[]> {
  const grounds = a.affected_grounds ?? [];
  if (!grounds.length) return [];
  const path = pathOf(a.raw);
  const derived = await sailingsForStorm(grounds, windowStart, windowEnd);
  const out: Sailing[] = [];
  const seen = new Set<string>();
  const add = (list: readonly Sailing[]): void => {
    for (const x of list) {
      const k = x.ship_name.trim().toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
  };
  if (path.length) {
    add(sailingsNearPath(derived, path));
    add(plannedRowsNearPath(await plannedRowsForWindow(windowStart, windowEnd), path, locatePort, { start: windowStart, end: windowEnd }));
    return out;
  }
  add(derived);
  add(await deploymentsForStorm(grounds, windowStart, windowEnd));
  add(await plannedSailingsForStorm(grounds, windowStart, windowEnd));
  return out;
}
