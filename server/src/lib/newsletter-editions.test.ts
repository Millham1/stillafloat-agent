// newsletter-editions.test.ts — replays 2026-10-16 06:38Z (Spanish sent alone, before English)
// and pins the rule: Spanish follows English, never leads it, and is never sent on its own.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { planWeeklySend, type EditionState } from "./newsletter-editions";

const NOW = Date.parse("2026-10-16T13:00:00Z");
const thisWeek = "2026-10-16T04:55:24Z";
const lastWeek = "2026-10-07T13:03:00Z";
const ed = (status: EditionState["status"], hasStories = true, generatedAt = thisWeek): EditionState => ({ status, hasStories, generatedAt });

test("approving English sends English and a Spanish edition BUILT from it, together", () => {
  const p = planWeeklySend(ed("pending"), ed("pending"), NOW, true);
  assert.equal(p.sendEn, true); assert.equal(p.es, "build-then-send"); assert.equal(p.englishProblem, undefined);
});

test("whatever Spanish preview exists (none, empty, last week's, pending) → rebuilt from the final English", () => {
  for (const es of [null, ed("pending", false), ed("pending", true, lastWeek), ed("pending")]) {
    assert.equal(planWeeklySend(ed("pending"), es, NOW, true).es, "build-then-send");
  }
});

test("nobody on the Spanish list → English only", () => {
  const p = planWeeklySend(ed("pending"), ed("pending"), NOW, false);
  assert.equal(p.sendEn, true); assert.equal(p.es, "skip");
});

test("an empty English issue sends nothing, Spanish included, and names the problem", () => {
  const p = planWeeklySend(ed("pending", false), ed("pending"), NOW, true);
  assert.equal(p.sendEn, false); assert.equal(p.es, "skip"); assert.equal(p.englishProblem, "empty");
});

test("no English issue, or last week's, sends nothing", () => {
  assert.equal(planWeeklySend(null, ed("pending"), NOW, true).englishProblem, "missing");
  assert.equal(planWeeklySend(ed("pending", true, lastWeek), ed("pending"), NOW, true).englishProblem, "stale");
});

test("Friday catch-up: English already went out this week but Spanish did not → Spanish is built and goes", () => {
  const p = planWeeklySend(ed("sent"), ed("pending"), NOW, true);
  assert.equal(p.sendEn, false); assert.equal(p.es, "build-then-send");
});

test("2026-10-16: Spanish already out, English pending → English goes, Spanish is not sent twice", () => {
  const p = planWeeklySend(ed("pending"), ed("sending"), NOW, true);
  assert.equal(p.sendEn, true); assert.equal(p.es, "skip");
});

test("both editions already out → nothing to do", () => {
  const p = planWeeklySend(ed("sent"), ed("sent"), NOW, true);
  assert.equal(p.sendEn, false); assert.equal(p.es, "skip"); assert.equal(p.englishProblem, undefined);
});
