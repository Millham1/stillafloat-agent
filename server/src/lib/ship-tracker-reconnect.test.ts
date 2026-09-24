// ship-tracker-reconnect.test.ts — a dropped AIS socket backs off; it does not hammer.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { reconnectDelayMs, RECONNECT_BASE_MS, RECONNECT_MAX_MS } from "./ship-tracker";

test("first retry is 30 s, then it doubles, then it holds at 15 minutes", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(reconnectDelayMs), [30_000, 60_000, 120_000, 240_000, 480_000, 900_000]);
  assert.equal(reconnectDelayMs(40), RECONNECT_MAX_MS);
  assert.equal(reconnectDelayMs(-3), RECONNECT_BASE_MS);
});

test("the ceiling fits a 32-bit timer", () => {
  assert.ok(RECONNECT_MAX_MS < 2 ** 31 - 1);
});
