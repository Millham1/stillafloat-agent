// dead-reckoning.test.ts — the estimate is honest arithmetic, not a guess.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  distanceNm, bearingDeg, destinationPoint, greatCirclePoints,
  estimatePosition, routeLine, nearbyShips, ESTIMATE_AFTER_MIN, MAX_COURSE_HOURS,
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
  it("a stopped ship is held where she was, not drifted along a course", () => {
    const e = estimatePosition({ ...underway, speedKn: 0.3 }, at(5), NASSAU, null)!;
    assert.equal(e.basis, "hold");
    assert.deepEqual([e.lat, e.lon], [MIAMI.lat, MIAMI.lon]);
  });
  it("without a destination she is dead-reckoned along her course, capped at MAX_COURSE_HOURS", () => {
    const e2 = estimatePosition(underway, at(2), null, null)!;
    assert.equal(e2.basis, "course");
    assert.ok(Math.abs(distanceNm(MIAMI.lat, MIAMI.lon, e2.lat, e2.lon) - 32) < 0.5);
    const e30 = estimatePosition(underway, at(30), null, null)!;
    assert.equal(e30.confidence, "low");
    assert.ok(Math.abs(distanceNm(MIAMI.lat, MIAMI.lon, e30.lat, e30.lon) - 16 * MAX_COURSE_HOURS) < 0.5, "holds after the cap");
  });
  it("no destination and no course = no estimate at all", () => {
    assert.equal(estimatePosition({ ...underway, courseDeg: null }, at(2), null, null), null);
  });
});

describe("routeLine", () => {
  const fix = { lat: 25.6, lon: -79.6, courseDeg: 105, speedKn: 16, at: T0 };
  it("draws departed port → fix → estimate, then estimate → destination", () => {
    const est = estimatePosition(fix, at(2), NASSAU, null)!;
    const r = routeLine(fix, est, MIAMI, NASSAU);
    assert.deepEqual(r.travelled[0], [MIAMI.lat, MIAMI.lon]);
    assert.deepEqual(r.travelled[r.travelled.length - 1], [est.lat, est.lon]);
    assert.deepEqual(r.ahead[0], [est.lat, est.lon]);
    assert.deepEqual(r.ahead[r.ahead.length - 1], [NASSAU.lat, NASSAU.lon]);
  });
  it("a departed port from a previous sailing (far away) is not drawn", () => {
    const seattle = { slug: "seattle", name: "Seattle", lat: 47.6, lon: -122.3 };
    const r = routeLine(fix, null, seattle, NASSAU);
    assert.deepEqual(r.travelled, [[fix.lat, fix.lon]]);
  });
  it("nothing ahead once she has arrived", () => {
    const est = estimatePosition(fix, at(30), NASSAU, null)!;
    assert.equal(est.basis, "arrived");
    assert.deepEqual(routeLine(fix, est, MIAMI, NASSAU).ahead, []);
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
