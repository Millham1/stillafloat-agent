// position-provider.test.ts — the spend gate for paid position lookups.
// Fixtures are the real MSC Meraviglia case (2026-09-22): our tracker held a
// 13 July fix while Live-AIS had one from three minutes earlier.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  lookupDecision, blankLedger, allowlisted, perShipWindowMin,
  LOOKUP_AFTER_MIN, REQUEST_GUARD_MIN, STANDING_WINDOW_MIN,
} from "./position-provider";


describe("lookupDecision — nothing is bought without a reason", () => {
  const now = new Date("2026-09-22T15:40:00Z");
  const base = { ledger: blankLedger(now), mmsi: "249973000", cap: 2000, cost: 1, now };

  it("refuses when the free feed is fresh", () => {
    const r = lookupDecision({ ...base, lastFixAt: "2026-09-22T15:35:00Z", reason: "request" });
    assert.deepEqual(r, { ok: false, why: "fresh" });
  });
  it("allows a request for a ship silent since July", () => {
    const r = lookupDecision({ ...base, lastFixAt: "2026-07-13T11:45:10Z", reason: "request" });
    assert.deepEqual(r, { ok: true });
  });
  it("allows a lookup for a ship we have never heard from", () => {
    assert.deepEqual(lookupDecision({ ...base, lastFixAt: null, reason: "request" }), { ok: true });
  });
  it("guards against the same ship being clicked twice", () => {
    const ledger = { ...blankLedger(now), lastByMmsi: { "249973000": "2026-09-22T15:38:00Z" } };
    const r = lookupDecision({ ...base, ledger, lastFixAt: null, reason: "request" });
    assert.deepEqual(r, { ok: false, why: "recent-lookup" });
  });
  it("holds storm/watch to the six-hour cadence, not the click guard", () => {
    assert.equal(perShipWindowMin("request"), REQUEST_GUARD_MIN);
    assert.equal(perShipWindowMin("storm"), STANDING_WINDOW_MIN);
    assert.equal(perShipWindowMin("watch"), STANDING_WINDOW_MIN);
    const ledger = { ...blankLedger(now), lastByMmsi: { "249973000": "2026-09-22T13:00:00Z" } };
    assert.deepEqual(lookupDecision({ ...base, ledger, lastFixAt: null, reason: "storm" }), { ok: false, why: "recent-lookup" });
  });
  it("caps on the PRICE of the call, not on one credit", () => {
    const ledger = { ...blankLedger(now), used: 1995 };
    assert.deepEqual(lookupDecision({ ...base, ledger, cost: 1, lastFixAt: null, reason: "request" }), { ok: true });
    assert.deepEqual(lookupDecision({ ...base, ledger, cost: 15, lastFixAt: null, reason: "request" }),
      { ok: false, why: "cap" }, "a 15-credit track must not slip through a 1-credit check");
  });
  it("starts a new month with a fresh budget", () => {
    const ledger = { month: "2026-08", used: 99999, lastByMmsi: {}, lastError: null };
    assert.deepEqual(lookupDecision({ ...base, ledger, lastFixAt: null, reason: "request" }), { ok: true });
  });
  it("respects LOOKUP_AFTER_MIN exactly at the boundary", () => {
    const at = new Date(now.getTime() - LOOKUP_AFTER_MIN * 60_000).toISOString();
    assert.deepEqual(lookupDecision({ ...base, lastFixAt: at, reason: "request" }), { ok: true });
  });
});

describe("allowlist", () => {
  it("lets every ship through when unset", () => {
    assert.equal(allowlisted("249973000", "MSC Meraviglia", undefined), true);
  });
  it("matches on name or MMSI, case-insensitively", () => {
    const raw = "MSC Meraviglia,311050900";
    assert.equal(allowlisted("249973000", "msc meraviglia", raw), true);
    assert.equal(allowlisted("311050900", "Norwegian Getaway", raw), true);
    assert.equal(allowlisted("000000000", "Some Other Ship", raw), false);
  });
  it("survives the quotes pm2 leaves on the value", () => {
    assert.equal(allowlisted("249973000", "MSC Meraviglia", '"MSC Meraviglia,Norwegian Getaway"'), true);
  });
});

// ── staleForInquiry: Mark's rule — inquiry answers from the free feed, stale → buy once ──
import { staleForInquiry } from "./position-provider";

it("no fix at all is stale — the first inquiry buys", () => {
  assert.equal(staleForInquiry(null), true);
  assert.equal(staleForInquiry(undefined), true);
  assert.equal(staleForInquiry("not a date"), true);
});

it("a fix inside the freshness bar is not stale — no spend", () => {
  const now = new Date("2026-09-24T04:00:00Z");
  const fresh = new Date(now.getTime() - (LOOKUP_AFTER_MIN - 1) * 60_000).toISOString();
  assert.equal(staleForInquiry(fresh, now), false);
});

it("a fix older than the freshness bar is stale — buy once", () => {
  const now = new Date("2026-09-24T04:00:00Z");
  const old = new Date(now.getTime() - (LOOKUP_AFTER_MIN + 1) * 60_000).toISOString();
  assert.equal(staleForInquiry(old, now), true);
});
