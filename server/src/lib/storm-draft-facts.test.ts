// storm-draft-facts.test.ts — what the alert writer is handed, end to end: units and labels
// from the NHC feed (storm-source) and the computed distance facts (storm-agent.draftFacts).
import test from "node:test";
import assert from "node:assert/strict";
import { classify, movementText, type RawSystem } from "./storm-source";
import { draftFacts, STORM_DRAFT_PROMPT } from "./storm-agent";

test("NHC movement is a compass word, the degrees, and MPH — never knots", () => {
  assert.equal(movementText(300, 5), "west-northwest (300°) at 5 mph");   // Rachel, advisory 28
  assert.equal(movementText(275, 20), "west (275°) at 20 mph");           // Nolo, advisory 54
  assert.equal(movementText(0, 12), "north (0°) at 12 mph");              // 0° is a real heading
  assert.equal(movementText(90, 0), "stationary");
  assert.equal(movementText(null, 5), null);
});

test("PTC is post-tropical; PC is the potential cyclone", () => {
  assert.equal(classify("PTC"), "Post-Tropical Cyclone");
  assert.equal(classify("PC"), "Potential Tropical Cyclone");
  assert.equal(classify("HU"), "Hurricane");
  assert.equal(classify("STD"), "Subtropical Depression");
});

const hanna: RawSystem = {
  nhcId: "al082026", basin: "atlantic", name: "Hanna", classification: "Tropical Storm",
  lat: 36.6, lon: -50.4, intensity: "40 kt", movement: movementText(100, 17), movementDeg: 100,
  formationChance: null, advisoryUrl: null, coneUrl: null, source: "current_storms", raw: {},
};

test("the fact sheet carries wind in mph, the direction word, and a distance line per ground", () => {
  const facts = draftFacts(hanna, ["canada_new_england"]);
  assert.match(facts, /Intensity: maximum sustained winds 40 kt \(about 45 mph\)/);
  assert.match(facts, /Movement: east \(100°\) at 17 mph/);
  assert.match(facts, /Distance — Canada & New England: the centre is about [\d,]+ miles \S+ of .+moving AWAY from it right now\./);
});

test("a disturbance with no position gets no distance line", () => {
  const facts = draftFacts({ ...hanna, lat: null, lon: null, movement: null, movementDeg: null, classification: "Disturbance" }, ["bahamas"]);
  assert.doesNotMatch(facts, /Distance —/);
});

test("the prompt forbids forecasting and model-side geometry", () => {
  assert.match(STORM_DRAFT_PROMPT, /Do NOT forecast/);
  assert.match(STORM_DRAFT_PROMPT, /Never convert degrees yourself/);
  assert.match(STORM_DRAFT_PROMPT, /"Bottom line" fact is the verdict/);
});
