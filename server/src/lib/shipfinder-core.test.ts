// shipfinder-core.test.ts — the documented response shape decodes to a real fix.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseShipfinder, parseShipfinderEta, DEFAULT_SHIPFINDER_CAP } from "./shipfinder-core";

// Verbatim example from api.shipfinder.com (read 2026-09-11)
const DOC = { status: 0, data: [{ ShipID: 477765900, mmsi: 477765900, lat: 29783198, lon: 122090300, sog: 51, cog: 14310, hdg: 0, dest: "NGB", eta: "03-20 03:45", From: 0, lasttime: 1490838348 }], dataVersion: 50509 };
const NOW = new Date("2017-03-18T12:00:00Z");

describe("parseShipfinder", () => {
  it("decodes the documented example: micro-degrees, mm/s, centi-degrees, unix seconds", () => {
    const f = parseShipfinder(DOC, NOW)!;
    assert.ok(f);
    assert.equal(f.lat, 29.783198);
    assert.equal(f.lon, 122.0903);
    assert.equal(f.speedKn, 0.1);          // 51 mm/s
    assert.equal(f.courseDeg, 143.1);
    assert.equal(f.headingDeg, 0);
    assert.equal(f.at, "2017-03-30T01:45:48.000Z"); // 1490838348 s
    assert.equal(f.source, "terrestrial");
    assert.equal(f.destination, "NGB");
    assert.equal(f.etaUtc, "2017-03-20T03:45:00.000Z");
  });
  it("From: 1 is a satellite fix; a 511 heading is 'not available'; speed converts to knots", () => {
    const f = parseShipfinder({ status: 0, data: [{ ...DOC.data[0], From: 1, hdg: 51100, sog: 7202 }] }, NOW)!;
    assert.equal(f.source, "satellite");
    assert.equal(f.headingDeg, null);
    assert.equal(f.speedKn, 14);            // 7,202 mm/s = 14.0 kn
  });
  it("a non-zero status, an empty data list, or a 0/0 position is no fix", () => {
    assert.equal(parseShipfinder({ status: 1, data: [] }, NOW), null);
    assert.equal(parseShipfinder({ status: 0, data: [] }, NOW), null);
    assert.equal(parseShipfinder({ status: 0, data: [{ ...DOC.data[0], lat: 0, lon: 0 }] }, NOW), null);
    assert.equal(parseShipfinder("nope", NOW), null);
  });
  it("ETA without a year: this year unless it passed more than a week ago (then next year); a bad string is null", () => {
    assert.equal(parseShipfinderEta("12-24 08:00", new Date("2026-12-30T00:00:00Z")), "2026-12-24T08:00:00.000Z", "passed 6 days ago = last leg's ETA, keep the year");
    assert.equal(parseShipfinderEta("12-24 08:00", new Date("2027-01-05T00:00:00Z")), "2027-12-24T08:00:00.000Z", "passed 12 days ago = next year");
    assert.equal(parseShipfinderEta("00-00 24:60", NOW), null);
    assert.equal(parseShipfinderEta(undefined, NOW), null);
  });
  it("the default cap leaves headroom inside a 50-call Starter key", () => {
    assert.ok(DEFAULT_SHIPFINDER_CAP < 50);
  });
});
