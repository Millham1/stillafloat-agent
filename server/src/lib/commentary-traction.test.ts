// commentary-traction.test.ts — the topic picker's outside-world signals.
//
// Mark, 2026-09-04: "find a topic within the week's approved stories that is
// rating high on youtube or cruise media outlets." These pin the two things that
// decide the week's subject and are pure enough to test without a network: the
// search phrase we derive from a headline, how outlet pickup is counted, and the
// weight renormalisation that keeps a missing API key from skewing every score.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  topicPhrase,
  searchQuery,
  outletPickup,
  combineSignals,
  describeSignals,
} from "./commentary-traction";

// ── the search phrase ────────────────────────────────────────────────────────

test("the phrase drops headline verbs and keeps what identifies the story", () => {
  // "Confirms"/"Extended" are headline filler; the brand and the place are the query.
  assert.equal(
    topicPhrase("Royal Caribbean Confirms Labadee Cancellations Extended Through June 2027"),
    "Royal Caribbean Labadee",
  );
});

test("a brand survives even when it is one of the week's commonest words", () => {
  // Rarity-only ranking deleted "Carnival" and the query returned 8 views where
  // "Carnival Loyalty" returned 290,000. Brands are exempt from the common filter.
  const pool = Array.from({ length: 30 }, (_, i) => ({
    title: `Carnival Cruise Line Update Number ${i}`,
  }));
  pool.push({ title: "The Biggest Shakeup in Carnival's Loyalty History Starts Tomorrow" });
  const phrase = topicPhrase("The Biggest Shakeup in Carnival's Loyalty History Starts Tomorrow", pool);
  assert.ok(phrase.toLowerCase().includes("carnival"), phrase);
});

test("a query is anchored inside cruising or it measures the wrong internet", () => {
  // "Crew Members Arrested" returned a Cyprus ferry disaster and a rapper's crew.
  assert.equal(searchQuery("Crew Members Arrested"), "Crew Members Arrested cruise");
  // Already anchored by a brand — left alone.
  assert.equal(searchQuery("Royal Caribbean Labadee"), "Royal Caribbean Labadee");
  // Already anchored by a generic domain word.
  assert.equal(searchQuery("Greenland Fjords Cruise"), "Greenland Fjords Cruise");
});

test("trailing years and counts never enter the phrase", () => {
  assert.ok(!topicPhrase("Carnival Bans 16 Passengers in 2027").includes("16"));
  assert.ok(!topicPhrase("Carnival Bans 16 Passengers in 2027").includes("2027"));
});

test("an all-lowercase headline still yields a usable phrase", () => {
  assert.equal(topicPhrase("the hot tubs are closed for the rest of the season"), "hot tubs closed");
});

test("stopwords never survive into the phrase", () => {
  assert.ok(!topicPhrase("A Ship In The Caribbean And Beyond").split(" ").includes("The"));
});

// ── outlet pickup ────────────────────────────────────────────────────────────

// A realistic week: the subject cluster plus enough ordinary traffic that word
// frequencies behave the way they do in production (~130 approved stories). A
// four-story fixture would make every word look rare and prove nothing.
const FILLER = Array.from({ length: 26 }, (_, i) => ({
  id: `f${i}`,
  title: `Carnival Cruise Line Announces Update Number ${i} For Guests`,
  source: i % 2 === 0 ? "Cruise Hive" : "Cruise Radio",
}));

const WEEK = [
  { id: "1", title: "Royal Caribbean Extends Labadee Cancellations", source: "Cruise Hive" },
  { id: "2", title: "Labadee Closure Leaves Port Workers Unpaid", source: "Cruise Radio" },
  { id: "3", title: "Labadee Cancellations Ripple Through Haiti", source: "Cruise Industry News" },
  { id: "4", title: "Carnival Loyalty Overhaul Starts Tomorrow", source: "Cruise Hive" },
  ...FILLER,
];

test("distinct outlets on the same subject are what gets counted", () => {
  // Hive (its own) + Radio (shares only "labadee" — but that is rare this week)
  // + Industry News. The single-shared-word story is the point of this test.
  assert.equal(outletPickup(WEEK[0]!, WEEK), 3);
});

test("a rare shared word is enough; a common one is not", () => {
  // "labadee" appears in 3 of 30 stories and carries a match on its own.
  assert.equal(outletPickup(WEEK[1]!, WEEK), 3);
  // "carnival" appears in 27 and carries nothing on its own — the loyalty story
  // stays alone despite sharing a word with half the week.
  assert.equal(outletPickup(WEEK[3]!, WEEK), 1);
});

test("an unrelated story does not inflate pickup", () => {
  assert.equal(outletPickup(WEEK[3]!, WEEK), 1); // loyalty overhaul stands alone
});

test("the same outlet twice on one subject counts once", () => {
  const dupes = [
    WEEK[0]!,
    { id: "9", title: "Labadee Cancellations Extended Again", source: "Cruise Hive" },
  ];
  assert.equal(outletPickup(WEEK[0]!, dupes), 1);
});

test("a single shared COMMON word is a coincidence, not pickup", () => {
  const pool = [
    { id: "a", title: "Carnival Loyalty Overhaul Starts Tomorrow", source: "Cruise Hive" },
    { id: "b", title: "Carnival Ship Misses Australian Port", source: "Cruise Radio" },
    ...FILLER,
  ];
  assert.equal(outletPickup(pool[0]!, pool), 1);
});

test("a story with no outlet recorded is not counted as an outlet", () => {
  const pool = [
    WEEK[0]!,
    { id: "x", title: "Labadee Cancellations Continue", source: "" },
  ];
  assert.equal(outletPickup(WEEK[0]!, pool), 1);
});

// ── combining, and degrading ─────────────────────────────────────────────────

test("a YouTube outage renormalises instead of capping every score", () => {
  // If the missing signal still counted as zero, a maxed-out topic would read as
  // 40/100 and the whole week's ranking would compress toward nothing.
  assert.equal(combineSignals({ youtubeViews: 5_000_000, outletPickup: 5 }), 100);
  assert.equal(combineSignals({ youtubeViews: null, outletPickup: 4 }), 100);
});

test("a dead-quiet topic scores zero rather than throwing", () => {
  assert.equal(combineSignals({ youtubeViews: 0, outletPickup: 1 }), 0);
});

test("more traction always scores higher", () => {
  const quiet = combineSignals({ youtubeViews: 1_000, outletPickup: 1 });
  const loud = combineSignals({ youtubeViews: 400_000, outletPickup: 3 });
  assert.ok(loud > quiet, `${loud} should beat ${quiet}`);
});

test("the score is bounded even on absurd inputs", () => {
  const score = combineSignals({
    youtubeViews: Number.MAX_SAFE_INTEGER,
    outletPickup: 999,
  });
  assert.ok(score <= 100 && score >= 0);
});

// ── the line Mark reads ──────────────────────────────────────────────────────

test("an unmeasurable YouTube signal is stated, not silently omitted", () => {
  // A low score with YouTube missing must not read as "nobody cares" — that and
  // "we could not measure it" lead to opposite editorial calls. Seen for real on
  // dev, which had no YOUTUBE_API_KEY: every topic scored ~0.
  const line = describeSignals({ youtubeViews: null, youtubeVideos: null, outletPickup: 3 });
  assert.match(line, /UNAVAILABLE/);
  assert.match(line, /3 cruise outlets ran it/);
});

test("no recent coverage is reported differently from no measurement", () => {
  const measured = describeSignals({ youtubeViews: 0, youtubeVideos: 0, outletPickup: 2 });
  assert.match(measured, /no recent YouTube coverage/);
  assert.ok(!measured.includes("UNAVAILABLE"), measured);
});

test("the basis line reports real numbers when they exist", () => {
  const line = describeSignals({ youtubeViews: 240_000, youtubeVideos: 8, outletPickup: 2 });
  assert.match(line, /240,000 YouTube views across 8 recent videos/);
  assert.match(line, /2 cruise outlets ran it/);
});
