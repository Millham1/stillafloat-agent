// storm-intel.test.ts — cross-storm attribution of ship-named intel
// (2026-09-24: a Hurricane Polo article was filed under Nolo and Odalys).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { newsItemNamesAnotherStorm, newsItemMatchesShip, usableAdvisoryNote, windowLooksLikeAdvisory } from "./storm-intel";

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

// ── 2026-09-25: the model saying "I cannot find an advisory" is not an advisory ──
// Six real notes that reached the public Fay page and the Gonzalo draft.
const JUNK = [
  "I cannot find a specific storm advisory statement about Tropical Storm Fay affecting Royal Caribbean's Utopia of the Seas in the provided excerpt. The text appears to be navigation menu content rather than an actual advisory.",
  "I don't see a storm advisory or specific operational notice in the excerpt provided—it appears to be navigation menu content from Royal Caribbean's website rather than an actual advisory about Storm Fay and Wonder of the Seas.",
  "I cannot extract a specific storm advisory from the provided excerpt, as it only contains Royal Caribbean's website navigation menu and marketing content.",
  "I don't see any storm advisory content in the text provided. The excerpt contains navigation menus and general cruise information for Star of the Seas.",
  "I don't have access to the actual storm advisory details for Royal Caribbean's Utopia of the Seas regarding Hurricane Gonzalo. The text provided appears to be navigation menu content from their website rather than the advisory.",
  "I appreciate you reaching out, but the excerpt you've provided appears to be navigation menu content from Royal Caribbean's website rather than an actual storm advisory for Utopia of the Seas regarding Hurricane Gonzalo.",
];

test("a summary that admits it found nothing never reaches the card", () => {
  for (const j of JUNK) assert.equal(usableAdvisoryNote(j, ["Fay", "Gonzalo", "Utopia of the Seas"]), false, j.slice(0, 40));
});

test("a real one-sentence advisory passes, with or without the storm's name", () => {
  assert.equal(usableAdvisoryNote(
    "Royal Caribbean says Navigator of the Seas will call at Cabo San Lucas instead of Ensenada as Hurricane Polo tracks north.",
    ["Polo", "Navigator of the Seas"]), true);
  assert.equal(usableAdvisoryNote(
    "Sailings departing Port Canaveral on September 26 will leave four hours late because of weather.", ["Fay"]), true);
  assert.equal(usableAdvisoryNote("Carnival has not announced any itinerary changes for Fay yet.", ["Fay"]), true);
});

test("too short or off-topic is not intel either", () => {
  assert.equal(usableAdvisoryNote("Book now.", ["Fay"]), false);
  assert.equal(usableAdvisoryNote("Explore our newest ships and destinations for 2027 with great deals today.", ["Fay"]), false);
});

test("a navigation menu around a ship's name is not worth a model call", () => {
  assert.equal(windowLooksLikeAdvisory(
    "Ships Icon of the Seas Star of the Seas Utopia of the Seas Wonder of the Seas Deals Destinations Book Now Sign In"), false);
  assert.equal(windowLooksLikeAdvisory(
    "Tropical Storm Fay: Utopia of the Seas will depart Port Canaveral at 8 PM instead of 4 PM on September 26."), true);
  assert.equal(windowLooksLikeAdvisory("Due to weather, the September 27 sailing has been modified."), true);
});
