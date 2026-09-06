import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeStats, appendSnapshot, STATS_CAP } from "./social-stats";

describe("social stats", () => {
  it("summarises first vs latest followers per platform, in time order", () => {
    const s = summarizeStats([
      { at: "2026-09-08T00:00:00Z", facebook: { followers: 120 }, instagram: { followers: 9 } },
      { at: "2026-09-06T00:00:00Z", facebook: { followers: 100 }, instagram: { followers: 4 } },
      { at: "2026-09-07T00:00:00Z", facebook: { followers: "n/a" } },
    ]);
    assert.equal(s.snapshots, 3);
    assert.equal(s.firstAt, "2026-09-06T00:00:00Z");
    assert.equal(s.latestAt, "2026-09-08T00:00:00Z");
    assert.deepEqual(s.followers["facebook"], { first: 100, latest: 120, delta: 20 });
    assert.deepEqual(s.followers["instagram"], { first: 4, latest: 9, delta: 5 });
  });
  it("empty series is all nulls, not a crash", () => {
    const s = summarizeStats([]);
    assert.equal(s.snapshots, 0);
    assert.deepEqual(s.followers["instagram"], { first: null, latest: null, delta: null });
  });
  it("append stamps `at` and caps the series", () => {
    let items = appendSnapshot([], { facebook: { followers: 1 } }, "2026-09-06T00:00:00Z");
    assert.equal(items[0]!.at, "2026-09-06T00:00:00Z");
    for (let i = 0; i < STATS_CAP + 5; i++) items = appendSnapshot(items, { i }, `t${i}`);
    assert.equal(items.length, STATS_CAP);
  });
});
