import test from "node:test";
import assert from "node:assert/strict";
import { hourlyLimiter } from "./hourly-limit";

test("a key may call up to the limit each hour; the next call is refused, another key is not, and the hour resets it", () => {
  let t = 0;
  const limited = hourlyLimiter(3, () => t);
  assert.deepEqual([1, 2, 3, 4].map(() => limited("a")), [false, false, false, true]);
  assert.equal(limited("b"), false);
  t += 60 * 60 * 1000 + 1;
  assert.equal(limited("a"), false);
});
