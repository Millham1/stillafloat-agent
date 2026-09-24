// planned-itinerary.ts — "what ports is this ship SUPPOSED to call at today?"
//
// The storm course-change detector used to infer a ship's normal run from the
// ports a terrestrial AIS receiver happened to hear her at. That produced 25
// false diversions in three days (see the header of storm-diversion.ts). This
// module answers the same question from the operator's own published
// itinerary instead, which is the only source that was ever right.
//
// Reads `planned_sailings` (migration 0034): one row per sailing per source,
// `ports` an ordered [{name, slug, lat, lon}]. Two sources currently load it —
// the Widgety archive and the RapidAPI Cruise API — and they do NOT always
// agree, so see mergeItineraries() for how that is resolved.
import { getSupabase } from "./persistence";
import { logger } from "./logger";

export interface PlannedRow {
  ship_name: string;
  source: string;
  start_date: string;
  end_date: string | null;
  ports: { name?: string; slug?: string | null }[] | null;
}

/** Ordered port slugs of one row, blanks and unresolved names dropped. */
export function slugsOf(row: PlannedRow): string[] {
  return (row.ports ?? [])
    .map((p) => (typeof p?.slug === "string" ? p.slug.trim() : ""))
    .filter(Boolean);
}

/** Does this sailing cover `date` (YYYY-MM-DD)? */
export function covers(row: PlannedRow, date: string): boolean {
  if (row.start_date > date) return false;
  return !row.end_date || row.end_date >= date;
}

/**
 * Reconcile the sailings covering today into ONE set of expected ports.
 *
 * The detector only ever asks "is this declared port on the plan", never "is
 * it in the right position", so a UNION across sources is exactly right and
 * deliberately forgiving: when Widgety says Miami → Great Stirrup → Nassau →
 * Miami and the Cruise API says Miami → Nassau → Great Stirrup → Miami for the
 * SAME 18 Sep sailing, both orders contain the same ports, and a ship calling
 * at either is sailing her timetable. Taking one source as truth would turn
 * that disagreement into a headline about the ship.
 *
 * `order` is the longest single-source ordering, kept only so a swap can be
 * RECORDED (never alerted on) — see classifyAgainstItinerary.
 */
export function mergeItineraries(rows: readonly PlannedRow[]): { ports: string[]; order: string[]; sources: string[] } {
  const ports = new Set<string>();
  let order: string[] = [];
  const sources = new Set<string>();
  for (const r of rows) {
    const s = slugsOf(r);
    if (!s.length) continue;
    sources.add(r.source);
    for (const slug of s) ports.add(slug);
    if (s.length > order.length) order = s;
  }
  return { ports: [...ports], order, sources: [...sources] };
}

export interface ShipItinerary { ports: string[]; order: string[]; sources: string[] }

/**
 * Itineraries for a set of ships on `date`, keyed by lower-cased ship name.
 * A ship with no row is simply absent — the caller must treat that as "unknown",
 * never as "no ports expected".
 */
export async function itinerariesFor(
  shipNames: readonly string[], date = new Date().toISOString().slice(0, 10),
): Promise<Map<string, ShipItinerary>> {
  const out = new Map<string, ShipItinerary>();
  const names = [...new Set(shipNames.map((n) => n.trim()).filter(Boolean))];
  if (!names.length) return out;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("planned_sailings")
    .select("ship_name, source, start_date, end_date, ports")
    .in("ship_name", names)
    .lte("start_date", date);
  if (error) {
    // A read failure must not look like "no itinerary anywhere", which would
    // silently re-arm the guesswork. Log loudly and return nothing; the caller
    // stays quiet because every ship is then unknown.
    logger.warn({ err: error, ships: names.length }, "planned-itinerary: read failed");
    return out;
  }

  const byShip = new Map<string, PlannedRow[]>();
  for (const row of (data ?? []) as PlannedRow[]) {
    if (!covers(row, date)) continue;
    const key = row.ship_name.trim().toLowerCase();
    const list = byShip.get(key) ?? [];
    list.push(row);
    byShip.set(key, list);
  }
  for (const [key, rows] of byShip) {
    const merged = mergeItineraries(rows);
    if (merged.ports.length) out.set(key, merged);
  }
  return out;
}
