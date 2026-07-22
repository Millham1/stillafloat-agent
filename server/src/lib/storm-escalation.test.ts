// storm-escalation.test.ts — the invest→named-storm upgrade must always alert.
// Regression tests for the 2026-07 Bertha/Fausto misses (task 3c349235).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { planScanAction, severityRank, type ExistingAlertState } from "./storm-escalation";

function sentRow(overrides: Partial<ExistingAlertState> = {}): ExistingAlertState {
  return {
    status: "sent",
    classification: "Tropical Depression",
    name: "Two",
    content_hash: "old-hash",
    ...overrides,
  };
}

test("severityRank orders the ladder", () => {
  assert.equal(severityRank("Disturbance"), 0);
  assert.equal(severityRank("Potential Tropical Cyclone"), 1);
  assert.equal(severityRank("Tropical Depression"), 2);
  assert.equal(severityRank("Subtropical Depression"), 2);
  assert.equal(severityRank("Tropical Storm"), 3);
  assert.equal(severityRank("Subtropical Storm"), 3);
  assert.equal(severityRank("Hurricane"), 4);
  assert.equal(severityRank("Major Hurricane"), 5);
  assert.equal(severityRank(null), 0);
});

test("THE BERTHA CASE: TD 'Two' (already sent) upgrades to TS 'Bertha' → escalate", () => {
  const action = planScanAction(sentRow(), { classification: "Tropical Storm", name: "Bertha" }, "new-hash");
  assert.deepEqual(action, { kind: "escalate", from: "Tropical Depression", to: "Tropical Storm" });
});

test("THE FAUSTO CASE: TS (sent) upgrades to Hurricane → escalate", () => {
  const action = planScanAction(
    sentRow({ classification: "Tropical Storm", name: "Fausto" }),
    { classification: "Hurricane", name: "Fausto" },
    "new-hash",
  );
  assert.equal(action.kind, "escalate");
});

test("a DISMISSED precursor still escalates on upgrade — alert regardless of prior outcome", () => {
  const action = planScanAction(
    sentRow({ status: "dismissed" }),
    { classification: "Hurricane", name: "Bertha" },
    "new-hash",
  );
  assert.equal(action.kind, "escalate");
});

test("new named storm with no prior row → insert (precursor invest alerted or not is irrelevant)", () => {
  const action = planScanAction(null, { classification: "Tropical Storm", name: "Bertha" }, "h");
  assert.deepEqual(action, { kind: "insert" });
});

test("rename at storm strength escalates even without a rank change", () => {
  const action = planScanAction(
    sentRow({ classification: "Tropical Storm", name: "Two" }),
    { classification: "Tropical Storm", name: "Bertha" },
    "new-hash",
  );
  assert.equal(action.kind, "escalate");
});

test("unchanged content hash → touch (no notification)", () => {
  const action = planScanAction(sentRow({ content_hash: "same" }), { classification: "Tropical Depression", name: "Two" }, "same");
  assert.deepEqual(action, { kind: "touch" });
});

test("intensity wiggle on a sent row (same classification) stays silent → refresh", () => {
  const action = planScanAction(
    sentRow({ classification: "Tropical Storm", name: "Bertha" }),
    { classification: "Tropical Storm", name: "Bertha" },
    "new-hash",
  );
  assert.deepEqual(action, { kind: "refresh" });
});

test("material change on a live draft → redraft", () => {
  const action = planScanAction(
    sentRow({ status: "draft", classification: "Tropical Storm", name: "Bertha" }),
    { classification: "Tropical Storm", name: "Bertha" },
    "new-hash",
  );
  assert.deepEqual(action, { kind: "redraft" });
});

test("a regenerated storm revives its ended alert via escalation, even on an identical hash", () => {
  const action = planScanAction(
    sentRow({ status: "ended", classification: "Tropical Storm", name: "Bertha", content_hash: "same" }),
    { classification: "Tropical Storm", name: "Bertha" },
    "same",
  );
  assert.equal(action.kind, "escalate");
});

test("downgrade (Hurricane → TS) on a sent row does NOT escalate → refresh", () => {
  const action = planScanAction(
    sentRow({ classification: "Hurricane", name: "Bertha" }),
    { classification: "Tropical Storm", name: "Bertha" },
    "new-hash",
  );
  assert.deepEqual(action, { kind: "refresh" });
});
