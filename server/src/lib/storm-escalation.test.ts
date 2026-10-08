// storm-escalation.test.ts — the invest→named-storm upgrade must always alert.
// Regression tests for the 2026-07 Bertha/Fausto misses (task 3c349235).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { planScanAction, severityRank, scanHashKey, publicTextRefresh, type ExistingAlertState } from "./storm-escalation";

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

// ── Public text refresh (Mark 2026-10-07, option one) ───────────────────────
// Isaias, prod 2026-10-07: approved/sent at 35 kt "300 miles west of Progreso";
// by 00Z NHC had her at 55 kt, 22.8N 92.4W. Same class, so "refresh" — and the
// public text never moved.
const ISAIAS_AM = { nhcId: "al092026", classification: "Tropical Storm", intensity: "35 kt", formationChance: null, lat: 22.6, lon: -94.1 };
const ISAIAS_PM = { ...ISAIAS_AM, intensity: "55 kt", lat: 22.8, lon: -92.4 };
const GOOD = { headline: "Tropical Storm Isaias strengthens in the Gulf", body_md: "Isaias has 55 kt winds..." };

test("hash key: stronger winds or a ~1 degree move is a material change; a wobble is not", () => {
  const g = ["gulf", "w_caribbean"];
  assert.notEqual(scanHashKey(ISAIAS_AM, g), scanHashKey(ISAIAS_PM, g));
  assert.notEqual(scanHashKey(ISAIAS_AM, g), scanHashKey({ ...ISAIAS_AM, lon: -93.0 }, g), "moved ~1 degree east");
  assert.equal(scanHashKey(ISAIAS_AM, g), scanHashKey({ ...ISAIAS_AM, lat: 22.7, lon: -94.2 }, g), "a 0.1 degree wobble");
  assert.equal(scanHashKey(ISAIAS_AM, g), scanHashKey(ISAIAS_AM, ["w_caribbean", "gulf"]), "grounds order does not matter");
});

test("Isaias: a refresh on a SENT alert re-writes the public text (status untouched)", () => {
  const action = planScanAction(sentRow({ classification: "Tropical Storm", name: "Isaias" }), { classification: "Tropical Storm", name: "Isaias" }, "new-hash");
  assert.deepEqual(action, { kind: "refresh" });
  assert.deepEqual(publicTextRefresh(action, "sent", { ...GOOD, problems: [] }), GOOD);
  assert.deepEqual(publicTextRefresh(action, "approved", GOOD), GOOD);
});

test("public text is never refreshed on a dismissed row, or from a non-refresh action", () => {
  assert.equal(publicTextRefresh({ kind: "refresh" }, "dismissed", GOOD), null);
  assert.equal(publicTextRefresh({ kind: "redraft" }, "sent", GOOD), null);
  assert.equal(publicTextRefresh({ kind: "escalate", from: "Tropical Storm", to: "Hurricane" }, "sent", GOOD), null);
});

test("a draft that still fails its fact check, the no-AI placeholder, or an empty draft never replaces approved text", () => {
  assert.equal(publicTextRefresh({ kind: "refresh" }, "sent", { ...GOOD, problems: ["says 'approaching' Cozumel"] }), null);
  assert.equal(publicTextRefresh({ kind: "refresh" }, "sent", { ...GOOD, fallback: true }), null);
  assert.equal(publicTextRefresh({ kind: "refresh" }, "sent", { headline: "x", body_md: "  " }), null);
  assert.equal(publicTextRefresh({ kind: "refresh" }, "sent", null), null);
});
