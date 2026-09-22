// active-set.test.ts — who gets one of the ~150 free AIS slots.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REQUEST_HOLD_MS } from "./ship-tracker";

describe("REQUEST_HOLD_MS", () => {
  it("holds a requested ship for exactly one hour", () => {
    assert.equal(REQUEST_HOLD_MS, 60 * 60 * 1000);
  });
  it("is short enough that a 19 kn ship has not gone far", () => {
    const nm = 19 * (REQUEST_HOLD_MS / 3_600_000);
    assert.ok(nm <= 20, `${nm} nm is further than one enquiry's worth of drift`);
  });
});
