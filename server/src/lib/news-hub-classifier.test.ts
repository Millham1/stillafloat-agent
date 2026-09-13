// news-hub-classifier.test.ts — the agent decides the ambiguous ones, once.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { triage, buildClassifyPrompt, storiesByAssignment, classifyStories } from "./news-hub-classifier";
import { hubBySlug } from "./news-hubs";

const carnival = hubBySlug("carnival")!;
const royal = hubBySlug("royal-caribbean")!;
const s = (id: string, title: string, summary = "") => ({ id, title, summary, approvedAt: "2026-09-10T12:00:00Z" });

describe("triage", () => {
  const stories = [
    s("a", "Carnival Raises Its Gratuity Rates Again"),
    s("b", "Royal Caribbean Cancels Serenade of the Seas Alaska Cruise"),
    s("c", "Port Canaveral Tops Off Massive 13-Story Cruise Parking Garage", "Serves Carnival and Royal Caribbean terminals."),
    s("d", "Disney Magic's Very Merrytime Cruise Gains a Cozumel Stop"),
    s("e", "Carnival Cancels a Sailing, Royal Caribbean Picks Up the Guests"),
  ];
  it("a headline naming exactly one line is settled without a model call", () => {
    const t = triage(stories);
    assert.deepEqual(t.settled.get("a"), ["carnival"]);
    assert.deepEqual(t.settled.get("b"), ["royal-caribbean"]);
    // Every operator has a hub, so "Disney Magic" resolves to Disney rather than
    // being an ambiguity to spend a call on — the collision it used to cause on
    // the Carnival hub is gone at the same time.
    assert.deepEqual(t.settled.get("d"), ["disney"]);
  });
  it("no line named, or two named, goes to the agent", () => {
    const t = triage(stories);
    assert.deepEqual(t.ambiguous.map((x) => x.id).sort(), ["c", "e"]);
  });
  it("a story decided before is never asked about again", () => {
    const t = triage(stories, { c: ["carnival", "royal-caribbean"], e: [] });
    assert.deepEqual(t.ambiguous.map((x) => x.id), []);
    assert.deepEqual(t.settled.get("e"), [], "an empty verdict is still a verdict");
  });
});

describe("the prompt", () => {
  it("offers the slugs and states the collisions that caused real mistakes", () => {
    const p = buildClassifyPrompt([s("d", "Disney Magic's Very Merrytime Cruise Gains a Cozumel Stop")]);
    assert.match(p, /carnival = Carnival Cruise Line/);
    assert.match(p, /royal-caribbean = Royal Caribbean International/);
    assert.match(p, /Disney Magic/);
  });
});

describe("storiesByAssignment", () => {
  const stories = [
    s("a", "Carnival Raises Its Gratuity Rates Again"),
    s("b", "Royal Caribbean Cancels Serenade of the Seas Alaska Cruise"),
    s("c", "Port Canaveral Tops Off Massive Parking Garage", "Serves Carnival and Royal Caribbean."),
    s("d", "Disney Magic's Very Merrytime Cruise Gains a Cozumel Stop"),
  ];
  const assignments = { a: ["carnival"], b: ["royal-caribbean"], c: ["carnival", "royal-caribbean"], d: [] };
  it("puts each story only where the verdict says", () => {
    assert.deepEqual(storiesByAssignment(stories, carnival, assignments).map((x) => x.id), ["a", "c"]);
    assert.deepEqual(storiesByAssignment(stories, royal, assignments).map((x) => x.id), ["b", "c"]);
  });
  it("an empty verdict keeps a story off every hub", () => {
    for (const hub of [carnival, royal]) {
      assert.ok(!storiesByAssignment(stories, hub, assignments).some((x) => x.id === "d"), "Disney Magic stays off");
    }
  });
  it("a story with no verdict yet falls back to the pattern rather than vanishing", () => {
    const got = storiesByAssignment(stories, carnival, { b: ["royal-caribbean"] });
    assert.ok(got.some((x) => x.id === "a"), "unjudged Carnival story still appears");
  });
  it("newest first", () => {
    const dated = [s("x", "Carnival One"), { ...s("y", "Carnival Two"), approvedAt: "2026-09-11T12:00:00Z" }];
    assert.deepEqual(storiesByAssignment(dated, carnival, { x: ["carnival"], y: ["carnival"] }).map((d) => d.id), ["y", "x"]);
  });
});

describe("classifyStories without a model", () => {
  it("falls back to the patterns and says so, rather than emptying the hubs", async () => {
    const r = await classifyStories([s("a", "Carnival Raises Its Gratuity Rates Again"), s("c", "Port Canaveral Garage Opens", "Serves Carnival.")], {}, { enabled: false });
    assert.equal(r.provider, "patterns");
    assert.equal(r.llmCalls, 0);
    assert.deepEqual(r.assignments["a"], ["carnival"]);
    assert.deepEqual(r.assignments["c"], ["carnival"], "pattern fallback still classifies it");
  });
});
