// planned-sweep-core.test.ts — the rules that keep operator itineraries correct
// on the Cruise API Pro plan (2026-09-13). Each test is a way the stored plan
// could go wrong: a partial read removing real sailings, the archive
// outranking the live feed, or the refresh overspending the plan.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CRUISE_API_PAGE_SIZE, LIVE_SOURCE, UNKNOWN_SHIP_PAGES,
  sweepShip, refsToRemove, preferLiveSailings, searchAllowance, pagesToHold,
} from "./planned-sweep-core";

type S = { ref: string };
const pageOf = (n: number, total: number, pages: number) => ({
  sailings: Array.from({ length: CRUISE_API_PAGE_SIZE }, (_, i) => ({ ref: `p${n}-${i}` })),
  totalResults: total,
  totalPages: pages,
});

describe("sweepShip", () => {
  it("reads every page and reports complete, with the real page count", async () => {
    const asked: number[] = [];
    const r = await sweepShip<S>(async (p) => { asked.push(p); return pageOf(p, 166, 17); }, Number.POSITIVE_INFINITY);
    assert.deepEqual(asked, Array.from({ length: 17 }, (_, i) => i + 1));
    assert.equal(r.complete, true);
    assert.equal(r.pagesUsed, 17);
    assert.equal(r.totalPages, 17);
    assert.equal(r.sailings.length, 170);
  });
  it("a failed page mid-sweep is not complete, and keeps what it read", async () => {
    const r = await sweepShip<S>(async (p) => (p === 4 ? null : pageOf(p, 60, 6)), Number.POSITIVE_INFINITY);
    assert.equal(r.complete, false);
    assert.equal(r.pagesUsed, 4);
    assert.equal(r.sailings.length, 30);
    assert.equal(r.totalPages, 6, "the next run still knows how much budget to hold");
  });
  it("a listing that changes while we read is not complete", async () => {
    // A sailing removed before our page shifts the rest forward, so one would be
    // skipped; removing 'unseen' sailings after that read would delete a real one.
    const r = await sweepShip<S>(async (p) => pageOf(p, p < 3 ? 50 : 49, 5), Number.POSITIVE_INFINITY);
    assert.equal(r.complete, false);
  });
  it("the first page failing reports nothing known", async () => {
    const r = await sweepShip<S>(async () => null, Number.POSITIVE_INFINITY);
    assert.equal(r.complete, false);
    assert.equal(r.totalResults, null);
    assert.equal(r.totalPages, null);
  });
  it("a ship with no sailings is a complete, empty sweep", async () => {
    const r = await sweepShip<S>(async () => ({ sailings: [], totalResults: 0, totalPages: 0 }), Number.POSITIVE_INFINITY);
    assert.equal(r.complete, true);
    assert.equal(r.sailings.length, 0);
  });
  it("stops at maxPages and does not call that complete", async () => {
    const r = await sweepShip<S>(async (p) => pageOf(p, 250, 25), 20);
    assert.equal(r.pagesUsed, 20);
    assert.equal(r.complete, false);
    assert.equal(r.totalPages, 25);
  });
});

describe("refsToRemove", () => {
  const window = { from: "2026-08-29", to: "2028-09-12" };
  const stored = [
    { ref: "kept", startDate: "2026-10-01" },
    { ref: "cancelled", startDate: "2026-11-01" },
    { ref: "before-window", startDate: "2026-08-01" },
    { ref: "after-window", startDate: "2029-01-01" },
  ];
  it("removes only sailings in the swept window the operator no longer lists", () => {
    assert.deepEqual(refsToRemove(stored, new Set(["kept"]), window, true), ["cancelled"]);
  });
  it("removes nothing after an incomplete sweep", () => {
    assert.deepEqual(refsToRemove(stored, new Set(["kept"]), window, false), []);
  });
  it("an empty sweep never wipes a ship's stored plan", () => {
    assert.deepEqual(refsToRemove(stored, new Set(), window, true), []);
  });
});

describe("preferLiveSailings", () => {
  const row = (source: string, startDate: string) => ({ source, startDate, ref: `${source}:${startDate}` });
  it("the live feed outranks the archive inside the dates it covers", () => {
    const rows = [
      row("widgety-archive", "2026-09-14"),
      row(LIVE_SOURCE, "2026-09-14"),
      row(LIVE_SOURCE, "2027-06-01"),
      row("widgety-archive", "2027-01-10"),
    ];
    const kept = preferLiveSailings(rows).map((r) => r.ref);
    assert.deepEqual(kept.sort(), [`${LIVE_SOURCE}:2026-09-14`, `${LIVE_SOURCE}:2027-06-01`].sort());
  });
  it("archive sailings beyond the live feed's reach still stand", () => {
    const rows = [row(LIVE_SOURCE, "2026-09-14"), row(LIVE_SOURCE, "2026-12-01"), row("widgety-archive", "2028-03-01")];
    assert.ok(preferLiveSailings(rows).some((r) => r.ref === "widgety-archive:2028-03-01"));
  });
  it("with no live rows, everything stands", () => {
    const rows = [row("widgety-archive", "2026-09-14"), row("widgety-archive", "2027-01-10")];
    assert.equal(preferLiveSailings(rows).length, 2);
  });
});

describe("searchAllowance", () => {
  it("keeps a 5% reserve of the plan untouched", () => {
    assert.equal(searchAllowance({ remaining: 4000, limit: 4000 }), 3800);
    assert.equal(searchAllowance({ remaining: 200, limit: 4000 }), 0);
    assert.equal(searchAllowance({ remaining: 150, limit: 4000 }), 0, "never negative");
  });
  it("a small plan still keeps at least five", () => {
    assert.equal(searchAllowance({ remaining: 50, limit: 50 }), 45);
    assert.equal(searchAllowance({ remaining: 5, limit: 50 }), 0);
  });
  it("before any response is seen, it does not block", () => {
    assert.equal(searchAllowance({ remaining: null, limit: null }), Number.POSITIVE_INFINITY);
  });
});

describe("pagesToHold", () => {
  it("holds one more page than last time, or a safe default for a new ship", () => {
    assert.equal(pagesToHold(17), 18);
    assert.equal(pagesToHold(undefined), UNKNOWN_SHIP_PAGES);
    assert.equal(pagesToHold(0), UNKNOWN_SHIP_PAGES);
  });
});
