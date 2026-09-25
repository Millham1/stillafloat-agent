// itinerary-refresh.test.ts — the CruiseMapper pass runs on the 1st of the month,
// and at boot only when the table is empty or stale (Mark, 2026-09-25).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { nextMonthlyRunAt, bootRefreshNeeded, RUN_HOUR_UTC } from "./itinerary-refresh";
import { MAX_TIMER_MS } from "./brief-error";

const at = (s: string) => new Date(s);

test("the next run is the 1st of next month at the run hour", () => {
  assert.equal(nextMonthlyRunAt(at("2026-09-25T15:00:00Z")).toISOString(), "2026-10-01T09:00:00.000Z");
  assert.equal(nextMonthlyRunAt(at("2026-12-15T00:00:00Z")).toISOString(), "2027-01-01T09:00:00.000Z");
  assert.equal(RUN_HOUR_UTC, 9);
});

test("before the run hour on the 1st it is still this month; at the run hour it has moved on", () => {
  assert.equal(nextMonthlyRunAt(at("2026-10-01T08:59:59Z")).toISOString(), "2026-10-01T09:00:00.000Z");
  assert.equal(nextMonthlyRunAt(at("2026-10-01T09:00:00Z")).toISOString(), "2026-11-01T09:00:00.000Z");
});

test("a month is longer than one Node timer — the chained `after` has to carry it", () => {
  const t0 = at("2026-10-01T09:00:00Z");
  assert.ok(nextMonthlyRunAt(t0).getTime() - t0.getTime() > MAX_TIMER_MS);
});

test("boot runs only for an empty or stale table", () => {
  const now = at("2026-09-25T16:00:00Z");
  assert.equal(bootRefreshNeeded(null, now), true);
  assert.equal(bootRefreshNeeded("2026-09-24T20:57:50Z", now), false);  // prod's newest row today
  assert.equal(bootRefreshNeeded("2026-08-20T00:00:00Z", now), true);   // 36 days
  assert.equal(bootRefreshNeeded("not a date", now), true);
});
