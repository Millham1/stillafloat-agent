// ship-tracker-boot.test.ts — a failed registry load at boot is retried, not final.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { registryRetryDelayMs, REGISTRY_RETRY_MS } from "./ship-tracker";

test("registry retries back off 30s → 1m → 2m → 5m and then hold at 5m", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(registryRetryDelayMs), [30_000, 60_000, 120_000, 300_000, 300_000, 300_000]);
  assert.equal(registryRetryDelayMs(-1), REGISTRY_RETRY_MS[0]);
});

test("every retry delay fits a 32-bit timer (the 2026-09-23 overflow class)", () => {
  for (const ms of REGISTRY_RETRY_MS) assert.ok(ms < 2 ** 31 - 1);
});
