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

// ── A positioned storm is judged by where it is, never by its basin (2026-09-26) ──
import { NAMED_STORM_MARGIN_DEG } from "./storm-grounds";
import { groundsFor } from "./storm-agent";

test("a named storm outside every box, even with the approach margin, threatens nowhere", () => {
  assert.deepEqual(groundsFor({ lat: 16.4, lon: -22.5, basin: "atlantic" }), []);   // Gonzalo, 35 mi off Cabo Verde
  assert.deepEqual(groundsFor({ lat: 29.8, lon: -43.0, basin: "atlantic" }), []);   // Fay, mid-Atlantic, 20° from Bermuda
});

test("a storm within the approach margin of a box is that region's business", () => {
  assert.equal(NAMED_STORM_MARGIN_DEG, 10);
  assert.deepEqual(groundsFor({ lat: 18.3, lon: -123.6, basin: "eastern_pacific" }), ["mexican_riviera"]); // Odalys, 8.6° west of the box
  assert.deepEqual(groundsFor({ lat: 17.2, lon: -109.2, basin: "eastern_pacific" }), ["mexican_riviera"]); // Polo, inside
  assert.deepEqual(groundsFor({ lat: 16.8, lon: -155.4, basin: "central_pacific" }), ["hawaii"]);         // Nolo
  assert.deepEqual(groundsForPoint(15, -48.1, NAMED_STORM_MARGIN_DEG), ["e_caribbean"]);                  // 9.9° east of the box
  assert.deepEqual(groundsForPoint(15, -47.9, NAMED_STORM_MARGIN_DEG), []);                               // 10.1° east: not yet
});

test("only an outlook disturbance, which has no coordinates, falls back to its basin", () => {
  assert.deepEqual(groundsFor({ lat: null, lon: null, basin: "atlantic" }),
    ["e_caribbean", "w_caribbean", "bahamas", "gulf", "bermuda", "us_east_coast"]);
  assert.deepEqual(groundsFor({ lat: null, lon: null, basin: "central_pacific" }), ["hawaii"]);
});
