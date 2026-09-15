import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compactCandidates, bookable, projectCost, CostLedger, estimateTokens } from "./advice-prompt.mjs";

const grid = [
  { id: "5100", deck: 5, kind: "Oceanview", view: "ocean", realOcean: true, steady: true, hump: false, obstructedFlag: false },
  { id: "5102", deck: 5, kind: "Oceanview", view: "ocean", realOcean: true, steady: true, hump: false, obstructedFlag: false },
  { id: "5104", deck: 5, kind: "Oceanview", view: "ocean", realOcean: true, steady: false, hump: false, obstructedFlag: false },
  { id: "12501", deck: 12, kind: "Studio", view: null, realOcean: null, steady: true, hump: false, obstructedFlag: false },
  { id: "12192", deck: 12, kind: "Balcony", view: "ocean", realOcean: true, steady: true, hump: false, obstructedFlag: false, note: "hump" },
];

describe("compactCandidates", () => {
  it("keeps every bookable cabin number and merges rooms that share every attribute", () => {
    const { rows, dropped, kept } = compactCandidates(grid, { motionAsked: true, party: "solo" });
    const all = rows.flatMap((r) => r.cabins);
    assert.deepEqual(all.sort(), ["12192", "12501", "5100", "5102", "5104"]);
    assert.deepEqual(dropped, []);
    assert.equal(kept, 5);
    const ov = rows.find((r) => r.cabins.includes("5100"));
    assert.deepEqual(ov.cabins, ["5100", "5102"], "5104 differs on steady, so it is its own row");
    assert.equal(rows.length, 4);
  });
  it("a couple never sees a Studio, and the removal is reported", () => {
    const { rows, dropped } = compactCandidates(grid, { motionAsked: true, party: "two" });
    assert.deepEqual(dropped, ["12501"]);
    assert.ok(!rows.some((r) => r.kind === "Studio"));
  });
  it("a traveler who never raised motion is not shown steadiness, and same-otherwise rooms merge", () => {
    const { rows } = compactCandidates(grid, { motionAsked: false, party: "two" });
    const ov = rows.find((r) => r.kind === "Oceanview");
    assert.equal("steady" in ov, false);
    assert.deepEqual(ov.cabins, ["5100", "5102", "5104"]);
  });
  it("is byte-stable across runs (cacheable prefix)", () => {
    const a = JSON.stringify(compactCandidates(grid, { party: "solo" }).rows);
    const b = JSON.stringify(compactCandidates([...grid], { party: "solo" }).rows);
    assert.equal(a, b);
  });
  it("shrinks a real-sized grid by an order of magnitude", () => {
    const big = Array.from({ length: 1949 }, (_, i) => ({ id: String(5000 + i), deck: 5 + (i % 10), kind: ["Balcony", "Inside", "Oceanview"][i % 3], view: "ocean", realOcean: true, steady: i % 7 === 0, hump: false, obstructedFlag: false }));
    const before = estimateTokens(JSON.stringify(big));
    const after = estimateTokens(JSON.stringify(compactCandidates(big, { party: "two" }).rows));
    assert.ok(after * 5 < before, `expected a big drop, got ${before} -> ${after}`);
  });
});

describe("bookable", () => {
  it("only solos can book a Studio", () => {
    assert.equal(bookable({ kind: "Studio" }, "solo"), true);
    assert.equal(bookable({ kind: "Studio" }, "sologroup"), true);
    assert.equal(bookable({ kind: "Studio" }, "family"), false);
    assert.equal(bookable({ kind: "Inside" }, "family"), true);
  });
});

describe("cost", () => {
  it("projects a range from one attempt to the worst case", () => {
    const c = projectCost({ promptTokens: 10_000, systemTokens: 2_000, outputTokens: 1_000, calls: 12, attempts: 3, model: "claude-haiku-4-5" });
    assert.ok(Math.abs(c.perCall - 0.017) < 1e-9);
    assert.ok(Math.abs(c.min - 0.204) < 1e-9);
    assert.ok(Math.abs(c.max - 0.612) < 1e-9);
  });
  it("the ledger counts rejected and failed attempts, not just the last one", () => {
    const l = new CostLedger();
    l.add({ input_tokens: 100_000, output_tokens: 1_000 }, "claude-haiku-4-5-20251001", false);
    l.add({ input_tokens: 100_000, output_tokens: 1_000 }, "claude-haiku-4-5-20251001", true);
    const s = l.summary();
    assert.equal(s.calls, 2); assert.equal(s.failed, 1);
    assert.equal(s.usd, 0.21);
  });
});
