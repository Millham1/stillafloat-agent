// active-set.ts — which registry ships get a live AIS subscription.
//
// Pure ranking so it can be tested without the tracker's sockets and DB.
// Order: watched or storm-alert ships, the seeded US-coast fleet, everything
// ever requested (newest request first), then the rest of the registry by
// name — filled up to capacity. Nothing is left "registry-only" while there is
// room: aisstream's published allowance (200 MMSIs per subscription, 3
// subscriptions per account, read 2026-09-11) fits the whole registry on the
// three production keys, and a ship nobody subscribed to is a ship nobody can
// find.

/** aisstream.io: "MMSI filters: 200 per subscription" (documentation, 2026-09-11). */
export const AISSTREAM_MMSIS_PER_SUBSCRIPTION = 200;

export interface RankableShip {
  mmsi: string;
  name: string;
  seedActive: boolean;
  lastRequestedAt: string | null;
  hasWatch: boolean;
}

export function trackingRank(s: RankableShip, stormMmsis: ReadonlySet<string>): 0 | 1 | 2 | 3 {
  if (stormMmsis.has(s.mmsi) || s.hasWatch) return 0;
  if (s.seedActive) return 1;
  if (s.lastRequestedAt) return 2;
  return 3;
}

/** The ships to subscribe, best-ranked first, at most `capacity` of them. */
export function selectActiveSet<T extends RankableShip>(ships: readonly T[], stormMmsis: ReadonlySet<string>, capacity: number): T[] {
  const cap = Math.max(0, Math.floor(capacity));
  return [...ships]
    .sort((a, b) =>
      trackingRank(a, stormMmsis) - trackingRank(b, stormMmsis) ||
      (b.lastRequestedAt ?? "").localeCompare(a.lastRequestedAt ?? "") ||
      a.name.localeCompare(b.name))
    .slice(0, cap);
}
