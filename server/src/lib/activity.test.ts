// activity.test.ts — the no-push record keys by Mark's local day, so "today" on the brief
// means his today, and entries normalise to a bounded, well-typed row.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { localDay, activityKey, normalizeActivity } from "./activity";

test("localDay follows Mark's zone, not UTC", () => {
  // 01:16 UTC on Oct 23 is still Oct 22 in New York.
  assert.equal(localDay(new Date("2026-10-23T01:16:50Z"), "America/New_York"), "2026-10-22");
  assert.equal(localDay(new Date("2026-10-23T01:16:50Z"), "UTC"), "2026-10-23");
});

test("keys sort by day then time, so a prefix match lists one day in order", () => {
  const a = activityKey("2026-10-22T11:04:00.000Z", "aaaa");
  const b = activityKey("2026-10-22T16:04:00.000Z", "aaaa");
  assert.ok(a.startsWith("activity:2026-10-22:"));
  assert.ok(a < b);
  assert.ok(activityKey("2026-10-21T23:59:00.000Z", "zzzz") < "activity:2026-10-22");
});

test("normalizeActivity bounds and defaults every field", () => {
  const row = normalizeActivity({ source: "  ops ", title: "x".repeat(300), body: "  b  ", level: "fault", at: "not a date" });
  assert.equal(row.source, "ops");
  assert.equal(row.title.length, 200);
  assert.equal(row.body, "b");
  assert.equal(row.level, "fault");
  assert.equal(row.pushed, false);
  assert.ok(!Number.isNaN(Date.parse(row.at)));
  assert.equal(normalizeActivity({ source: "", title: "", level: "info" as const }).source, "backend");
});
