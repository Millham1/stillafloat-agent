// planned-itinerary.test.ts — the real 2026-09 rows, including the two sources
// that disagree about the same Norwegian Getaway sailing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { slugsOf, covers, mergeItineraries, type PlannedRow } from "./planned-itinerary";

const row = (source: string, start: string, end: string | null, slugs: (string | null)[]): PlannedRow => ({
  ship_name: "Norwegian Getaway", source, start_date: start, end_date: end,
  ports: slugs.map((s) => ({ name: s ?? "?", slug: s })),
});

// Verbatim from planned_sailings on dev: the SAME 18 Sep sailing, opposite order.
const WIDGETY = row("widgety-archive", "2026-09-18", "2026-09-21", ["miami", "great-stirrup", "nassau", "miami"]);
const RAPIDAPI = row("rapidapi-cruise", "2026-09-18", "2026-09-21", ["miami", "nassau", "great-stirrup", "miami"]);

describe("slugsOf", () => {
  it("keeps order and drops ports we could not resolve", () => {
    assert.deepEqual(slugsOf(WIDGETY), ["miami", "great-stirrup", "nassau", "miami"]);
    assert.deepEqual(slugsOf(row("x", "2026-09-18", null, ["miami", null, "nassau"])), ["miami", "nassau"]);
  });
  it("survives a row with no ports at all", () => {
    assert.deepEqual(slugsOf({ ...WIDGETY, ports: null }), []);
  });
});

describe("covers", () => {
  it("includes both endpoints", () => {
    assert.equal(covers(WIDGETY, "2026-09-18"), true);
    assert.equal(covers(WIDGETY, "2026-09-21"), true);
    assert.equal(covers(WIDGETY, "2026-09-22"), false);
    assert.equal(covers(WIDGETY, "2026-09-17"), false);
  });
  it("treats an open-ended sailing as still running", () => {
    assert.equal(covers(row("x", "2026-09-18", null, ["miami"]), "2026-12-01"), true);
  });
});

describe("mergeItineraries — sources disagree about order, and that is fine", () => {
  it("unions the ports so a disagreement cannot become a headline", () => {
    const m = mergeItineraries([WIDGETY, RAPIDAPI]);
    assert.deepEqual(m.ports.sort(), ["great-stirrup", "miami", "nassau"]);
    assert.deepEqual(m.sources.sort(), ["rapidapi-cruise", "widgety-archive"]);
  });
  it("covers BOTH ports the detector called diversions on 21 Sep", () => {
    const m = mergeItineraries([WIDGETY, RAPIDAPI]);
    assert.ok(m.ports.includes("great-stirrup"), "flagged as a port she never calls at");
    assert.ok(m.ports.includes("nassau"), "flagged as a mid-leg re-route");
  });
  it("keeps the longest single ordering, for recording a swap only", () => {
    const m = mergeItineraries([row("a", "2026-09-18", null, ["miami", "nassau"]), WIDGETY]);
    assert.equal(m.order.length, 4);
  });
  it("returns nothing when no row carries a resolved port", () => {
    const m = mergeItineraries([{ ...WIDGETY, ports: [] }]);
    assert.deepEqual(m.ports, []);
  });
});
