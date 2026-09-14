// webcam-ships.ts — which tracked cruise ships are in frame at a webcam's port.
//
// Mark, 2026-09-14: every cam on the webcams page looks at a cruise terminal,
// and each one says which of our ships are there right now. The tracker already
// holds every ship's last fix; a ship counts as "in port" for a cam when her
// last fix is close to that cam's port and recent enough to trust.
//
// Pure: takes positions and a port, returns names. The route does the I/O.

export interface PortLike { slug: string; lat: number; lon: number }
export interface PositionLike {
  name: string;
  cruiseLine?: string | null;
  lat: number | null;
  lon: number | null;
  sogKn?: number | null;
  lastPosAt: string | null;
}
export interface ShipInPort { name: string; cruiseLine: string | null; docked: boolean; lastPosAt: string }

/** Terminals at a big port spread over several kilometres (PortMiami's run ~5 km). */
export const IN_PORT_RADIUS_KM = 8;
/** A fix older than this may be a ship that has since sailed. */
export const IN_PORT_MAX_AGE_H = 12;
/** Under this speed she is alongside or anchored, not passing through. */
const DOCKED_MAX_KN = 1.0;

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function shipsInPort(
  positions: readonly PositionLike[],
  port: PortLike,
  now: Date = new Date(),
  opts: { radiusKm?: number; maxAgeH?: number } = {},
): ShipInPort[] {
  const radius = opts.radiusKm ?? IN_PORT_RADIUS_KM;
  const maxAgeMs = (opts.maxAgeH ?? IN_PORT_MAX_AGE_H) * 3_600_000;
  const out: ShipInPort[] = [];
  for (const p of positions) {
    if (p.lat === null || p.lon === null || !p.lastPosAt) continue;
    const t = Date.parse(p.lastPosAt);
    if (!Number.isFinite(t) || now.getTime() - t > maxAgeMs || t > now.getTime() + 600_000) continue;
    if (distanceKm(p.lat, p.lon, port.lat, port.lon) > radius) continue;
    out.push({ name: p.name, cruiseLine: p.cruiseLine ?? null, docked: (p.sogKn ?? 0) <= DOCKED_MAX_KN, lastPosAt: p.lastPosAt });
  }
  // Docked ships first (they are the ones in frame), then by name.
  return out.sort((a, b) => Number(b.docked) - Number(a.docked) || a.name.localeCompare(b.name));
}
