import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scorecardView, statusLine } from "./search-scorecard";

const first = {
  at: "2026-11-15T15:00:00+00:00", periodDays: 28, impressions: 125, clicks: 3,
  keyPagesInGoogle: 40, keyPagesChecked: 59, recentStoriesFetched: 0, recentStoriesChecked: 24,
};

describe("search-scorecard: the dashboard's four tiles", () => {
  it("says the worker has not run instead of drawing zeros", () => {
    for (const state of [null, undefined, {}, { history: [] }]) {
      const v = scorecardView(state);
      assert.equal(v.ready, false);
      assert.deepEqual(v.tiles, []);
      assert.match(v.status, /has not run yet/);
    }
  });

  it("draws the first reading with both numbers on the 'of' tiles and no claim about change", () => {
    const v = scorecardView({ history: [first], synopsis: ["Google showed the site 125 times.", " "] });
    assert.equal(v.ready, true);
    assert.deepEqual(v.tiles.map((t) => [t.key, t.label, t.value, t.change]), [
      ["impressions", "Times shown in Google, last 28 days", "125", "First reading"],
      ["clicks", "Clicks from Google, last 28 days", "3", "First reading"],
      ["keyPages", "Hub and guide pages Google holds", "40 of 59", "First reading"],
      ["stories", "Newest story pages Google has fetched", "0 of 24", "First reading"],
    ]);
    assert.deepEqual(v.synopsis, ["Google showed the site 125 times."]);
    assert.equal(v.measuredAt, first.at);
    assert.equal(v.previousAt, null);
  });

  it("shows how each number moved since the last run", () => {
    const next = { ...first, at: "2026-11-18T15:00:00+00:00", impressions: 140, clicks: 3, keyPagesInGoogle: 38, recentStoriesFetched: 6 };
    const v = scorecardView({ history: [first, next] });
    assert.deepEqual(v.tiles.map((t) => [t.value, t.change, t.direction]), [
      ["140", "+15 since the last run", "up"],
      ["3", "No change since the last run", "same"],
      ["38 of 59", "−2 since the last run", "down"],
      ["6 of 24", "+6 since the last run", "up"],
    ]);
    assert.equal(v.previousAt, first.at);
    assert.equal(v.history.length, 2);
  });

  it("a number that could not be measured reads 'Not measured', never 0", () => {
    const blind = { at: "2026-11-18T15:00:00+00:00", periodDays: 28, impressions: null, clicks: null,
      keyPagesInGoogle: 41, keyPagesChecked: null, recentStoriesFetched: null, recentStoriesChecked: null };
    const v = scorecardView({ history: [first, blind] });
    assert.deepEqual(v.tiles.map((t) => [t.value, t.change]), [
      ["Not measured", ""], ["Not measured", ""], ["Not measured", ""], ["Not measured", ""],
    ]);
    const back = scorecardView({ history: [first, blind, { ...first, at: "2026-11-21T15:00:00+00:00" }] });
    assert.equal(back.tiles[0]!.change, "Not measured last run");
    assert.equal(back.tiles[2]!.change, "−1 since the last run");
  });

  it("says in one line what is waiting and what was cleaned", () => {
    assert.equal(
      statusLine({ batchId: "b1", batchItems: 5, closedDead: 3, closedDuplicates: 0, openAfter: 34, failed: [] }),
      "A batch of 5 change(s) is waiting for your OK below. 3 stale task(s) were closed. 34 task(s) are on the search list.",
    );
    assert.equal(
      statusLine({ batchId: null, waitingBatchId: "b0", openAfter: 24, failed: [] }),
      "An earlier batch is still waiting for your OK below; no new one was filed. 24 task(s) are on the search list.",
    );
    assert.equal(statusLine({ batchId: null, failed: ["sorting"], openAfter: 10 }),
      "The last run could not finish: sorting. 10 task(s) are on the search list.");
    assert.equal(statusLine({ batchId: null, failed: [] }), "No batch was filed this run.");
    assert.equal(statusLine(undefined), "");
  });

  it("keeps at most the last 20 readings for the page", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...first, at: `r${i}`, impressions: i }));
    const v = scorecardView({ history: many });
    assert.equal(v.history.length, 20);
    assert.equal(v.history[0]!.at, "r10");
    assert.equal(v.tiles[0]!.value, "29");
  });
});
