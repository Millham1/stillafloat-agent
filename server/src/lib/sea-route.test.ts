// sea-route.test.ts — the route line must stay on water.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { seaRoute } from "./sea-route";

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
