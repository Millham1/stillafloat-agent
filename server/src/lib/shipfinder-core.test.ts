// shipfinder-core.test.ts — the documented response shape decodes to a real fix.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseShipfinder, parseShipfinderEta, DEFAULT_SHIPFINDER_CAP, SHIPFINDER_URL, shipfinderUrl, shipfinderEndpoint, parseShipfinderList, parseShipfinderSearch, parseShipfinderTrack, shipNamesMatch, verifyRegistryEntry, parseShipfinderSearchResult, isThrottle } from "./shipfinder-core";

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

// ── the free endpoints ─────────────────────────────────────────────────────────

describe("parseShipfinderList (Vessels Nearby / Multi)", () => {
  it("returns every usable vessel with its fix, and skips rows with no position or a bad MMSI", () => {
    const body = { status: 0, total: 3, data: [
      { ...DOC.data, mmsi: 311001259, ship_name: "UTOPIA OF THE SEAS", data_source: 1, lat: 28.41, lng: -80.62 },
      { ...DOC.data, mmsi: 12345, ship_name: "BAD MMSI" },
      { ...DOC.data, mmsi: 338391681, ship_name: "POSITIVE SPACE", lat: 0, lng: 0 },
    ] };
    const list = parseShipfinderList(body);
    assert.deepEqual(list.map((v) => [v.mmsi, v.name, v.fix.source]), [["311001259", "UTOPIA OF THE SEAS", "satellite"]]);
    assert.deepEqual(parseShipfinderList({ status: 21, msg: "Unauthorized" }), []);
  });
  it("endpoints hang off the key's root, whichever host it is bound to", () => {
    assert.equal(shipfinderEndpoint("AIS/VesselsNearby"), "https://open.shipfinder.com/v1/AIS/VesselsNearby");
    assert.equal(shipfinderEndpoint("History/VesselHistoryTrack"), "https://open.shipfinder.com/v1/History/VesselHistoryTrack");
  });
});

describe("parseShipfinderSearch + registry verdicts", () => {
  const search = { status: 0, total: 1, data: [{ match_type: 1, mmsi: 311001259, imo: 9880001, call_sign: "C6G19", ship_name: "UTOPIA OF THE SEAS", data_source: 0, last_time: 1789139905 }] };
  it("decodes a search hit", () => {
    assert.deepEqual(parseShipfinderSearch(search), [{ mmsi: "311001259", imo: "9880001", name: "UTOPIA OF THE SEAS", matchType: 1, lastTime: "2026-09-11T15:18:25.000Z" }]);
  });
  it("names match loosely: case, punctuation and the AIS 20-character cut", () => {
    assert.ok(shipNamesMatch("Utopia of the Seas", "UTOPIA OF THE SEAS"));
    assert.ok(shipNamesMatch("Margaritaville at Sea Islander", "MARGARITAVILLE AT SE"));
    assert.ok(!shipNamesMatch("Carnival Glory", "CARNIVAL GLORIA"));
    assert.ok(!shipNamesMatch("MSC Seaside", "MSC SEASHORE"));
  });
  const hits = parseShipfinderSearch(search);
  it("ok: our MMSI answers to our name (and fills a missing IMO)", () => {
    const v = verifyRegistryEntry({ name: "Utopia of the Seas", mmsi: "311001259", imo: null }, hits, []);
    assert.equal(v.status, "ok"); assert.equal(v.proposedImo, "9880001");
  });
  it("corrected: our MMSI answers to another hull, and our IMO is found under a new MMSI", () => {
    const other = [{ mmsi: "311001259", imo: "1111111", name: "SOME TANKER", matchType: 1, lastTime: null }];
    const byName = [{ mmsi: "311099999", imo: "9880001", name: "UTOPIA OF THE SEAS", matchType: 1, lastTime: null }];
    const v = verifyRegistryEntry({ name: "Utopia of the Seas", mmsi: "311001259", imo: "9880001" }, other, byName);
    assert.equal(v.status, "corrected"); assert.equal(v.proposedMmsi, "311099999"); assert.equal(v.reportedName, "SOME TANKER");
  });
  it("suspect: our MMSI answers to another hull and nothing ties a replacement to us", () => {
    const other = [{ mmsi: "311001259", imo: null, name: "SOME TANKER", matchType: 1, lastTime: null }];
    const v = verifyRegistryEntry({ name: "Utopia of the Seas", mmsi: "311001259", imo: null }, other, []);
    assert.equal(v.status, "suspect"); assert.equal(v.proposedMmsi, null);
  });
  it("unknown MMSI with exactly one hull of our name = corrected; with two = unknown", () => {
    const one = [{ mmsi: "311099999", imo: "9880001", name: "UTOPIA OF THE SEAS", matchType: 1, lastTime: null }];
    assert.equal(verifyRegistryEntry({ name: "Utopia of the Seas", mmsi: "311000000", imo: null }, [], one).status, "corrected");
    const two = [...one, { mmsi: "311088888", imo: null, name: "UTOPIA OF THE SEAS", matchType: 2, lastTime: null }];
    assert.equal(verifyRegistryEntry({ name: "Utopia of the Seas", mmsi: "311000000", imo: null }, [], two).status, "unknown");
  });
});

describe("parseShipfinderTrack", () => {
  it("returns points oldest first with knots and the satellite flag; drops bad rows", () => {
    const body = { status: 0, data: [
      { data_source: 0, utc: 1789053673, lng: -79.668403, lat: 25.691213, sog: 8.1, cog: 264.0 },
      { data_source: 1, utc: 1789050000, lng: -79.5, lat: 25.6, sog: 12.0, cog: 270.0 },
      { data_source: 0, utc: 0, lng: -79.4, lat: 25.5, sog: 1, cog: 1 },
    ] };
    const pts = parseShipfinderTrack(body);
    assert.equal(pts.length, 2);
    assert.equal(pts[0]!.source, "satellite");
    assert.ok(Date.parse(pts[0]!.at) < Date.parse(pts[1]!.at));
    assert.equal(pts[1]!.speedKn, 8.1);
  });
});

describe("search throttling", () => {
  it("status 38 'The number of queries exceeded' is a throttle with no hits, never a verdict", () => {
    const r = parseShipfinderSearchResult({ status: 38, msg: "The number of queries exceeded" });
    assert.equal(r.status, 38); assert.deepEqual(r.hits, []); assert.ok(isThrottle(r.status));
    assert.ok(!isThrottle(0)); assert.ok(!isThrottle(9)); assert.ok(!isThrottle(null));
  });
});
