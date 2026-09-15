// sea-route.test.ts — the route line must stay on water.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gapPaths, seaRoute, MAX_ROUTED_GAPS } from "./sea-route";
import { distanceNm } from "./dead-reckoning";

// Crude land boxes a straight line would cross. Any route point inside one = failure.
const YUCATAN = { latMin: 18.0, latMax: 21.4, lonMin: -90.6, lonMax: -87.6 };
const inBox = (p: [number, number], b: typeof YUCATAN) => p[0] > b.latMin && p[0] < b.latMax && p[1] > b.lonMin && p[1] < b.lonMax;

describe("seaRoute", () => {
  it("Galveston to Cozumel goes around the Yucatán, not through it", async () => {
    const r = await seaRoute({ lat: 29.3013, lon: -94.7977 }, { lat: 20.5083, lon: -86.9223 });
    assert.ok(r, "a route exists");
    assert.ok(r!.points.length >= 3);
    assert.deepEqual(r!.points[0], [29.3013, -94.7977]);
    assert.deepEqual(r!.points[r!.points.length - 1], [20.5083, -86.9223]);
    for (const p of r!.points) assert.ok(!inBox(p, YUCATAN), `point ${p} is on the Yucatán`);
    assert.ok(r!.lengthNm > 600 && r!.lengthNm < 800, `length ${r!.lengthNm}`);
  });
  it("is cached and repeatable", async () => {
    const a = await seaRoute({ lat: 25.7617, lon: -80.1918 }, { lat: 25.0443, lon: -77.3504 });
    const b = await seaRoute({ lat: 25.7617, lon: -80.1918 }, { lat: 25.0443, lon: -77.3504 });
    assert.ok(a && b && a === b);
  });
});

// Real coverage gaps from the dev tracker, 2026-09-15 (Mark: "the tracks are still running through land").
// A crude box that is all land; a line is sampled every few miles and no sample may fall inside.
const BAJA_SUR = { latMin: 24.3, latMax: 25.0, lonMin: -111.45, lonMax: -111.05 };
const samples = (path: [number, number][], stepNm = 3): [number, number][] => {
  const out: [number, number][] = [];
  for (let i = 1; i < path.length; i++) {
    const [la1, lo1] = path[i - 1]!; const [la2, lo2] = path[i]!;
    const n = Math.max(1, Math.ceil(distanceNm(la1, lo1, la2, lo2) / stepNm));
    for (let k = 0; k <= n; k++) out.push([la1 + (la2 - la1) * k / n, lo1 + (lo2 - lo1) * k / n]);
  }
  return out;
};
const crosses = (path: [number, number][], box: typeof YUCATAN) => samples(path).some((p) => inBox(p, box));

describe("gapPaths (real gaps from the dev tracker)", () => {
  it("Carnival Panorama, heard off northern Baja then at Cabo: the gap follows the water around Baja", async () => {
    const offBaja: [number, number, string] = [31.14561, -117.15308, "2026-09-14T02:00:00Z"];
    const cabo: [number, number, string] = [22.88432, -109.89706, "2026-09-15T10:00:00Z"];
    assert.ok(crosses([[offBaja[0], offBaja[1]], [cabo[0], cabo[1]]], BAJA_SUR), "the old straight segment crossed the peninsula");
    const [path] = await gapPaths([offBaja, cabo]);
    assert.ok(path, "a water path is drawn across the gap");
    assert.deepEqual(path![0], [offBaja[0], offBaja[1]]);
    assert.deepEqual(path![path!.length - 1], [cabo[0], cabo[1]]);
    assert.ok(!crosses(path!, BAJA_SUR), "the water path stays off the peninsula");
  });

  it("Carnival Breeze, Cozumel then Progreso: no real water path, so nothing is drawn across the Yucatán", async () => {
    const cozumel: [number, number, string] = [20.76668, -86.79518, "2026-09-13T20:00:00Z"];
    const progreso: [number, number, string] = [21.3395, -89.666, "2026-09-14T12:00:00Z"];
    assert.ok(crosses([[cozumel[0], cozumel[1]], [progreso[0], progreso[1]]], YUCATAN), "the old straight segment crossed the Yucatán");
    assert.deepEqual(await gapPaths([cozumel, progreso]), [null]);
  });

  it("Celebrity Ascent, a 47 nm Aegean gap the lanes route as a long detour: left empty", async () => {
    assert.deepEqual(await gapPaths([[39.22141, 25.68713, "2026-09-13T08:00:00Z"], [39.97138, 26.01108, "2026-09-13T12:00:00Z"]]), [null]);
  });

  it("only gaps are routed, and only the newest MAX_ROUTED_GAPS of them", async () => {
    const track: [number, number, string][] = [];
    for (let i = 0; i <= MAX_ROUTED_GAPS + 2; i++) track.push([10 + i, -40, "2026-09-10T00:00:00Z"], [10 + i + 0.005, -40, "2026-09-10T00:05:00Z"]);
    let calls = 0;
    const fake = async (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
      calls++;
      return { points: [[a.lat, a.lon], [(a.lat + b.lat) / 2, -40.5], [b.lat, b.lon]] as [number, number][], lengthNm: 62 };
    };
    const out = await gapPaths(track, fake);
    assert.equal(out.length, MAX_ROUTED_GAPS + 2, "one entry per gap, none for the short steps");
    assert.equal(calls, MAX_ROUTED_GAPS);
    assert.deepEqual(out.slice(0, 2), [null, null], "the two oldest gaps are not routed");
    assert.ok(out.slice(2).every((p) => p && p.length === 3));
  });
});

