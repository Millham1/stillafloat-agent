// commentary-agent.test.ts — the one-peg-story rule and the fact-check repair gate.
//
// Mark, 2026-08-22: "The commentary being generated isn't commentary. It is just
// repeating news stories." Prod carried FOUR unrelated stories in a single post
// (Greenland fjords, Boston crew arrests, an MSC redeployment, CDC scores). No
// proposition spans those, so the writer summarised each in turn. These tests pin
// the invariant that caused it.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { autonomousWriterPayload, acceptRepair } from "./commentary-agent";

const STORIES = [
  { title: "Greenland Urges Cruise Ships to Avoid Certain Fjords", link: "a", source: "Fox" },
  { title: "11 Crew Members Arrested in Boston", link: "b", source: "CruiseHive" },
  { title: "MSC World Europa Pulled From Middle East", link: "c", source: "CruiseHive" },
  { title: "Worst CDC Sanitation Scores Revealed", link: "d", source: "FoxNews" },
] as never[];

const TAKE = {
  peg_story_title: "11 Crew Members Arrested in Boston",
  question: "q", position: "p", whos_wrong: "w",
  what_should_change: "c", sharpest_line: "s",
};

// ── the one-peg-story rule ───────────────────────────────────────────────────

test("exactly one story is the subject; the rest are evidence only", () => {
  const out = autonomousWriterPayload({ stories: STORIES, research: [] as never[] }, TAKE);

  assert.equal((out["peg_story"] as { title: string }).title, TAKE.peg_story_title);
  assert.equal((out["other_stories_as_evidence_only"] as unknown[]).length, 3);
});

test("the writer is never handed a story cluster", () => {
  const out = autonomousWriterPayload({ stories: STORIES, research: [] as never[] }, TAKE);

  // the shape that produced the bug: a plural list with no designated subject
  assert.equal(out["featured_stories"], undefined);
  assert.equal(out["stories"], undefined);
});

test("the peg is never also listed as its own evidence", () => {
  const out = autonomousWriterPayload({ stories: STORIES, research: [] as never[] }, TAKE);
  const others = out["other_stories_as_evidence_only"] as { title: string }[];

  assert.ok(!others.some((s) => s.title === TAKE.peg_story_title));
});

test("an unrecognised peg title falls back to the first story, still singular", () => {
  const out = autonomousWriterPayload(
    { stories: STORIES, research: [] as never[] },
    { ...TAKE, peg_story_title: "a headline that is not in the cluster" },
  );

  assert.equal((out["peg_story"] as { title: string }).title, STORIES[0]!["title"]);
  // the fallback must not leave the peg duplicated in the evidence list
  assert.equal((out["other_stories_as_evidence_only"] as unknown[]).length, 3);
});

test("a single-story cluster leaves no evidence list", () => {
  const out = autonomousWriterPayload(
    { stories: [STORIES[0]!], research: [] as never[] },
    { ...TAKE, peg_story_title: STORIES[0]!["title"] },
  );

  assert.equal((out["other_stories_as_evidence_only"] as unknown[]).length, 0);
});

// ── the fact-check repair gate ───────────────────────────────────────────────

test("a gutted repair is rejected", () => {
  const original = "<p>" + "word ".repeat(200) + "</p>";
  assert.equal(acceptRepair(original, "<p>tiny</p>"), false);
});

test("a repair that dropped its markup is rejected", () => {
  const original = "<p>" + "word ".repeat(50) + "</p>";
  assert.equal(acceptRepair(original, "word ".repeat(60)), false);
});

test("a genuine repair of comparable length is accepted", () => {
  const original = "<p>" + "word ".repeat(100) + "</p>";
  const fixed = "<p>" + "word ".repeat(98) + "</p>";
  assert.equal(acceptRepair(original, fixed), true);
});
