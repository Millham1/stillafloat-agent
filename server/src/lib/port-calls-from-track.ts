// port-calls-from-track.ts — read a ship's recent port calls off a position track.
//
// The live tracker logs a call when it sees a ship slow inside a port radius
// and closes it when she leaves. A provider's history track (ShipFinder,
// 24 h of points) lets us do the same replay for a ship we have only just
// started following, so her card has "departed Miami" on the first request
// instead of a week later. Pure; the thresholds mirror ship-tracker.ts.
import { nearestPort } from "./ports";
import type { TrackSample } from "./shipfinder-core";

export interface DerivedPortCall { slug: string; arrivedAt: string; departedAt: string | null }

export const PORT_RADIUS_KM = 4;
export const IN_PORT_MAX_KN = 0.7;
export const MIN_CALL_MINUTES = 20; // shorter than this is a drift past the pier, not a call

export function portCallsFromTrack(samples: readonly TrackSample[], now = new Date()): DerivedPortCall[] {
  const calls: DerivedPortCall[] = [];
  let open: DerivedPortCall | null = null;
  for (const s of samples) {
    const near = nearestPort(s.lat, s.lon, PORT_RADIUS_KM);
    const slow = (s.speedKn ?? 0) <= IN_PORT_MAX_KN;
    const inPort = near && slow ? near.slug : null;
    if (open && inPort === open.slug) continue;                // still alongside
    if (open) { open.departedAt = s.at; open = null; }          // left, or moved to another port
    if (inPort) { open = { slug: inPort, arrivedAt: s.at, departedAt: null }; calls.push(open); }
  }
  // Drop drive-bys; an open call at the end of the track means she is still there.
  return calls.filter((c) => {
    const end = c.departedAt ? Date.parse(c.departedAt) : now.getTime();
    return (end - Date.parse(c.arrivedAt)) / 60_000 >= MIN_CALL_MINUTES;
  });
}

/** Merge derived calls into an existing log without duplicating a call the tracker already saw. */
export function mergePortCalls(existing: readonly DerivedPortCall[], derived: readonly DerivedPortCall[], maxLen = 60): DerivedPortCall[] {
  const out = [...existing];
  for (const d of derived) {
    const dup = out.some((e) => e.slug === d.slug && Math.abs(Date.parse(e.arrivedAt) - Date.parse(d.arrivedAt)) < 6 * 3_600_000);
    if (!dup) out.push({ ...d });
  }
  out.sort((a, b) => Date.parse(a.arrivedAt) - Date.parse(b.arrivedAt));
  return out.length > maxLen ? out.slice(out.length - maxLen) : out;
}
