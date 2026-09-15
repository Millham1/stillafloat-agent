// dead-reckoning.ts — what the tracker shows BETWEEN AIS fixes.
//
// The free terrestrial AIS feed only hears a ship within a few dozen miles of a
// shore receiver. Mark, 2026-09-10: "even between Miami and Nassau the data
// drops when not very close to the coast" — 87 of 315 tracked ships had a live
// fix that morning, and a ship on a Bahamas run sat frozen off Miami for two
// days. Satellite AIS is the real fix and is a paid feed; this module is the
// honest free one: project the last fix forward and SAY it is an estimate.
//
// Pure functions, no I/O, so the maths is unit-tested without the tracker.

export interface Fix {
  lat: number;
  lon: number;
  courseDeg: number | null;
  speedKn: number | null;
  at: string; // ISO time of the last real position report
}

export interface Port { slug: string; name: string; lat: number; lon: number }

export type EstimateBasis = "route" | "course" | "hold" | "arrived" | "stale";

export interface Estimate {
  lat: number;
  lon: number;
  basis: EstimateBasis;
  confidence: "high" | "medium" | "low";
  hoursSinceFix: number;
}

export interface NearbyShip {
  name: string;
  cruiseLine: string;
  lat: number;
  lon: number;
  courseDeg: number | null;
  speedKn: number | null;
  minAgo: number;
  distanceNm: number;
}

/** A fix younger than this is shown as-is; older, the marker becomes an estimate. */
export const ESTIMATE_AFTER_MIN = 20;
/** Without a declared destination, project along the last course this long, then hold. */
export const MAX_COURSE_HOURS = 8;
/** Below this speed at the last report the ship is treated as stopped (moored/anchored). */
export const UNDERWAY_KN = 2;
export const NEARBY_RADIUS_NM = 10;
/** A declared ETA older than this is a previous leg's — the destination is stale. */
export const STALE_DESTINATION_H = 48;
/** A fix older than this is history, not a position: hold it, draw nothing ahead. */
export const STALE_FIX_H = 48;
export const NEARBY_MAX_AGE_MIN = 60;

const R_NM = 3440.065; // earth radius in nautical miles
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Point reached by travelling `distNm` from (lat, lon) on a constant initial bearing. */
export function destinationPoint(lat: number, lon: number, bearing: number, distNm: number): { lat: number; lon: number } {
  const δ = distNm / R_NM;
  const θ = rad(bearing);
  const φ1 = rad(lat);
  const λ1 = rad(lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: deg(φ2), lon: ((deg(λ2) + 540) % 360) - 180 };
}

/** Points along the great circle from a to b, inclusive of both ends. */
export function greatCirclePoints(a: { lat: number; lon: number }, b: { lat: number; lon: number }, n = 24): [number, number][] {
  const φ1 = rad(a.lat), λ1 = rad(a.lon), φ2 = rad(b.lat), λ2 = rad(b.lon);
  const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
  if (d < 1e-9) return [[a.lat, a.lon], [b.lat, b.lon]];
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    out.push([deg(Math.atan2(z, Math.sqrt(x * x + y * y))), deg(Math.atan2(y, x))]);
  }
  // exact endpoints: the line must start and end on the port/fix, not a float-rounded neighbour
  out[0] = [a.lat, a.lon];
  out[out.length - 1] = [b.lat, b.lon];
  return out;
}

export type Path = [number, number][]; // [lat, lon] points

/** Total length of a polyline in nautical miles. */
export function pathLengthNm(path: Path): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += distanceNm(path[i - 1]![0], path[i - 1]![1], path[i]![0], path[i]![1]);
  return d;
}

/** The point `distNm` along a polyline (clamped to its ends). */
export function pointAlongPath(path: Path, distNm: number): { lat: number; lon: number } {
  if (!path.length) throw new Error("empty path");
  if (distNm <= 0) return { lat: path[0]![0], lon: path[0]![1] };
  let left = distNm;
  for (let i = 1; i < path.length; i++) {
    const [la1, lo1] = path[i - 1]!; const [la2, lo2] = path[i]!;
    const seg = distanceNm(la1, lo1, la2, lo2);
    if (left <= seg && seg > 0) {
      const f = left / seg;
      return { lat: la1 + (la2 - la1) * f, lon: lo1 + (lo2 - lo1) * f };
    }
    left -= seg;
  }
  return { lat: path[path.length - 1]![0], lon: path[path.length - 1]![1] };
}

/** Real breadcrumb: [lat, lon, isoTime]. */
export type TrackPoint = [number, number, string];
export const TRACK_MIN_SPACING_NM = 0.5;
export const TRACK_MAX_POINTS = 400;
export const TRACK_MAX_AGE_DAYS = 10;

/**
 * Append a real fix to a ship's track: skipped if she has not moved half a
 * mile since the last point; the track is capped in points and in age so a
 * ship docked for a week does not carry a ten-day tail. Pure — returns a new array.
 */
export function appendTrack(track: TrackPoint[], lat: number, lon: number, at: string, now = new Date()): TrackPoint[] {
  const cutoff = now.getTime() - TRACK_MAX_AGE_DAYS * 86_400_000;
  let out = track.filter((p) => Date.parse(p[2]) >= cutoff);
  const last = out[out.length - 1];
  if (!last || distanceNm(last[0], last[1], lat, lon) >= TRACK_MIN_SPACING_NM) out = [...out, [lat, lon, at]];
  if (out.length > TRACK_MAX_POINTS) out = out.slice(out.length - TRACK_MAX_POINTS);
  return out;
}

/** A sea path from the lane network can run long offshore; trust at most this much over the great circle. */
export const PATH_TRUST_OVER_GC = 1.25;

/**
 * Where the ship probably is now. null = the fix is fresh enough to show as-is.
 *
 *  - stopped at the last report → hold her there (a moored ship does not drift
 *    to Nassau because we stopped hearing her);
 *  - destination known → slide her along the great circle to it at her last
 *    speed, and park her at the port once she should have arrived (or her
 *    declared ETA is past);
 *  - no destination (or one whose ETA passed days ago) → dead-reckon along
 *    the last course, at most MAX_COURSE_HOURS, then "stale": held at the
 *    fix, nothing drawn ahead. Beyond that a guess is a fabrication.
 *  - any fix older than STALE_FIX_H → "stale" whatever else we know: a ship
 *    last heard 4 days ago moored at Freeport has sailed twice since.
 */
export function estimatePosition(fix: Fix, now: Date, dest: Port | null, etaUtc: string | null, pathToDest: Path | null = null): Estimate | null {
  const fixAt = Date.parse(fix.at);
  if (!isFinite(fixAt)) return null;
  const hours = Math.max(0, (now.getTime() - fixAt) / 3_600_000);
  if (hours * 60 < ESTIMATE_AFTER_MIN) return null;
  const hoursSinceFix = Math.round(hours * 10) / 10;
  const speed = fix.speedKn ?? 0;
  const stale: Estimate = { lat: fix.lat, lon: fix.lon, basis: "stale", confidence: "low", hoursSinceFix };

  if (hours > STALE_FIX_H) return stale;

  if (speed < UNDERWAY_KN) {
    return { lat: fix.lat, lon: fix.lon, basis: "hold", confidence: hours < 8 ? "medium" : "low", hoursSinceFix };
  }

  const eta = etaUtc ? Date.parse(etaUtc) : NaN;
  const etaAgeH = isFinite(eta) ? (now.getTime() - eta) / 3_600_000 : NaN;
  // A declared ETA that passed days ago means the crew never retyped the
  // destination after that call — the "next port" is last leg's port. Do not
  // park her there or draw a line to it: treat the destination as unknown.
  const destUsable = dest && !(isFinite(etaAgeH) && etaAgeH > STALE_DESTINATION_H) ? dest : null;

  if (destUsable) {
    const dest = destUsable;
    const total = distanceNm(fix.lat, fix.lon, dest.lat, dest.lon);
    const travelled = speed * hours;
    const etaPassed = isFinite(etaAgeH) && etaAgeH > 0.5;
    if (travelled >= total || etaPassed) {
      return { lat: dest.lat, lon: dest.lon, basis: "arrived", confidence: "medium", hoursSinceFix };
    }
    // Slide her along the WATER path when we have one (a great circle crosses
    // land — Galveston to Cozumel runs straight over the Yucatán). The lane
    // network is coarse offshore, so the length we trust is capped relative to
    // the great circle; beyond that she is placed proportionally along the path.
    if (pathToDest && pathToDest.length >= 2) {
      const pathLen = pathLengthNm(pathToDest);
      const trusted = Math.min(pathLen, total * PATH_TRUST_OVER_GC);
      const along = Math.min(pathLen, (travelled / trusted) * pathLen);
      const p = pointAlongPath(pathToDest, along);
      return { ...p, basis: "route", confidence: hours < 3 ? "high" : hours < 12 ? "medium" : "low", hoursSinceFix };
    }
    const pts = greatCirclePoints(fix, dest, 200);
    const [lat, lon] = pts[Math.round((travelled / total) * 200)]!;
    return { lat, lon, basis: "route", confidence: hours < 3 ? "high" : hours < 12 ? "medium" : "low", hoursSinceFix };
  }

  if (fix.courseDeg === null) return null;
  // No destination and too long since the fix: a point eight hours down her
  // last course is a fabrication (a 3-day-old Norwegian Getaway fix off
  // Fort Lauderdale, 2026-09-10). Hold the last real fix and say so.
  if (hours > MAX_COURSE_HOURS) return stale;
  const p = destinationPoint(fix.lat, fix.lon, fix.courseDeg, speed * hours);
  return { ...p, basis: "course", confidence: hours <= 2 ? "medium" : "low", hoursSinceFix };
}

/**
 * Two breadcrumb fixes farther apart than this were not heard in between. Fixes are kept every
 * half mile while a shore receiver hears her; across 45 ships on 2026-09-15 half the steps were
 * under 0.7 nm and 99% under 25 nm. Beyond that she was out of range, sometimes for 600+ miles.
 */
export const TRACK_GAP_NM = 25;
/** A water path is believed only if it is at most this many times the straight distance, plus GAP_PATH_SLACK_NM. */
export const GAP_PATH_MAX_RATIO = 2;
export const GAP_PATH_SLACK_NM = 60;

/** Indexes i where track[i] → track[i+1] jumps more than TRACK_GAP_NM: stretches she was not heard. */
export function trackGaps(track: ReadonlyArray<readonly [number, number, ...unknown[]]>): number[] {
  const gaps: number[] = [];
  for (let i = 0; i + 1 < track.length; i++) {
    const [la1, lo1] = track[i]!;
    const [la2, lo2] = track[i + 1]!;
    if (distanceNm(la1, lo1, la2, lo2) > TRACK_GAP_NM) gaps.push(i);
  }
  return gaps;
}

/**
 * Whether a water path from the lane network is fit to draw. A "path" of just its two ends is a
 * straight line: fine for a short hop into port, not across open miles (Carnival Breeze,
 * 2026-09-15: the path from her fix off Cozumel to Progreso came back as the two points, straight
 * over the Yucatán). A wild detour is no better (Celebrity Ascent: a 47 nm Aegean gap came back as
 * 335 nm of shipping lanes). Judged on the points actually drawn.
 */
export function believablePath(path: Path | null | undefined): boolean {
  if (!path || path.length < 2) return false;
  const [la1, lo1] = path[0]!;
  const [la2, lo2] = path[path.length - 1]!;
  const straight = distanceNm(la1, lo1, la2, lo2);
  if (path.length < 3) return straight <= TRACK_GAP_NM;
  return pathLengthNm(path) <= GAP_PATH_MAX_RATIO * straight + GAP_PATH_SLACK_NM;
}

/** The part of `path` from its start up to `point`, a point that lies on the path. */
export function pathUntil(path: Path, point: { lat: number; lon: number }): Path {
  let best = 1;
  let bestD = Infinity;
  for (let i = 1; i < path.length; i++) {
    const [la1, lo1] = path[i - 1]!;
    const [la2, lo2] = path[i]!;
    const dx = la2 - la1, dy = lo2 - lo1;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((point.lat - la1) * dx + (point.lon - lo1) * dy) / len2)) : 0;
    const d = (point.lat - (la1 + t * dx)) ** 2 + (point.lon - (lo1 + t * dy)) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return [...path.slice(0, best), [point.lat, point.lon]];
}

export interface RouteLine {
  /** Where she was heard: runs of real fixes, drawn solid. */
  travelled: Path[];
  /** Where she was not heard, along water: across coverage gaps, from the departed port when
   *  there is no track, and from her last fix to the estimate. Drawn dotted. */
  between: Path[];
  /** estimate (or fix) → destination port (what she has left to do), drawn dashed. */
  ahead: Path;
}

export interface RouteInputs {
  /** Real breadcrumb of fixes this sailing (newest last). */
  track?: TrackPoint[];
  /** Water path across each gap in trackGaps(track), in order; null where none is believable. */
  gapPaths?: (Path | null)[];
  /** Water path departed port → fix, when there is no usable track. */
  behindPath?: Path | null;
  /** The water path fix → destination that the estimate slid along. */
  toDestPath?: Path | null;
  /** Water path (estimate or fix) → destination. */
  aheadPath?: Path | null;
}

/**
 * The thin green line: where she came from, where she is, where she is going.
 * Behind her: her REAL track, solid where she was heard. Mark, 2026-09-15, looking at Carnival
 * Panorama at Cabo with a line cut across Baja: "the tracks are still running through land".
 * The track joined every fix to the next, so the 629 miles she sailed out of range became one
 * straight line over the peninsula. Where she was not heard, the line follows a water path and
 * is dotted; with no believable water path it breaks. Ahead: the water path to the destination.
 * Every water path must pass believablePath. No path = no line; a straight line across land is
 * worse than nothing.
 */
export function routeLine(fix: Fix, estimate: Estimate | null, departed: Port | null, dest: Port | null, inputs: RouteInputs = {}): RouteLine {
  const here = estimate && estimate.basis !== "hold" && estimate.basis !== "stale" ? { lat: estimate.lat, lon: estimate.lon } : { lat: fix.lat, lon: fix.lon };
  const travelled: Path[] = [];
  const between: Path[] = [];
  const track = inputs.track ?? [];
  let run: Path = [];

  if (track.length >= 2) {
    const gaps = trackGaps(track);
    run = [[track[0]![0], track[0]![1]]];
    let g = 0;
    for (let i = 0; i + 1 < track.length; i++) {
      const next: [number, number] = [track[i + 1]![0], track[i + 1]![1]];
      if (gaps[g] === i) {
        const path = inputs.gapPaths?.[g] ?? null;
        g++;
        if (run.length >= 2) travelled.push(run);
        if (believablePath(path)) between.push(path!);
        run = [next];
      } else {
        run.push(next);
      }
    }
  } else if (departed && believablePath(inputs.behindPath)
    && distanceNm(departed.lat, departed.lon, fix.lat, fix.lon) <= 1500) {
    // a port a thousand miles back is last week's sailing, not this leg
    between.push(inputs.behindPath!);
  }

  // Her last fix closes the heard line (a jump to it is a gap like any other, never a straight line).
  const last = run[run.length - 1];
  if (!last) {
    run = [[fix.lat, fix.lon]];
  } else if (last[0] !== fix.lat || last[1] !== fix.lon) {
    if (distanceNm(last[0], last[1], fix.lat, fix.lon) > TRACK_GAP_NM) {
      if (run.length >= 2) travelled.push(run);
      run = [[fix.lat, fix.lon]];
    } else {
      run.push([fix.lat, fix.lon]);
    }
  }
  if (run.length >= 2) travelled.push(run);

  // Last fix → estimate: along the water path she was placed on; a course projection is
  // straight by definition; an estimate without a water path gets no line.
  if (estimate && (here.lat !== fix.lat || here.lon !== fix.lon)) {
    const toDest = believablePath(inputs.toDestPath) ? inputs.toDestPath! : null;
    if (estimate.basis === "arrived" && toDest) between.push(toDest);
    else if (estimate.basis === "route" && toDest) between.push(pathUntil(toDest, here));
    else if (estimate.basis === "course") between.push([[fix.lat, fix.lon], [here.lat, here.lon]]);
  }

  const ahead: Path = dest && estimate?.basis !== "arrived" && estimate?.basis !== "stale" && believablePath(inputs.aheadPath)
    ? inputs.aheadPath!
    : [];
  return { travelled, between, ahead };
}

/** Other tracked ships with a recent fix inside `radiusNm` of a point, nearest first. */
export function nearbyShips(
  all: Array<{ name: string; cruiseLine: string; lat: number | null; lon: number | null; cogDeg: number | null; sogKn: number | null; lastPosAt: string | null }>,
  center: { lat: number; lon: number },
  excludeName: string,
  now: Date,
  radiusNm = NEARBY_RADIUS_NM,
  maxAgeMin = NEARBY_MAX_AGE_MIN,
): NearbyShip[] {
  const out: NearbyShip[] = [];
  for (const s of all) {
    if (s.name === excludeName || s.lat === null || s.lon === null || !s.lastPosAt) continue;
    const minAgo = Math.round((now.getTime() - Date.parse(s.lastPosAt)) / 60_000);
    if (!isFinite(minAgo) || minAgo > maxAgeMin) continue;
    const d = distanceNm(center.lat, center.lon, s.lat, s.lon);
    if (d > radiusNm) continue;
    out.push({ name: s.name, cruiseLine: s.cruiseLine, lat: s.lat, lon: s.lon, courseDeg: s.cogDeg, speedKn: s.sogKn, minAgo, distanceNm: Math.round(d * 10) / 10 });
  }
  return out.sort((a, b) => a.distanceNm - b.distanceNm);
}
