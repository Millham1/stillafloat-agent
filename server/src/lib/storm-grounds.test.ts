// storm-grounds.test.ts — where a storm IS decides which cruisers hear about it.
// Hurricane Nolo, 2026-09-25: ep152026 in bin CP2, 15.5N 155.6W, 240 mi south of
// South Point with Hawaii County under a watch — and the alert said Mexican Riviera.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { groundsForPoint, groundsForBasin } from "./storm-grounds";
import { basinFor } from "./storm-source";

test("a storm south of the Big Island is Hawaii's, not the Mexican Riviera's", () => {
  assert.deepEqual(groundsForPoint(15.5, -155.6), ["hawaii"]);   // Nolo, advisory 19
  assert.deepEqual(groundsForPoint(15.8, -155.6), ["hawaii"]);   // Nolo, advisory 19a
  assert.deepEqual(groundsForPoint(16.4, -160.5), ["hawaii"]);   // Nolo's day-3 forecast point
});

test("the Mexican Riviera box is untouched", () => {
  assert.deepEqual(groundsForPoint(22.9, -109.9), ["mexican_riviera"]); // Cabo San Lucas
  assert.deepEqual(groundsForPoint(20.6, -105.2), ["mexican_riviera"]); // Puerto Vallarta
});

test("open ocean between the two is nobody's grounds (the basin fallback decides)", () => {
  assert.deepEqual(groundsForPoint(15, -130), []);
  assert.deepEqual(groundsForBasin("central_pacific"), ["hawaii"]);
  assert.deepEqual(groundsForBasin("eastern_pacific"), ["mexican_riviera"]);
});

test("the bin a storm is filed under beats the basin its id was born in", () => {
  assert.equal(basinFor("ep152026", "CP2"), "central_pacific"); // Nolo after crossing 140W
  assert.equal(basinFor("ep152026", "EP1"), "eastern_pacific");
  assert.equal(basinFor("al062026", "AT1"), "atlantic");
  assert.equal(basinFor("ep152026", null), "eastern_pacific");  // no bin → id prefix
  assert.equal(basinFor("cp012026", undefined), "central_pacific");
  assert.equal(basinFor("", null), "atlantic");
});
