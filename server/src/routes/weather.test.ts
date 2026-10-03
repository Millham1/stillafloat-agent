// weather.test.ts — coordinate visits to /api/weather resolve to a known port when one is close
// (so Bermuda-by-coords shares Bermuda-by-slug's synopsis cache), else to an ad-hoc location.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveCoords } from "./weather";

test("coords near a known port snap to it", () => {
  const loc = resolveCoords("32.33022", "-64.74003", "Bermuda");
  assert.equal(loc?.slug, "bermuda");
  assert.equal(loc?.name, "Bermuda");
});

test("coords with no port nearby become an ad-hoc destination with a sanitized name", () => {
  const loc = resolveCoords(48.8566, 2.3522, "Paris <script>alert(1)</script>");
  assert.equal(loc?.slug, "ll:48.86,2.35");
  assert.equal(loc?.type, "destination");
  assert.equal(loc?.name, "Paris scriptalert(1)script");
});

test("a missing name falls back to the coordinates", () => {
  assert.equal(resolveCoords(10, 10, "")?.name, "10.00, 10.00");
});

test("garbage or out-of-range coordinates are rejected", () => {
  assert.equal(resolveCoords("x", "1", "a"), null);
  assert.equal(resolveCoords(91, 0, "a"), null);
  assert.equal(resolveCoords(0, 181, "a"), null);
});
