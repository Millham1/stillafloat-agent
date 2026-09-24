// storm-intel.test.ts — cross-storm attribution of ship-named intel
// (2026-09-24: a Hurricane Polo article was filed under Nolo and Odalys).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { newsItemNamesAnotherStorm, newsItemMatchesShip } from "./storm-intel";

const KNOWN = ["Nolo", "Odalys", "Polo", "Fay"];
const poloPiece = {
  title: "Royal Caribbean Cruise Ship Forced to Adjust Itinerary to Avoid Major Hurricane",
  description: "Navigator of the Seas swapped Ensenada and Cabo San Lucas as Hurricane Polo churns off Mexico's Pacific coast.",
};

test("a ship article that names another storm is attributed to that storm, not the one being scanned", () => {
  assert.equal(newsItemMatchesShip(poloPiece, "Navigator of the Seas"), true); // ship match still fires…
  assert.equal(newsItemNamesAnotherStorm(poloPiece, "Nolo", KNOWN), "Polo");   // …but it is Polo's
  assert.equal(newsItemNamesAnotherStorm(poloPiece, "Odalys", KNOWN), "Polo");
});

test("an article naming the scanned storm stays with it, even if it also names another", () => {
  const both = { title: "Nolo and Polo reshuffle the Mexican Riviera", description: "Navigator of the Seas re-routed." };
  assert.equal(newsItemNamesAnotherStorm(both, "Nolo", KNOWN), null);
  assert.equal(newsItemNamesAnotherStorm(poloPiece, "Polo", KNOWN), null);
});

test("an article naming no storm is kept for the ship (operators seldom name the storm)", () => {
  const unnamed = { title: "Navigator of the Seas skips Cabo", description: "Weather-related itinerary change announced by Royal Caribbean." };
  assert.equal(newsItemNamesAnotherStorm(unnamed, "Nolo", KNOWN), null);
});

test("storm names match whole words only — Apollo is not Polo, Fayetteville is not Fay", () => {
  const apollo = { title: "Apollo Lounge reopens on Navigator of the Seas", description: "storm-damaged deck repaired" };
  assert.equal(newsItemNamesAnotherStorm(apollo, "Nolo", KNOWN), null);
  const fayette = { title: "Navigator of the Seas guest from Fayetteville rerouted by storm", description: "" };
  assert.equal(newsItemNamesAnotherStorm(fayette, "Nolo", KNOWN), null);
  assert.equal(newsItemNamesAnotherStorm({ title: "Tropical Storm Fay", description: "" }, "Nolo", KNOWN), "Fay");
});
