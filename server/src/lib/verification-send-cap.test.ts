// verification-send-cap.test.ts — the site-wide ceiling on confirmation emails (2026-10-02).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createSendCap, verificationSendCap, DEFAULT_VERIFICATION_SENDS_PER_HOUR } from "./verification-send-cap";

test("the cap the server runs with is 10 confirmation emails per rolling hour", () => {
  assert.equal(DEFAULT_VERIFICATION_SENDS_PER_HOUR, 10);
  assert.equal(verificationSendCap.limit, 10);
  assert.equal(verificationSendCap.windowMs, 60 * 60 * 1000);
});

test("ten sends fit in an hour, the eleventh is refused, and each slot frees one hour after it was used", () => {
  let t = 0;
  const cap = createSendCap({ limit: 10, now: () => t });
  for (let i = 0; i < 10; i++) {
    t = i * 60_000; // one a minute
    assert.equal(cap.tryReserve(), true, `send ${i + 1}`);
  }
  t = 30 * 60_000;
  assert.equal(cap.tryReserve(), false, "the 11th inside the hour is refused");
  assert.equal(cap.count(), 10, "a refusal uses no slot");
  t = 60 * 60_000 + 1; // just past an hour after the first send
  assert.equal(cap.tryReserve(), true, "the first slot has rolled off");
  assert.equal(cap.tryReserve(), false, "only one had rolled off");
});

test("release gives back a slot whose send never happened", () => {
  const cap = createSendCap({ limit: 1, now: () => 0 });
  assert.equal(cap.tryReserve(), true);
  assert.equal(cap.tryReserve(), false);
  cap.release();
  assert.equal(cap.count(), 0);
  assert.equal(cap.tryReserve(), true);
});
