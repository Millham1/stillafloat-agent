// dead-reckoning.test.ts — the estimate is honest arithmetic, not a guess.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  distanceNm, bearingDeg, destinationPoint, greatCirclePoints, pathLengthNm, pointAlongPath, appendTrack,
  estimatePosition, routeLine, nearbyShips, trackGaps, believablePath, pathUntil, ESTIMATE_AFTER_MIN, MAX_COURSE_HOURS,
  TRACK_MAX_POINTS, STALE_FIX_H, TRACK_GAP_NM, type Path,
} from "./dead-reckoning";

const MIAMI = { slug: "miami", name: "Miami, Florida", lat: 25.7617, lon: -80.1918 };
const NASSAU = { slug: "nassau", name: "Nassau, Bahamas", lat: 25.0443, lon: -77.3504 };
const T0 = "2026-09-10T12:00:00.000Z";
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000);

describe("geodesy", () => {
  it("Miami to Nassau is about 158 nautical miles", () => {
    const d = distanceNm(MIAMI.lat, MIAMI.lon, NASSAU.lat, NASSAU.lon);
    assert.ok(d > 150 && d < 165, `got ${d}`);
  });
  it("destinationPoint travels the asked distance on the asked bearing", () => {
    const b = bearingDeg(MIAMI.lat, MIAMI.lon, NASSAU.lat, NASSAU.lon);
    const p = destinationPoint(MIAMI.lat, MIAMI.lon, b, 40);
    assert.ok(Math.abs(distanceNm(MIAMI.lat, MIAMI.lon, p.lat, p.lon) - 40) < 0.05);
    assert.ok(distanceNm(p.lat, p.lon, NASSAU.lat, NASSAU.lon) < distanceNm(MIAMI.lat, MIAMI.lon, NASSAU.lat, NASSAU.lon) - 39);
  });
  it("greatCirclePoints starts and ends exactly at the endpoints", () => {
    const pts = greatCirclePoints(MIAMI, NASSAU, 10);
    assert.equal(pts.length, 11);
    assert.ok(Math.abs(pts[0]![0] - MIAMI.lat) < 1e-9 && Math.abs(pts[10]![1] - NASSAU.lon) < 1e-9);
  });
});

describe("estimatePosition", () => {
  const underway = { lat: MIAMI.lat, lon: MIAMI.lon, courseDeg: 105, speedKn: 16, at: T0 };
  it("a fresh fix is shown as-is (no estimate)", () => {
    assert.equal(estimatePosition(underway, at((ESTIMATE_AFTER_MIN - 1) / 60), NASSAU, null), null);
  });
  it("with a destination she slides along the route at her last speed", () => {
    const e = estimatePosition(underway, at(2), NASSAU, null)!;
    assert.equal(e.basis, "route");
    assert.equal(e.confidence, "high");
    assert.equal(e.hoursSinceFix, 2);
    const done = distanceNm(MIAMI.lat, MIAMI.lon, e.lat, e.lon);
    assert.ok(Math.abs(done - 32) < 1.5, `travelled ${done} nm, expected ~32`); // 16 kn x 2 h
    assert.ok(distanceNm(e.lat, e.lon, NASSAU.lat, NASSAU.lon) < 130);
  });
  it("once she should have arrived she is parked at the port, not sailed past it", () => {
    const e = estimatePosition(underway, at(20), NASSAU, null)!;
    assert.equal(e.basis, "arrived");
    assert.deepEqual([e.lat, e.lon], [NASSAU.lat, NASSAU.lon]);
  });
  it("a passed ETA also parks her at the port", () => {
    const e = estimatePosition(underway, at(1), NASSAU, "2026-09-10T12:20:00.000Z")!;
    assert.equal(e.basis, "arrived");
  });
  it("an ETA that passed days ago means the destination is last leg's — it is ignored, never parked at", () => {
    const e6 = estimatePosition(underway, at(6), NASSAU, "2026-09-07T12:00:00.000Z")!;
    assert.equal(e6.basis, "course", "underway with an unusable destination = dead-reckon on her course");
    assert.ok(Math.abs(distanceNm(MIAMI.lat, MIAMI.lon, e6.lat, e6.lon) - 96) < 0.5);
    const e10 = estimatePosition(underway, at(10), NASSAU, "2026-09-07T12:00:00.000Z")!;
    assert.equal(e10.basis, "stale");
    assert.deepEqual([e10.lat, e10.lon], [MIAMI.lat, MIAMI.lon]);
  });
  it("a fix older than STALE_FIX_H is stale no matter what else we know (Carnival Horizon, 97 h, 'stopped' with a destination)", () => {
    const moored = estimatePosition({ ...underway, speedKn: 0.2 }, at(STALE_FIX_H + 1), NASSAU, null)!;
    assert.equal(moored.basis, "stale");
    assert.deepEqual([moored.lat, moored.lon], [MIAMI.lat, MIAMI.lon]);
    const sailing = estimatePosition(underway, at(STALE_FIX_H + 1), NASSAU, "2026-09-20T12:00:00.000Z")!;
    assert.equal(sailing.basis, "stale", "even a future ETA cannot rescue a two-day-old fix");
    const justUnder = estimatePosition({ ...underway, speedKn: 0.2 }, at(STALE_FIX_H - 1), NASSAU, null)!;
    assert.equal(justUnder.basis, "hold");
  });
  it("a stopped ship is held where she was, not drifted along a course", () => {
    const e = estimatePosition({ ...underway, speedKn: 0.3 }, at(5), NASSAU, null)!;
    assert.equal(e.basis, "hold");
    assert.deepEqual([e.lat, e.lon], [MIAMI.lat, MIAMI.lon]);
  });
  it("without a destination she is dead-reckoned along her course for at most MAX_COURSE_HOURS, then held at the fix as stale", () => {
    const e2 = estimatePosition(underway, at(2), null, null)!;
    assert.equal(e2.basis, "course");
    assert.ok(Math.abs(distanceNm(MIAMI.lat, MIAMI.lon, e2.lat, e2.lon) - 32) < 0.5);
    const e30 = estimatePosition(underway, at(30), null, null)!;
    assert.equal(e30.basis, "stale");
    assert.equal(e30.confidence, "low");
    assert.deepEqual([e30.lat, e30.lon], [MIAMI.lat, MIAMI.lon], "a three-day-old fix is shown where it was, not 130 nm down a guessed course");
  });
  it("no destination and no course = no estimate at all", () => {
    assert.equal(estimatePosition({ ...underway, courseDeg: null }, at(2), null, null), null);
  });
});

describe("paths and tracks", () => {
  const path: [number, number][] = [[25.76, -80.19], [25.60, -79.60], [25.30, -78.40], [25.04, -77.35]];
  it("pointAlongPath walks the polyline and clamps at both ends", () => {
    const total = pathLengthNm(path);
    assert.deepEqual(pointAlongPath(path, -5), { lat: 25.76, lon: -80.19 });
    assert.deepEqual(pointAlongPath(path, total + 50), { lat: 25.04, lon: -77.35 });
    const mid = pointAlongPath(path, total / 2);
    const d = distanceNm(path[0]![0], path[0]![1], mid.lat, mid.lon);
    assert.ok(d > 0 && d < total, "somewhere along the way");
  });
  it("appendTrack skips fixes under half a mile apart, caps points and drops fixes older than ten days", () => {
    const now = new Date("2026-09-10T12:00:00Z");
    let tr = appendTrack([], 25.0, -80.0, "2026-09-10T11:00:00Z", now);
    tr = appendTrack(tr, 25.001, -80.0, "2026-09-10T11:05:00Z", now);   // ~0.06 nm: skipped
    assert.equal(tr.length, 1);
    tr = appendTrack(tr, 25.02, -80.0, "2026-09-10T11:10:00Z", now);     // ~1.2 nm: kept
    assert.equal(tr.length, 2);
    const old = appendTrack([[24.0, -81.0, "2026-08-20T00:00:00Z"]], 25.0, -80.0, "2026-09-10T11:00:00Z", now);
    assert.equal(old.length, 1, "the three-week-old point is gone");
    let big: [number, number, string][] = [];
    for (let i = 0; i < TRACK_MAX_POINTS + 50; i++) big = appendTrack(big, 20 + i * 0.02, -80, "2026-09-10T11:00:00Z", now);
    assert.equal(big.length, TRACK_MAX_POINTS);
  });
});

describe("routeLine", () => {
  const fix = { lat: 25.6, lon: -79.6, courseDeg: 105, speedKn: 16, at: T0 };
  const behind: [number, number][] = [[MIAMI.lat, MIAMI.lon], [25.70, -80.05], [fix.lat, fix.lon]];
  const longestStraight = (runs: Path[]) => Math.max(0, ...runs.flatMap((r) => r.slice(1).map((p, i) => distanceNm(r[i]![0], r[i]![1], p[0], p[1]))));

  it("with no track, the water path from the departed port is dotted and the water path ahead dashed", () => {
    const est = estimatePosition(fix, at(2), NASSAU, null)!;
    const ahead: [number, number][] = [[est.lat, est.lon], [25.3, -78.4], [NASSAU.lat, NASSAU.lon]];
    const r = routeLine(fix, est, MIAMI, NASSAU, { behindPath: behind, aheadPath: ahead });
    assert.deepEqual(r.between, [behind], "not heard between Miami and the fix: dotted, along water");
    assert.deepEqual(r.travelled, [], "no real fixes but one: nothing solid");
    assert.deepEqual(r.ahead, ahead);
  });
  it("draws her REAL track solid, and never a computed path behind her instead", () => {
    const track: [number, number, string][] = [[25.75, -80.15, T0], [25.68, -79.9, T0], [fix.lat, fix.lon, T0]];
    const r = routeLine(fix, null, MIAMI, NASSAU, { track, behindPath: behind });
    assert.deepEqual(r.travelled, [track.map(([a, b]) => [a, b])]);
    assert.deepEqual(r.between, []);
  });
  it("draws NOTHING for a leg it has no water path for — never a straight line", () => {
    const r = routeLine(fix, null, MIAMI, NASSAU, {});
    assert.deepEqual(r, { travelled: [], between: [], ahead: [] });
  });
  it("a departed port from a previous sailing (far away) is not drawn", () => {
    const seattle = { slug: "seattle", name: "Seattle", lat: 47.6, lon: -122.3 };
    const r = routeLine(fix, null, seattle, NASSAU, { behindPath: [[seattle.lat, seattle.lon], [fix.lat, fix.lon]] });
    assert.deepEqual(r, { travelled: [], between: [], ahead: [] });
  });
  it("nothing ahead when the fix is stale, even with a destination and a water path", () => {
    const fix = { lat: MIAMI.lat, lon: MIAMI.lon, courseDeg: 105, speedKn: 0.2, at: T0 };
    const est = estimatePosition(fix, at(STALE_FIX_H + 1), NASSAU, null)!;
    assert.equal(est.basis, "stale");
    const r = routeLine(fix, est, MIAMI, NASSAU, { aheadPath: [[fix.lat, fix.lon], [NASSAU.lat, NASSAU.lon]] });
    assert.deepEqual(r, { travelled: [], between: [], ahead: [] }, "held at the last real fix, nothing drawn from it");
  });
  it("nothing ahead once she has arrived", () => {
    const est = estimatePosition(fix, at(30), NASSAU, null)!;
    assert.equal(est.basis, "arrived");
    assert.deepEqual(routeLine(fix, est, MIAMI, NASSAU, { aheadPath: [[fix.lat, fix.lon], [NASSAU.lat, NASSAU.lon]] }).ahead, []);
  });

  // Carnival Panorama, dev tracker 2026-09-15: heard off northern Baja, next heard at Cabo 629 nm later.
  const OFF_BAJA: [number, number, string] = [31.14561, -117.15308, "2026-09-14T02:00:00Z"];
  const CABO: [number, number, string] = [22.88432, -109.89706, "2026-09-15T10:00:00Z"];
  const coast: [number, number, string][] = [[31.34128, -117.23454, "2026-09-14T01:50:00Z"], OFF_BAJA];
  const atCabo: [number, number, string][] = [CABO, [22.8801, -109.9048, "2026-09-15T10:20:00Z"]];
  const cabo = { lat: 22.8801, lon: -109.9048, courseDeg: 90, speedKn: 0, at: "2026-09-15T10:20:00Z" };

  it("breaks the heard line where she went out of range and bridges the gap with its water path, dotted", () => {
    const water: Path = [[OFF_BAJA[0], OFF_BAJA[1]], [28.0, -116.0], [23.4, -111.0], [CABO[0], CABO[1]]];
    const track = [...coast, ...atCabo];
    const r = routeLine(cabo, null, null, null, { track, gapPaths: [water] });
    assert.deepEqual(r.travelled, [coast.map(([a, b]) => [a, b]), atCabo.map(([a, b]) => [a, b])]);
    assert.deepEqual(r.between, [water]);
    assert.ok(longestStraight(r.travelled) <= TRACK_GAP_NM, `a solid segment runs ${longestStraight(r.travelled)} nm`);
  });
  it("with no believable water path the line just breaks: the 629-mile straight segment is gone", () => {
    const track = [...coast, ...atCabo];
    const before = distanceNm(OFF_BAJA[0], OFF_BAJA[1], CABO[0], CABO[1]);
    assert.ok(before > 600, "the old line drew this as one straight segment");
    const r = routeLine(cabo, null, null, null, { track, gapPaths: [null] });
    assert.equal(r.travelled.length, 2);
    assert.deepEqual(r.between, []);
    assert.ok(longestStraight(r.travelled) <= TRACK_GAP_NM);
  });
  it("a jump from the end of the track to her latest fix is a gap too, never a straight line", () => {
    const r = routeLine({ ...cabo, lat: CABO[0], lon: CABO[1] }, null, null, null, { track: coast });
    assert.deepEqual(r.travelled, [coast.map(([a, b]) => [a, b])]);
    assert.deepEqual(r.between, []);
  });
  it("last fix to estimate follows the water path she was placed on; a course projection stays straight", () => {
    const water: [number, number][] = [[fix.lat, fix.lon], [25.55, -79.0], [25.2, -78.0], [NASSAU.lat, NASSAU.lon]];
    const onRoute = estimatePosition(fix, at(3), NASSAU, null, water)!;
    assert.equal(onRoute.basis, "route");
    const r = routeLine(fix, onRoute, null, NASSAU, { toDestPath: water });
    assert.deepEqual(r.between[0]![0], [fix.lat, fix.lon]);
    assert.deepEqual(r.between[0]![r.between[0]!.length - 1], [onRoute.lat, onRoute.lon]);
    assert.ok(r.between[0]!.length >= 3, "passes through the water path's points, not straight to the estimate");

    const arrived = estimatePosition(fix, at(30), NASSAU, null, water)!;
    assert.deepEqual(routeLine(fix, arrived, null, NASSAU, { toDestPath: water }).between, [water]);

    const drifting = { ...fix, courseDeg: 90 };
    const course = estimatePosition(drifting, at(2), null, null)!;
    assert.equal(course.basis, "course");
    assert.deepEqual(routeLine(drifting, course, null, null, {}).between, [[[drifting.lat, drifting.lon], [course.lat, course.lon]]]);

    const noPath = estimatePosition(fix, at(3), NASSAU, null)!;
    assert.equal(noPath.basis, "route");
    assert.deepEqual(routeLine(fix, noPath, null, NASSAU, {}).between, [], "no water path, no line to the estimate");
  });

  it("with a water path the estimate slides along it, not the great circle", () => {
    const water: [number, number][] = [[fix.lat, fix.lon], [25.55, -79.0], [25.2, -78.0], [NASSAU.lat, NASSAU.lon]];
    const e = estimatePosition(fix, at(2), NASSAU, null, water)!;
    assert.equal(e.basis, "route");
    const along = distanceNm(fix.lat, fix.lon, e.lat, e.lon);
    assert.ok(along > 20 && along < 40, `travelled ${along} nm along the path`);
  });
});

describe("coverage gaps", () => {
  it("trackGaps marks only the jumps longer than 25 nm", () => {
    const track: [number, number, string][] = [[25.0, -80.0, T0], [25.01, -80.0, T0], [25.4, -80.0, T0], [25.41, -80.0, T0], [26.0, -79.0, T0]];
    // 0.6 nm, 24 nm, 0.6 nm, 64 nm
    assert.deepEqual(trackGaps(track), [3]);
    assert.deepEqual(trackGaps([]), []);
  });
  it("believablePath: two points only for a short hop, never a wild detour", () => {
    const offBaja: [number, number] = [31.14561, -117.15308], cabo: [number, number] = [22.88432, -109.89706];
    assert.equal(believablePath([offBaja, [32.7, -117.3], [27.5, -115.2], [25.0007, -112.4212], cabo]), true, "Baja: around the cape, about 1.3 times the straight line");
    assert.equal(believablePath([offBaja, cabo]), false, "just the two ends of a 629-mile gap is the straight line again");
    assert.equal(believablePath([[20.76668, -86.79518], [21.3395, -89.666]]), false, "Cozumel to Progreso as two points: straight over the Yucatán");
    assert.equal(believablePath([[25.76, -80.13], [25.77, -80.19]]), true, "a short hop into port");
    assert.equal(believablePath([[39.22141, 25.68713], [37.5, 24.5], [39.97138, 26.01108]]), false, "47 nm apart, drawn as a long detour");
    assert.equal(believablePath(null), false);
    assert.equal(believablePath([[25, -80]]), false);
  });
  it("a straight 'path' ahead or to the estimate is not drawn across open miles", () => {
    const fix = { lat: 25.6, lon: -79.6, courseDeg: 105, speedKn: 16, at: T0 };
    const straightToNassau: Path = [[fix.lat, fix.lon], [NASSAU.lat, NASSAU.lon]];
    const est = estimatePosition(fix, at(2), NASSAU, null, straightToNassau)!;
    const r = routeLine(fix, est, null, NASSAU, { toDestPath: straightToNassau, aheadPath: [[est.lat, est.lon], [NASSAU.lat, NASSAU.lon]] });
    assert.deepEqual(r.between, [], "no dotted straight line to the estimate");
    assert.deepEqual(r.ahead, [], "no dashed straight line to Nassau");
    const nearPort = { ...fix, lat: 25.1, lon: -77.5 };
    const close = routeLine(nearPort, null, null, NASSAU, { aheadPath: [[nearPort.lat, nearPort.lon], [NASSAU.lat, NASSAU.lon]] });
    assert.equal(close.ahead.length, 2, "a few miles into port can be straight");
  });
  it("pathUntil keeps the path up to a point on it", () => {
    const path: Path = [[0, 0], [0, 1], [0, 2], [0, 3]];
    assert.deepEqual(pathUntil(path, { lat: 0, lon: 1.5 }), [[0, 0], [0, 1], [0, 1.5]]);
    assert.deepEqual(pathUntil(path, { lat: 0, lon: 3 }), [[0, 0], [0, 1], [0, 2], [0, 3]]);
  });
});

describe("nearbyShips", () => {
  const now = at(0);
  const mk = (name: string, lat: number, lon: number, minAgo = 5) => ({
    name, cruiseLine: "Carnival", lat, lon, cogDeg: 90, sogKn: 12, lastPosAt: new Date(now.getTime() - minAgo * 60_000).toISOString(),
  });
  const center = { lat: 25.5, lon: -79.5 };
  const nine = destinationPoint(center.lat, center.lon, 45, 9);
  const eleven = destinationPoint(center.lat, center.lon, 45, 11);
  it("keeps ships inside 10 nm with a recent fix, nearest first, never the ship herself", () => {
    const all = [
      mk("Tracked Ship", center.lat, center.lon),
      mk("Close One", nine.lat, nine.lon),
      mk("Just Outside", eleven.lat, eleven.lon),
      mk("Old Fix", center.lat + 0.02, center.lon, 61),
      { ...mk("No Fix", 0, 0), lat: null, lon: null, lastPosAt: null },
      mk("Closer", center.lat + 0.03, center.lon),
    ];
    const out = nearbyShips(all, center, "Tracked Ship", now);
    assert.deepEqual(out.map((s) => s.name), ["Closer", "Close One"]);
    assert.ok(out[1]!.distanceNm >= 8.9 && out[1]!.distanceNm <= 9.1);
  });
});
