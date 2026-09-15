// port-calls-from-track.test.ts — a day of positions becomes a port-call log.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { portCallsFromTrack, mergePortCalls, MIN_CALL_MINUTES } from "./port-calls-from-track";
import type { TrackSample } from "./shipfinder-core";

const CANAVERAL = { lat: 28.3922, lon: -80.6077 };
const NASSAU = { lat: 25.0443, lon: -77.3504 };
const t = (h: number) => new Date(Date.UTC(2026, 8, 10, 0, 0, 0) + h * 3_600_000).toISOString();
const at = (p: { lat: number; lon: number }, h: number, kn: number): TrackSample => ({ lat: p.lat, lon: p.lon, at: t(h), speedKn: kn, source: "terrestrial" });
const sea = (h: number): TrackSample => ({ lat: 26.5, lon: -79.0, at: t(h), speedKn: 18, source: "terrestrial" });

describe("portCallsFromTrack", () => {
  it("alongside at Canaveral, a sea day, then alongside at Nassau = two calls with real times", () => {
    const samples = [at(CANAVERAL, 0, 0), at(CANAVERAL, 3, 0.2), at(CANAVERAL, 6, 0), sea(9), sea(12), at(NASSAU, 16, 0), at(NASSAU, 20, 0.1)];
    const calls = portCallsFromTrack(samples, new Date(t(21)));
    assert.deepEqual(calls.map((c) => c.slug), ["port-canaveral", "nassau"]);
    assert.equal(calls[0]!.arrivedAt, t(0));
    assert.equal(calls[0]!.departedAt, t(9), "departure = the first point away from the pier");
    assert.equal(calls[1]!.departedAt, null, "still there at the end of the track");
  });
  it("moving fast inside the port radius is not a call, and a brush past the pier is dropped", () => {
    const fast = [at(CANAVERAL, 0, 12), at(CANAVERAL, 0.1, 14), sea(2)];
    assert.deepEqual(portCallsFromTrack(fast, new Date(t(3))), []);
    const brush = [sea(0), at(NASSAU, 1, 0), sea(1 + (MIN_CALL_MINUTES - 5) / 60)];
    assert.deepEqual(portCallsFromTrack(brush, new Date(t(3))), []);
  });
  it("mergePortCalls keeps the tracker's own call and adds the missing one, oldest first", () => {
    const existing = [{ slug: "nassau", arrivedAt: t(16), departedAt: null }];
    const derived = [{ slug: "port-canaveral", arrivedAt: t(0), departedAt: t(9) }, { slug: "nassau", arrivedAt: t(16.5), departedAt: null }];
    const merged = mergePortCalls(existing, derived);
    assert.deepEqual(merged.map((c) => c.slug), ["port-canaveral", "nassau"]);
    assert.equal(merged[1]!.arrivedAt, t(16), "the tracker's own record wins over a near-duplicate");
  });
});
