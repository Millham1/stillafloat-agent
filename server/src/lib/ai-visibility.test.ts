// ai-visibility.test.ts — the agent's activity log behind the dashboard's AI
// Visibility page (2026-09-29). Pure helpers only: what a POST may contain,
// what the server stamps, and the newest-first 500-entry cap.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVITY_CAP, ACTIVITY_KINDS, TITLE_MAX, DETAIL_MAX,
  prependActivity, validateActivity, type ActivityEntry,
} from "./ai-visibility";

const NOW = new Date("2026-09-29T15:00:00.000Z");

function entry(i: number): ActivityEntry {
  return { at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`, kind: "note", title: `entry ${i}`, detail: "", status: "done" };
}

describe("validateActivity", () => {
  it("stamps the server's clock and defaults status to done", () => {
    const r = validateActivity({ kind: "llms", title: "  Rebuilt llms.txt  ", at: "1999-01-01T00:00:00Z" }, NOW);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.entry, { at: NOW.toISOString(), kind: "llms", title: "Rebuilt llms.txt", detail: "", status: "done" });
  });

  it("keeps detail, status and a link", () => {
    const r = validateActivity({
      kind: "schema", title: "Person markup on Work with Mark", detail: "EN + ES", status: "waiting-on-mark",
      link: "https://stillafloatcruising.com/work-with-mark.html",
    }, NOW);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.entry.status, "waiting-on-mark");
    assert.equal(r.entry.detail, "EN + ES");
    assert.equal(r.entry.link, "https://stillafloatcruising.com/work-with-mark.html");
  });

  it("accepts every documented kind", () => {
    for (const kind of ACTIVITY_KINDS) assert.ok(validateActivity({ kind, title: "t" }, NOW).ok, kind);
  });

  it("accepts a site path as the link; an empty link is simply absent", () => {
    const a = validateActivity({ kind: "page", title: "t", link: "/news/carnival.html" }, NOW);
    assert.ok(a.ok && a.entry.link === "/news/carnival.html");
    const b = validateActivity({ kind: "page", title: "t", link: "" }, NOW);
    assert.ok(b.ok && !("link" in b.entry));
  });

  const bad: [string, unknown][] = [
    ["no body", undefined],
    ["an array", [{ kind: "note", title: "t" }]],
    ["an unknown kind", { kind: "tweet", title: "t" }],
    ["a missing title", { kind: "note" }],
    ["a blank title", { kind: "note", title: "   " }],
    ["a title over the limit", { kind: "note", title: "x".repeat(TITLE_MAX + 1) }],
    ["detail that is not text", { kind: "note", title: "t", detail: 5 }],
    ["detail over the limit", { kind: "note", title: "t", detail: "x".repeat(DETAIL_MAX + 1) }],
    ["an unknown status", { kind: "note", title: "t", status: "finished" }],
    ["a javascript: link", { kind: "note", title: "t", link: "javascript:alert(1)" }],
    ["a protocol-relative link", { kind: "note", title: "t", link: "//evil.example/x" }],
    ["a link that is not a URL", { kind: "note", title: "t", link: "see the doc" }],
  ];
  for (const [what, body] of bad) {
    it(`rejects ${what}`, () => {
      const r = validateActivity(body, NOW);
      assert.equal(r.ok, false);
      if (!r.ok) assert.ok(r.error.length > 0);
    });
  }
});

describe("prependActivity", () => {
  it("puts the new entry first", () => {
    const out = prependActivity([entry(1), entry(2)], entry(3));
    assert.deepEqual(out.map((e) => e.title), ["entry 3", "entry 1", "entry 2"]);
  });

  it("starts a list when none is stored, or the stored value is not a list", () => {
    assert.deepEqual(prependActivity(undefined, entry(1)), [entry(1)]);
    assert.deepEqual(prependActivity({ oops: true }, entry(1)), [entry(1)]);
  });

  it(`keeps the newest ${ACTIVITY_CAP} and drops the oldest`, () => {
    const full = Array.from({ length: ACTIVITY_CAP }, (_, i) => entry(i));
    const out = prependActivity(full, entry(9999));
    assert.equal(out.length, ACTIVITY_CAP);
    assert.equal(out[0]!.title, "entry 9999");
    assert.equal(out[ACTIVITY_CAP - 1]!.title, `entry ${ACTIVITY_CAP - 2}`);
  });

  it("does not modify the stored list it was given", () => {
    const stored = [entry(1)];
    prependActivity(stored, entry(2));
    assert.equal(stored.length, 1);
  });
});
