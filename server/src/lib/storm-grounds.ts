// storm-grounds.ts — cruising-ground geography + ship matching for storm alerts.
//
// Maps an NHC system (by position and/or basin) to the cruising "grounds" it
// could affect, and resolves which curated ships sail those grounds. The region
// keys here match the `ships.regions` column and `storm_alerts.affected_grounds`.

import { getSupabase } from "./persistence";

export type RegionKey =
  | "e_caribbean" | "w_caribbean" | "bahamas" | "gulf" | "bermuda"
  | "us_east_coast" | "mexican_riviera" | "hawaii";

export const REGION_LABELS: Record<RegionKey, string> = {
  e_caribbean: "Eastern Caribbean",
  w_caribbean: "Western Caribbean",
  bahamas: "Bahamas",
  gulf: "Gulf of Mexico",
  bermuda: "Bermuda",
  us_east_coast: "U.S. East Coast",
  mexican_riviera: "Mexican Riviera",
  hawaii: "Hawaii",
};

// Rough bounding boxes [minLat, maxLat, minLon, maxLon] (lon negative = west).
// Deliberately generous — a system anywhere near these waters is worth surfacing.
// Alerts are approval-gated, so over-inclusion is safe (Mark filters each one).
const REGION_BOXES: Record<RegionKey, [number, number, number, number]> = {
  e_caribbean:     [10, 20, -68, -58],
  w_caribbean:     [12, 22, -89, -78],
  bahamas:         [20, 27, -80, -71],
  gulf:            [18, 31, -98, -80],
  bermuda:         [30, 34, -66, -63],
  us_east_coast:   [25, 41, -82, -69],
  mexican_riviera: [15, 27, -115, -104],
  // Central Pacific storms reach the islands from the south and south-east;
  // the old [17, 23] box was the archipelago itself, so Nolo at 15.5N — 240 mi
  // south of South Point with the Big Island under a watch — fell outside it
  // and through to the basin fallback (2026-09-25).
  hawaii:          [12, 26, -166, -150],
};

// Basin → candidate regions, used when we only know the basin (e.g. a Tropical
// Weather Outlook disturbance with no precise coordinates yet).
const BASIN_REGIONS: Record<string, RegionKey[]> = {
  atlantic:        ["e_caribbean", "w_caribbean", "bahamas", "gulf", "bermuda", "us_east_coast"],
  eastern_pacific: ["mexican_riviera"],
  central_pacific: ["hawaii"],
};

/**
 * How far outside a region box a POSITIONED system still counts, in degrees
 * (~600 nautical miles, two to three days of travel at storm speeds). This is
 * the "know before you go" reach: Hurricane Odalys 8° west of the Mexican
 * Riviera box is that region's business; Tropical Storm Gonzalo 35° east of the
 * Caribbean, off Cabo Verde, is nobody's — yet on 2026-09-25 it inherited every
 * Atlantic region through the basin fallback and pinned 59 ships.
 */
export const NAMED_STORM_MARGIN_DEG = 10;

/** Regions whose bounding box, widened by `marginDeg` on every side, contains the point. */
export function groundsForPoint(lat: number, lon: number, marginDeg = 0): RegionKey[] {
  const hits: RegionKey[] = [];
  for (const key of Object.keys(REGION_BOXES) as RegionKey[]) {
    const [minLat, maxLat, minLon, maxLon] = REGION_BOXES[key];
    if (lat >= minLat - marginDeg && lat <= maxLat + marginDeg &&
        lon >= minLon - marginDeg && lon <= maxLon + marginDeg) hits.push(key);
  }
  return hits;
}

/** Fallback grounds when only the basin is known (no coordinates). */
export function groundsForBasin(basin: string): RegionKey[] {
  return BASIN_REGIONS[basin] ?? [];
}

export function labelGrounds(grounds: string[]): string {
  return grounds
    .map((g) => REGION_LABELS[g as RegionKey] ?? g)
    .join(", ");
}

export interface Ship { name: string; cruise_line: string; regions: string[]; }

/** Curated ships that sail any of the given grounds. Empty grounds → no ships. */
export async function shipsForGrounds(grounds: string[]): Promise<Ship[]> {
  if (!grounds.length) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("ships")
    .select("name, cruise_line, regions")
    .eq("active", true)
    .overlaps("regions", grounds);
  if (error) throw new Error(`shipsForGrounds: ${error.message}`);
  return ((data ?? []) as unknown as Ship[]).sort(
    (a, b) => a.cruise_line.localeCompare(b.cruise_line) || a.name.localeCompare(b.name),
  );
}
