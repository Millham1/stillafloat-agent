// itinerary-refresh.test.ts — the CruiseMapper pass runs on the 1st of the month,
// and at boot only when the table is empty or stale (Mark, 2026-09-25).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { nextMonthlyRunAt, bootRefreshNeeded, RUN_HOUR_UTC, sailingsToRead, refsNoLongerListed, tableIsShallow, SOLD_NOT_TRACKED } from "./itinerary-refresh";
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

const listed = (id: string, start: string) => ({ cruiseId: id, start, nights: 7, summary: "7 nights", fromPort: null });

test("every listed sailing is kept; only new, near or old ones have their ports read again", () => {
  const now = at("2026-12-01T09:00:00Z");
  const page = [listed("1", "2026-12-10"), listed("2", "2027-05-02"), listed("3", "2027-11-20"), listed("4", "2028-04-24")];
  assert.equal(sailingsToRead(page, [], now).length, 4, "nothing on file: all four, however far out");
  const onFile = [
    { ref: "cruisemapper:1", start_date: "2026-12-10", updated_at: "2026-11-25T00:00:00Z" },  // near: read again
    { ref: "cruisemapper:2", start_date: "2027-05-02", updated_at: "2026-11-25T00:00:00Z" },  // far and fresh: believed
    { ref: "cruisemapper:3", start_date: "2027-11-20", updated_at: "2026-07-01T00:00:00Z" },  // far and old: read again
  ];
  assert.deepEqual(sailingsToRead(page, onFile, now).map((s) => s.cruiseId), ["1", "3", "4"]);
});

test("a sailing the site stopped listing is removed, but never one in the past or beyond the page", () => {
  const page = [listed("2", "2027-05-02"), listed("3", "2027-11-20")];
  const onFile = [
    { ref: "cruisemapper:0", start_date: "2026-11-01", updated_at: null },  // already sailed: history, kept
    { ref: "cruisemapper:2", start_date: "2027-05-02", updated_at: null },  // still listed
    { ref: "cruisemapper:9", start_date: "2027-06-06", updated_at: null },  // dropped by the site
    { ref: "cruisemapper:8", start_date: "2028-01-15", updated_at: null },  // past the page's last date: unknown, kept
  ];
  assert.deepEqual(refsNoLongerListed(page, onFile, "2026-12-01"), ["cruisemapper:9"]);
  assert.deepEqual(refsNoLongerListed([], onFile, "2026-12-01"), [], "an empty page removes nothing");
});

test("a table that stops within nine months is read in full at boot; a deep one is left alone", () => {
  const now = at("2026-11-27T12:00:00Z");
  assert.equal(tableIsShallow("2027-01-30", now), true, "prod and dev today: the old 90-day capture");
  assert.equal(tableIsShallow(null, now), true);
  assert.equal(tableIsShallow("2028-04-28", now), false, "after one full pass");
});

test("Beachcomber's schedule is read under her own name, by the hull number that never changes", () => {
  const b = SOLD_NOT_TRACKED.find((x) => x.name === "Margaritaville at Sea Beachcomber")!;
  assert.equal(b.imo, "9239783"); assert.equal(b.cruisemapper_id, "723"); assert.equal(b.mmsi, null);
});
