import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isStale, staleDays, STALE_DAYS_DEFAULT, decideOutcome } from "./social-schedule";

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

describe("social poster outcome per publish result", () => {
  const now = Date.parse("2026-09-06T12:00:00Z");
  const fresh = new Date(now - DAY).toISOString();
  const old = new Date(now - 8 * DAY).toISOString();
  it("ok → posted", () => {
    assert.deepEqual(decideOutcome({ ok: true, reason: "posted" }, fresh, now, 7), { kind: "posted" });
  });
  it("retry reasons stay scheduled while fresh, become skipped:stale after the window", () => {
    for (const reason of ["ig-no-clip", "ig-not-configured", "fb-not-configured"]) {
      assert.deepEqual(decideOutcome({ ok: false, reason }, fresh, now, 7), { kind: "retry" });
      assert.deepEqual(decideOutcome({ ok: false, reason }, old, now, 7), { kind: "skipped", error: `stale:${reason}` });
    }
  });
  it("language off and manual-only surfaces are skipped immediately, tagged with the reason", () => {
    assert.deepEqual(decideOutcome({ ok: false, reason: "ig-lang-off" }, fresh, now, 7), { kind: "skipped", error: "ig-lang-off" });
    assert.deepEqual(decideOutcome({ ok: false, reason: "personal-manual" }, old, now, 7), { kind: "skipped", error: "personal-manual" });
  });
  it("anything else is a hard failure carrying the reason", () => {
    assert.deepEqual(decideOutcome({ ok: false, reason: "HTTP 500" }, fresh, now, 7), { kind: "failed", error: "HTTP 500" });
    assert.deepEqual(decideOutcome({ ok: false, reason: "fetch failed" }, old, now, 7), { kind: "failed", error: "fetch failed" });
  });
});
