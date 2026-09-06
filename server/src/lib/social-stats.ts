// Follower / reach snapshots posted by Make's "Still Afloat Social Stats"
// scenario (every 12h) to POST /api/social/ingest and kept in platform_state
// `social-stats`. Pure summariser so the 30-day Instagram test (Mark 2026-09-06)
// can be read off one endpoint: first vs latest followers per platform.

export interface StatsSnapshot {
  at: string;
  [k: string]: unknown;
}
export interface PlatformSummary {
  first: number | null;
  latest: number | null;
  delta: number | null;
}
export interface StatsSummary {
  snapshots: number;
  firstAt: string | null;
  latestAt: string | null;
  followers: Record<string, PlatformSummary>;
}

export const STATS_KEY = "social-stats";
export const STATS_CAP = 500;

function followersOf(snap: StatsSnapshot, platform: string): number | null {
  const p = snap[platform];
  if (!p || typeof p !== "object") return null;
  const f = (p as { followers?: unknown }).followers;
  return typeof f === "number" && Number.isFinite(f) ? f : null;
}

export function summarizeStats(items: StatsSnapshot[], platforms: string[] = ["facebook", "instagram"]): StatsSummary {
  const sorted = [...items].sort((a, b) => a.at.localeCompare(b.at));
  const followers: Record<string, PlatformSummary> = {};
  for (const pl of platforms) {
    const vals = sorted.map((s) => followersOf(s, pl)).filter((v): v is number => v !== null);
    const first = vals[0] ?? null;
    const latest = vals.length ? vals[vals.length - 1]! : null;
    followers[pl] = { first, latest, delta: first !== null && latest !== null ? latest - first : null };
  }
  return {
    snapshots: sorted.length,
    firstAt: sorted[0]?.at ?? null,
    latestAt: sorted.length ? sorted[sorted.length - 1]!.at : null,
    followers,
  };
}

export function appendSnapshot(items: StatsSnapshot[], body: Record<string, unknown>, at: string): StatsSnapshot[] {
  const next = [...items, { ...body, at }];
  return next.length > STATS_CAP ? next.slice(-STATS_CAP) : next;
}
