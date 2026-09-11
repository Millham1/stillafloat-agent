// planned-route-service.ts — the planned itinerary and its stored water route for a ship.
//
// Answers "what is she scheduled to do right now" from planned_sailings (the
// operators' itineraries) and port_routes (water legs computed once), so the
// map can draw the whole route the instant a ship is selected — with or
// without a fix. Read-through caches keep the position route fast.
import { getSupabase } from "./persistence";
import { logger } from "./logger";
import { currentSailing, assembleRoute, type PlannedPort } from "./planned-sailings";

interface SailingRow { ref: string; source: string; ship_name: string; operator: string | null; start_date: string; end_date: string | null; ports: (PlannedPort & { ordered?: boolean })[] }
export interface PlannedRoute {
  ref: string; source: string; operator: string | null;
  startDate: string; endDate: string | null; ordered: boolean;
  ports: PlannedPort[];
  segments: [number, number][][];   // water line(s) through the resolved ports
  legs: number; missing: number;    // legs on the itinerary, legs with no stored water path
}

const SAILINGS_TTL_MS = 60 * 60 * 1000;
const sailingsCache = new Map<string, { at: number; rows: SailingRow[] }>();
const legCache = new Map<string, [number, number][] | null>();

async function sailingsFor(shipName: string): Promise<SailingRow[]> {
  const key = shipName.toLowerCase();
  const hit = sailingsCache.get(key);
  if (hit && Date.now() - hit.at < SAILINGS_TTL_MS) return hit.rows;
  const supabase = getSupabase();
  const { data, error } = await supabase.from("planned_sailings")
    .select("ref, source, ship_name, operator, start_date, end_date, ports")
    .ilike("ship_name", shipName)
    .order("start_date", { ascending: true })
    .limit(2000);
  if (error) { logger.warn({ err: error, shipName }, "planned-route: sailings read failed"); return hit?.rows ?? []; }
  const rows = (data ?? []) as SailingRow[];
  sailingsCache.set(key, { at: Date.now(), rows });
  return rows;
}

async function legsFor(pairs: string[]): Promise<void> {
  const missing = pairs.filter((k) => !legCache.has(k));
  if (!missing.length) return;
  const supabase = getSupabase();
  const or = missing.map((k) => { const [a, b] = k.split(">"); return `and(from_slug.eq.${a},to_slug.eq.${b})`; }).join(",");
  const { data, error } = await supabase.from("port_routes").select("from_slug, to_slug, points").or(or);
  if (error) { logger.warn({ err: error }, "planned-route: legs read failed"); return; }
  for (const k of missing) legCache.set(k, null);
  for (const r of (data ?? []) as { from_slug: string; to_slug: string; points: [number, number][] }[]) legCache.set(`${r.from_slug}>${r.to_slug}`, r.points);
}

/** The sailing under way for this ship on `now`, with its water route, or null when nothing is planned. */
export async function plannedRouteFor(shipName: string, now = new Date()): Promise<PlannedRoute | null> {
  const rows = await sailingsFor(shipName);
  if (!rows.length) return null;
  const today = now.toISOString().slice(0, 10);
  const cur = currentSailing(rows.map((r) => ({ ...r, startDate: r.start_date, endDate: r.end_date })), today);
  if (!cur) return null;
  const ports: PlannedPort[] = (cur.ports ?? []).map((p) => ({ name: p.name, slug: p.slug, lat: p.lat, lon: p.lon }));
  const ordered = (cur.ports ?? []).every((p) => p.ordered !== false);
  const pairs: string[] = [];
  const rp = ports.filter((p) => p.slug);
  for (let i = 0; i + 1 < rp.length; i++) if (rp[i]!.slug !== rp[i + 1]!.slug) pairs.push(`${rp[i]!.slug}>${rp[i + 1]!.slug}`);
  await legsFor(pairs);
  const route = assembleRoute(ports, (a, b) => legCache.get(`${a}>${b}`) ?? null);
  return { ref: cur.ref, source: cur.source, operator: cur.operator, startDate: cur.start_date, endDate: cur.end_date, ordered, ports, segments: route.segments, legs: route.legs, missing: route.missing };
}

/** For tests and the loader: drop caches. */
export function resetPlannedRouteCaches(): void { sailingsCache.clear(); legCache.clear(); }
