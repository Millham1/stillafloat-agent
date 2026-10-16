// newsletter-freshness.test.ts — replays 2026-10-15: stories written Monday 12:02Z, approved
// Tuesday 03:33Z, draft Wednesday 13:03Z → the old publishedAt-only window dropped them all.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { storyMoment, selectFreshStories, issueHasStories } from "./newsletter-freshness";

const DRAFT_RAN = Date.parse("2026-10-15T13:03:54Z");
const mondayStory = { id: "funpacks", publishedAt: "2026-10-13T12:02:57Z", approvedAt: "2026-10-14T03:33:20Z" };

test("the moment a story counts from is the later of written and approved", () => {
  assert.equal(storyMoment(mondayStory), Date.parse("2026-10-14T03:33:20Z"));
  assert.equal(storyMoment({ publishedAt: "2026-10-13T12:02:57Z" }), Date.parse("2026-10-13T12:02:57Z"));
  assert.ok(Number.isNaN(storyMoment({})));
  assert.ok(Number.isNaN(storyMoment({ publishedAt: "not a date", approvedAt: null })));
});

test("2026-10-15: the stories Mark approved Tuesday are in Wednesday's 48-hour window", () => {
  // Written 49 h before the draft (would have missed), approved 33.5 h before (counts).
  assert.deepEqual(selectFreshStories([mondayStory], DRAFT_RAN, 48).map((s) => s.id), ["funpacks"]);
});

test("48 hours still means 48 hours — a story written and approved three days earlier stays out", () => {
  const stale = { id: "old-storm", publishedAt: "2026-10-12T09:00:00Z", approvedAt: "2026-10-12T10:00:00Z" };
  assert.deepEqual(selectFreshStories([stale, mondayStory], DRAFT_RAN, 48).map((s) => s.id), ["funpacks"]);
});

test("a story with no usable timestamp is stale, never grandfathered", () => {
  assert.deepEqual(selectFreshStories([{ id: "undated" }, { id: "blank", publishedAt: "", approvedAt: "" }], DRAFT_RAN, 48), []);
});

test("an issue with no stories is not sendable", () => {
  assert.equal(issueHasStories({ storyIds: [] }), false);
  assert.equal(issueHasStories(null), false);
  assert.equal(issueHasStories({}), false);
  assert.equal(issueHasStories({ storyIds: ["funpacks"] }), true);
});
