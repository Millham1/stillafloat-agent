// shipfinder-core.test.ts — the documented response shape decodes to a real fix.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseShipfinder, parseShipfinderEta, DEFAULT_SHIPFINDER_CAP, SHIPFINDER_URL, shipfinderUrl } from "./shipfinder-core";

// Verbatim example from docs.shipfinder.com 1.1.1 Single Vessel Position (read 2026-09-11)
const DOC = { status: 0, msg: "", data: { mmsi: 413961925, imo: 0, call_sign: "P", ship_name: "WANHONGYUAN369", data_source: 0, ship_type: 70, length: 68, width: 13, draught: 4.8, dest: "TAIZHOU,CN", destcode: "CNTZO", eta: 1745827548, navistat: 0, lat: 32.192517, lng: 119.628093, sog: 6.2, cog: 80.8, hdg: 511, rot: 0, last_time: 1745827548 } };

describe("parseShipfinder (api.elaneglobal.com)", () => {
  it("decodes the documented example: decimal degrees, knots, degrees, unix seconds, 511 heading = unknown", () => {
    const f = parseShipfinder(DOC)!;
    assert.ok(f);
    assert.equal(f.lat, 32.192517);
    assert.equal(f.lon, 119.628093);
    assert.equal(f.speedKn, 6.2);
    assert.equal(f.courseDeg, 80.8);
    assert.equal(f.headingDeg, null);
    assert.equal(f.at, "2025-04-28T08:05:48.000Z");
    assert.equal(f.source, "terrestrial");
    assert.equal(f.destination, "CNTZO", "the port code is preferred: it decodes through the LOCODE table");
    assert.equal(f.etaUtc, "2025-04-28T08:05:48.000Z");
  });
  it("data_source 1 is a satellite fix; a missing destcode falls back to the name", () => {
    const f = parseShipfinder({ status: 0, data: { ...DOC.data, data_source: 1, destcode: "", hdg: 12.4 } })!;
    assert.equal(f.source, "satellite");
    assert.equal(f.headingDeg, 12.4);
    assert.equal(f.destination, "TAIZHOU,CN");
  });
  it("a non-zero status (Key Not Found = 9), no data, or a 0/0 position is no fix", () => {
    assert.equal(parseShipfinder({ status: 9, msg: "Key Not Found" }), null);
    assert.equal(parseShipfinder({ status: 0, data: null }), null);
    assert.equal(parseShipfinder({ status: 0, data: { ...DOC.data, lat: 0, lng: 0 } }), null);
    assert.equal(parseShipfinder("nope"), null);
  });
  it("ETA accepts unix seconds or the documented 'YYYY-MM-DD HH:MM:SS' UTC string", () => {
    assert.equal(parseShipfinderEta(1745827548), "2025-04-28T08:05:48.000Z");
    assert.equal(parseShipfinderEta("2026-09-12 09:00:00"), "2026-09-12T09:00:00.000Z");
    assert.equal(parseShipfinderEta("soon"), null);
    assert.equal(parseShipfinderEta(undefined), null);
  });
  it("targets the console host by default (Starter keys), overridable, and leaves headroom inside a 50-call Starter key", () => {
    assert.equal(SHIPFINDER_URL, "https://open.shipfinder.com/v1/AIS/VesselPositionSingle");
    process.env["SHIPFINDER_API_BASE"] = "https://api.elaneglobal.com/v1/AIS/";
    assert.equal(shipfinderUrl(), "https://api.elaneglobal.com/v1/AIS/VesselPositionSingle");
    delete process.env["SHIPFINDER_API_BASE"];
    assert.equal(shipfinderUrl(), SHIPFINDER_URL);
    assert.ok(DEFAULT_SHIPFINDER_CAP < 50);
  });
});
