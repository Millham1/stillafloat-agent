import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { devNewsFeederEnabled, pickStoriesToFeed, MIN_FRESH } from "./dev-news-feeder";

const NOW = Date.parse("2026-10-22T13:00:00Z"); // a Thursday 09:00 Eastern draft
const HOUR = 3_600_000;
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();
const cand = (id: string, over: Record<string, unknown> = {}) => ({ id, status: "candidate", title_es: `Título ${id}`, summary_es: `Resumen de ${id}`, ...over });
const appr = (id: string, approvedHoursAgo: number) => ({ id, approvedAt: iso(approvedHoursAgo), publishedAt: iso(approvedHoursAgo + 20) });

describe("dev news feeder switch (dev mirror only)", () => {
  it("is off unless DEV_NEWS_FEEDER=1", () => {
    assert.equal(devNewsFeederEnabled({ PUBLIC_URL: "http://178.156.154.144" }), false);
    assert.equal(devNewsFeederEnabled({ DEV_NEWS_FEEDER: "0", PUBLIC_URL: "http://178.156.154.144" }), false);
  });
  it("is on for the dev box address", () => {
    assert.equal(devNewsFeederEnabled({ DEV_NEWS_FEEDER: "1", PUBLIC_URL: "http://178.156.154.144" }), true);
  });
  it("refuses the production site, with or without www or a path, and an unknown address", () => {
    for (const url of ["https://stillafloatcruising.com", "https://www.stillafloatcruising.com/", "http://stillafloatcruising.com:443", "", undefined]) {
      assert.equal(devNewsFeederEnabled({ DEV_NEWS_FEEDER: "1", PUBLIC_URL: url }), false, String(url));
    }
  });
});

describe("which candidates get approved", () => {
  it("does nothing while three approved stories are still inside the 48-hour window", () => {
    const approved = [appr("a", 1), appr("b", 30), appr("c", 47)];
    assert.deepEqual(pickStoriesToFeed([cand("x"), cand("y")], approved, NOW, 48), []);
  });
  it("tops the pool back up to three, in the queue's own order, when stories have aged out", () => {
    // the 2026-10-22 failure: every approved story was older than the window, so the draft had none
    const approved = [appr("old1", 49), appr("old2", 100), appr("old3", 200)];
    assert.deepEqual(pickStoriesToFeed([cand("x"), cand("y"), cand("z"), cand("w")], approved, NOW, 48), ["x", "y", "z"]);
    assert.deepEqual(pickStoriesToFeed([cand("x"), cand("y")], [appr("a", 2), ...approved], NOW, 48), ["x", "y"]);
    assert.equal(MIN_FRESH, 3);
  });
  it("skips candidates with no Spanish twin, decided ones, and stories already approved", () => {
    const candidates = [
      cand("no-es", { title_es: "" }),
      cand("no-es-summary", { summary_es: undefined }),
      cand("rejected", { status: "rejected" }),
      cand("held", { status: "held" }),
      cand("old1"), // already in the approved list (aged out, but a re-approval would duplicate it)
      cand("good"),
      cand("good", {}), // listed twice in the queue
      cand("also-good"),
      cand("", {}),
    ];
    assert.deepEqual(pickStoriesToFeed(candidates, [appr("old1", 300)], NOW, 48), ["good", "also-good"]);
  });
  it("treats a candidate with no status field as undecided (older scans wrote none)", () => {
    assert.deepEqual(pickStoriesToFeed([cand("x", { status: undefined })], [], NOW, 48), ["x"]);
  });
  it("counts freshness as the newsletter does: the later of written and approved", () => {
    // approved 10 h ago but written 60 h ago → fresh (the approval is the judgement that it is news now)
    const approved = [{ id: "a", approvedAt: iso(10), publishedAt: iso(60) }, { id: "b", approvedAt: iso(10), publishedAt: iso(60) }, { id: "c", approvedAt: iso(10), publishedAt: iso(60) }];
    assert.deepEqual(pickStoriesToFeed([cand("x")], approved, NOW, 48), []);
    // an approved story with no readable date is stale, never grandfathered
    assert.deepEqual(pickStoriesToFeed([cand("x")], [{ id: "a" }, { id: "b" }, { id: "c" }], NOW, 48), ["x"]);
  });
});
