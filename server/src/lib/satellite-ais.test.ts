// satellite-ais.test.ts — the spend gate and the provider parsing, no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lookupDecision, parsePositionReceived, parseDetail, blankLedger, monthKey, LOOKUP_AFTER_MIN, VIEW_WINDOW_MIN, STANDING_WINDOW_MIN } from "./satellite-ais-core";

const NOW = new Date("2026-09-10T18:00:00.000Z");
const iso = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000).toISOString();

describe("lookupDecision", () => {
  it("does not spend on a ship with a fresh free fix", () => {
    const r = lookupDecision({ lastFixAt: iso(LOOKUP_AFTER_MIN - 1), ledger: blankLedger(NOW), mmsi: "1", cap: 100, now: NOW, reason: "view" });
    assert.deepEqual(r, { ok: false, why: "fresh" });
  });
  it("spends once the fix is stale, then not again for the same ship inside the window", () => {
    const ledger = blankLedger(NOW);
    assert.deepEqual(lookupDecision({ lastFixAt: iso(45), ledger, mmsi: "1", cap: 100, now: NOW, reason: "view" }), { ok: true });
    ledger.lastByMmsi["1"] = iso(VIEW_WINDOW_MIN - 5); ledger.used = 1;
    assert.deepEqual(lookupDecision({ lastFixAt: iso(45), ledger, mmsi: "1", cap: 100, now: NOW, reason: "view" }), { ok: false, why: "recent-lookup" });
    assert.deepEqual(lookupDecision({ lastFixAt: iso(45), ledger, mmsi: "2", cap: 100, now: NOW, reason: "view" }), { ok: true }, "another ship is fine");
  });
  it("a standing need (watch, storm) waits three hours between lookups; a viewer waits thirty minutes", () => {
    const ledger = blankLedger(NOW); ledger.lastByMmsi["1"] = iso(STANDING_WINDOW_MIN - 10); ledger.used = 1;
    assert.deepEqual(lookupDecision({ lastFixAt: iso(400), ledger, mmsi: "1", cap: 100, now: NOW, reason: "watch" }), { ok: false, why: "recent-lookup" });
    assert.deepEqual(lookupDecision({ lastFixAt: iso(400), ledger, mmsi: "1", cap: 100, now: NOW, reason: "storm" }), { ok: false, why: "recent-lookup" });
    assert.deepEqual(lookupDecision({ lastFixAt: iso(400), ledger, mmsi: "1", cap: 100, now: NOW, reason: "view" }), { ok: true }, "170 min is past the viewer window");
    ledger.lastByMmsi["1"] = iso(STANDING_WINDOW_MIN + 1);
    assert.deepEqual(lookupDecision({ lastFixAt: iso(400), ledger, mmsi: "1", cap: 100, now: NOW, reason: "watch" }), { ok: true });
  });
  it("a ship that has never reported counts as stale", () => {
    assert.deepEqual(lookupDecision({ lastFixAt: null, ledger: blankLedger(NOW), mmsi: "1", cap: 100, now: NOW, reason: "view" }), { ok: true });
  });
  it("the monthly cap is a hard stop, and a new month resets it", () => {
    const ledger = { ...blankLedger(NOW), used: 100 };
    assert.deepEqual(lookupDecision({ lastFixAt: null, ledger, mmsi: "1", cap: 100, now: NOW, reason: "view" }), { ok: false, why: "cap" });
    const lastMonth = { ...ledger, month: "2026-08" };
    assert.deepEqual(lookupDecision({ lastFixAt: null, ledger: lastMonth, mmsi: "1", cap: 100, now: NOW, reason: "view" }), { ok: true });
    assert.equal(monthKey(NOW), "2026-09");
  });
  it("a cap of zero (the free trial after its credits) never spends", () => {
    assert.deepEqual(lookupDecision({ lastFixAt: null, ledger: blankLedger(NOW), mmsi: "1", cap: 0, now: NOW, reason: "view" }), { ok: false, why: "cap" });
  });
});

describe("Datadocked parsing", () => {
  it("reads the provider's timestamp format", () => {
    assert.equal(parsePositionReceived("Jan 04, 2026 04:15 UTC"), "2026-01-04T04:15:00.000Z");
    assert.equal(parsePositionReceived("Sep 10, 2026 17:03 UTC"), "2026-09-10T17:03:00.000Z");
    assert.equal(parsePositionReceived("2026-09-10T17:03:00Z"), "2026-09-10T17:03:00.000Z");
    assert.equal(parsePositionReceived("yesterday-ish"), null);
    assert.equal(parsePositionReceived(undefined), null);
  });
  it("maps a detail object to a fix and tags the source", () => {
    const fix = parseDetail({ name: "CARNIVAL JUBILEE", latitude: "20.51", longitude: "-86.95", speed: "0.2", course: "91", heading: "89", positionReceived: "Sep 10, 2026 17:03 UTC", dataSource: "Satellite" });
    assert.deepEqual(fix, { lat: 20.51, lon: -86.95, courseDeg: 91, speedKn: 0.2, headingDeg: 89, at: "2026-09-10T17:03:00.000Z", source: "satellite" });
  });
  it("refuses a detail with no position, a 0/0 position, or no time", () => {
    assert.equal(parseDetail({ name: "X" }), null);
    assert.equal(parseDetail({ latitude: "0", longitude: "0", positionReceived: "Sep 10, 2026 17:03 UTC" }), null);
    assert.equal(parseDetail({ latitude: "20", longitude: "-86" }), null);
    assert.equal(parseDetail(null), null);
  });
  it("treats AIS 'not available' sentinels as unknown, not as values", () => {
    const fix = parseDetail({ latitude: "20", longitude: "-86", speed: "102.3", course: "360", heading: "511", positionReceived: "Sep 10, 2026 17:03 UTC", dataSource: "Terrestrial" })!;
    assert.equal(fix.speedKn, null); assert.equal(fix.courseDeg, null); assert.equal(fix.headingDeg, null); assert.equal(fix.source, "terrestrial");
  });
});
