// storm-sailings.ts — itinerary-level (date + region aware) impacted-ship matching.
//
// A ship counts as impacted only if a sailing's regions overlap the storm's
// affected grounds AND its dates overlap the storm's forecast window. This
// replaces the coarse region-tag match (a Miami sailing isn't affected by an
// ABC-islands storm). Populated manually today; a real itinerary feed is the
// tracked follow-up.

import { getSupabase } from "./persistence";

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
