// dead-reckoning.test.ts — the estimate is honest arithmetic, not a guess.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  distanceNm, bearingDeg, destinationPoint, greatCirclePoints, pathLengthNm, pointAlongPath, appendTrack,
  estimatePosition, routeLine, nearbyShips, ESTIMATE_AFTER_MIN, MAX_COURSE_HOURS, TRACK_MAX_POINTS, STALE_FIX_H,
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
  it("uses the water path behind her and the water path ahead, ending on the ports", () => {
    const est = estimatePosition(fix, at(2), NASSAU, null)!;
    const ahead: [number, number][] = [[est.lat, est.lon], [25.3, -78.4], [NASSAU.lat, NASSAU.lon]];
    const r = routeLine(fix, est, MIAMI, NASSAU, { behindPath: behind, aheadPath: ahead });
    assert.deepEqual(r.travelled[0], [MIAMI.lat, MIAMI.lon]);
    assert.deepEqual(r.travelled[r.travelled.length - 1], [est.lat, est.lon]);
    assert.deepEqual(r.ahead, ahead);
  });
  it("prefers her REAL track over any computed path behind her", () => {
    const track: [number, number, string][] = [[25.75, -80.15, T0], [25.68, -79.9, T0], [fix.lat, fix.lon, T0]];
    const r = routeLine(fix, null, MIAMI, NASSAU, { track, behindPath: behind });
    assert.deepEqual(r.travelled, track.map(([a, b]) => [a, b]));
  });
  it("draws NOTHING for a leg it has no water path for — never a straight line", () => {
    const r = routeLine(fix, null, MIAMI, NASSAU, {});
    assert.deepEqual(r.travelled, [[fix.lat, fix.lon]]);
    assert.deepEqual(r.ahead, []);
  });
  it("a departed port from a previous sailing (far away) is not drawn", () => {
    const seattle = { slug: "seattle", name: "Seattle", lat: 47.6, lon: -122.3 };
    const r = routeLine(fix, null, seattle, NASSAU, { behindPath: [[seattle.lat, seattle.lon], [fix.lat, fix.lon]] });
    assert.deepEqual(r.travelled, [[fix.lat, fix.lon]]);
  });
  it("nothing ahead when the fix is stale, even with a destination and a water path", () => {
    const fix = { lat: MIAMI.lat, lon: MIAMI.lon, courseDeg: 105, speedKn: 0.2, at: T0 };
    const est = estimatePosition(fix, at(STALE_FIX_H + 1), NASSAU, null)!;
    assert.equal(est.basis, "stale");
    const r = routeLine(fix, est, MIAMI, NASSAU, { aheadPath: [[fix.lat, fix.lon], [NASSAU.lat, NASSAU.lon]] });
    assert.deepEqual(r.ahead, []);
    assert.deepEqual(r.travelled[r.travelled.length - 1], [fix.lat, fix.lon], "the line ends at the last real fix");
  });
  it("nothing ahead once she has arrived", () => {
    const est = estimatePosition(fix, at(30), NASSAU, null)!;
    assert.equal(est.basis, "arrived");
    assert.deepEqual(routeLine(fix, est, MIAMI, NASSAU, { aheadPath: [[fix.lat, fix.lon], [NASSAU.lat, NASSAU.lon]] }).ahead, []);
  });
  it("with a water path the estimate slides along it, not the great circle", () => {
    const water: [number, number][] = [[fix.lat, fix.lon], [25.55, -79.0], [25.2, -78.0], [NASSAU.lat, NASSAU.lon]];
    const e = estimatePosition(fix, at(2), NASSAU, null, water)!;
    assert.equal(e.basis, "route");
    const along = distanceNm(fix.lat, fix.lon, e.lat, e.lon);
    assert.ok(along > 20 && along < 40, `travelled ${along} nm along the path`);
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
