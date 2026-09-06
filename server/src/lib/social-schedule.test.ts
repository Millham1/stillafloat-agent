import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isStale, staleDays, STALE_DAYS_DEFAULT } from "./social-schedule";

const DAY = 86_400_000;

describe("social poster stale rule", () => {
  it("defaults to 7 days; env overrides only with a positive number", () => {
    assert.equal(staleDays(undefined), STALE_DAYS_DEFAULT);
    assert.equal(staleDays("3"), 3);
    assert.equal(staleDays("0"), STALE_DAYS_DEFAULT);
    assert.equal(staleDays("nope"), STALE_DAYS_DEFAULT);
  });
  it("an item past due longer than the window is stale; a fresh one is not", () => {
    const now = Date.parse("2026-09-06T12:00:00Z");
    assert.equal(isStale(new Date(now - 8 * DAY).toISOString(), now, 7), true);
    assert.equal(isStale(new Date(now - 6 * DAY).toISOString(), now, 7), false);
    assert.equal(isStale(new Date(now + DAY).toISOString(), now, 7), false);
    assert.equal(isStale(undefined, now, 7), false);
    assert.equal(isStale("garbage", now, 7), false);
  });
});
