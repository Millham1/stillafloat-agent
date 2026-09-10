// satellite-ais.test.ts — the spend gate and the provider parsing, no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lookupDecision, parsePositionReceived, parseDetail, blankLedger, monthKey, LOOKUP_AFTER_MIN, VIEW_WINDOW_MIN, STANDING_WINDOW_MIN } from "./satellite-ais-core";
import { allowlisted, sweepEnabled } from "./satellite-ais-core";

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
  it("maps the documented { detail } shape AND the live flat shape to a fix, tagging the source", () => {
    const flat = { name: "CARNIVAL_CELEBRATION", mmsi: "311001223", latitude: "16.324308", longitude: "-86.498749", speed: "0.0", course: "336", heading: "191", destination: "Mahogany bay Honduras", etaUtc: "Sep 10, 2026 11:06 UTC", positionReceived: "Sep 10, 2026 18:04 UTC", updateTime: "Sep 10, 2026 18:08 UTC", dataSource: "Terrestrial" };
    const expected = { lat: 16.324308, lon: -86.498749, courseDeg: 336, speedKn: 0, headingDeg: 191, at: "2026-09-10T18:04:00.000Z", source: "terrestrial", destination: "Mahogany bay Honduras", etaUtc: "2026-09-10T11:06:00.000Z" };
    assert.deepEqual(parseDetail(flat), expected);
    assert.deepEqual(parseDetail({ detail: flat }), expected);
    assert.equal(parseDetail({ ...flat, dataSource: "Satellite", destination: "None" })!.source, "satellite");
    assert.equal(parseDetail({ ...flat, destination: "None" })!.destination, null);
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

describe("test-mode switches", () => {
  it("an allowlist restricts lookups to the named ships (by name or MMSI); unset allows all", () => {
    const prev = process.env["SATELLITE_ALLOWLIST"];
    try {
      delete process.env["SATELLITE_ALLOWLIST"];
      assert.equal(allowlisted("1", "Any Ship"), true);
      process.env["SATELLITE_ALLOWLIST"] = "Carnival Celebration, 311001223";
      assert.equal(allowlisted("999", "carnival celebration"), true);
      assert.equal(allowlisted("311001223", "Whatever"), true);
      assert.equal(allowlisted("2", "Carnival Spirit"), false);
    } finally { if (prev === undefined) delete process.env["SATELLITE_ALLOWLIST"]; else process.env["SATELLITE_ALLOWLIST"] = prev; }
  });
  it("the sweep is opt-in", () => {
    const prev = process.env["SATELLITE_SWEEP"];
    try {
      delete process.env["SATELLITE_SWEEP"]; assert.equal(sweepEnabled(), false);
      process.env["SATELLITE_SWEEP"] = "on"; assert.equal(sweepEnabled(), true);
    } finally { if (prev === undefined) delete process.env["SATELLITE_SWEEP"]; else process.env["SATELLITE_SWEEP"] = prev; }
  });
});
