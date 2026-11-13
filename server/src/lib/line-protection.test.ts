// line-protection.test.ts — a cruise line's own plan shows its coverages only from a plan document that was read, for the residents it was issued for.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { linePlanCoverage, stateOf } from "./line-protection";

test("Mark 2026-11-13: MSC's own plan carries its Schedule of Benefits as the document GR452 prints it, for North Carolina residents only", () => {
  const c = linePlanCoverage("MSC Cruises", "NC");
  assert.ok(c);
  assert.equal(c.plan, "MSC Cruises Travel Insurance (GR452)");
  const row = (n: string) => c.benefits.find((b) => b.name === n);
  assert.deepEqual(row("Trip Cancellation"), { name: "Trip Cancellation", coverage: "100% of Trip Cost", limits: [] });
  assert.deepEqual(row("Travel Delay"), { name: "Travel Delay", coverage: "$600.00", limits: [{ name: "Daily Limit", value: "$200.00" }, { name: "Per plan", value: "$6,000.00" }] });
  assert.equal(row("Medical and Dental")?.coverage, "$75,000.00");
  assert.equal(row("Emergency Assistance & Transportation")?.coverage, "$75,000.00");
  assert.equal(row("Baggage")?.coverage, "$1,000.00");
  assert.equal(c.benefits.length, 9);
  assert.match(c.source.en, /GR452.*North Carolina.*policy itself governs/);
  // no document read → nothing shown, never a guess
  assert.equal(linePlanCoverage("MSC Cruises", "FL"), null, "another state's copy has not been read");
  assert.equal(linePlanCoverage("Carnival Cruise Line", "NC"), null, "another cruise line's plan has not been read");
  assert.equal(linePlanCoverage(null, "NC"), null);
  assert.equal(linePlanCoverage("msc cruises", " nc "), c);
});

test("the state is read from the city, state and ZIP line", () => {
  assert.equal(stateOf("Fuquay Varina, NC 27526"), "NC");
  assert.equal(stateOf("Miami, fl 33101-1234"), "FL");
  assert.equal(stateOf("somewhere"), null);
  assert.equal(stateOf(null), null);
});
