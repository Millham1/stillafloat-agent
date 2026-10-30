// ai-visibility.test.ts — the agent's activity log behind the dashboard's AI
// Visibility page (2026-09-29). Pure helpers only: what a POST may contain,
// what the server stamps, and the newest-first 500-entry cap.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVITY_CAP, ACTIVITY_KINDS, TITLE_MAX, DETAIL_MAX, BUTTONS_MAX,
  prependActivity, validateActivity, validateButtons, patchActivity, activitySourceRef, type ActivityEntry,
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
      buttons: [{ label: "Approve", path: "/api/x/approve" }],
    }, NOW);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.entry.status, "waiting-on-mark");
    assert.equal(r.entry.detail, "EN + ES");
    assert.equal(r.entry.link, "https://stillafloatcruising.com/work-with-mark.html");
  });

  // Mark, 2026-10-29: "There is nothing here that takes me to an action."
  it("refuses a waiting item with nothing to press", () => {
    const r = validateActivity({ kind: "forum", title: "Sorting comments", status: "waiting-on-mark" }, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /at least one button/);
  });

  it("keeps the buttons on a waiting item and drops them from a finished one", () => {
    const buttons = [{ label: "Turn on", method: "post", path: "/api/ai-visibility/prompt-tests/on" }, { label: "Not now", dismiss: true }];
    const w = validateActivity({ kind: "prompt-test", title: "Weekly check", status: "waiting-on-mark", buttons }, NOW);
    assert.ok(w.ok);
    if (!w.ok) return;
    assert.deepEqual(w.entry.buttons, [{ label: "Turn on", method: "POST", path: "/api/ai-visibility/prompt-tests/on" }, { label: "Not now", dismiss: true }]);
    const d = validateActivity({ kind: "prompt-test", title: "Weekly check", status: "done", buttons }, NOW);
    assert.ok(d.ok && !("buttons" in d.entry));
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

describe("validateButtons", () => {
  it("accepts the three shapes and normalises the method", () => {
    const r = validateButtons([
      { label: " Approve ", path: "/api/x/approve" },
      { label: "Open", href: "/forum" },
      { label: "Ignore", dismiss: true },
    ]);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.buttons, [
      { label: "Approve", method: "POST", path: "/api/x/approve" },
      { label: "Open", href: "/forum" },
      { label: "Ignore", dismiss: true },
    ]);
  });

  it("treats a missing list as no buttons", () => {
    assert.deepEqual(validateButtons(undefined), { ok: true, buttons: [] });
  });

  const bad: [string, unknown][] = [
    ["not a list", { label: "x" }],
    ["too many", Array.from({ length: BUTTONS_MAX + 1 }, () => ({ label: "x", dismiss: true }))],
    ["no label", [{ path: "/api/x" }]],
    ["two shapes at once", [{ label: "x", path: "/api/x", dismiss: true }]],
    ["no shape", [{ label: "x" }]],
    ["a path outside /api/", [{ label: "x", path: "/admin" }]],
    ["a path with a query", [{ label: "x", path: "/api/x?y=1" }]],
    ["a DELETE", [{ label: "x", method: "DELETE", path: "/api/x" }]],
    ["a javascript: href", [{ label: "x", href: "javascript:alert(1)" }]],
  ];
  for (const [what, raw] of bad) {
    it(`rejects ${what}`, () => {
      const r = validateButtons(raw);
      assert.equal(r.ok, false);
    });
  }
});

describe("activitySourceRef", () => {
  it("is stable and slug-shaped", () => {
    assert.equal(activitySourceRef("Weekly check: do ChatGPT, Claude and Perplexity recommend Mark?"),
      "ai-visibility:weekly-check-do-chatgpt-claude-and-perplexity-recommend-mark");
    assert.equal(activitySourceRef("  A  "), "ai-visibility:a");
  });
});

describe("patchActivity", () => {
  const waiting: ActivityEntry = {
    at: "2026-09-29T21:49:00.000Z", kind: "forum", title: "Sorting YouTube comments and Reddit questions",
    detail: "Built and OFF.", status: "waiting-on-mark", buttons: [{ label: "Ignore", dismiss: true }], actionId: "act-1",
  };
  const other = entry(7);

  it("matches by actionId, closes the item and drops its buttons", () => {
    const r = patchActivity([other, waiting], { actionId: "act-1" }, { status: "done", note: "Moved to the AI box." }, NOW);
    assert.ok(r.entry && r.before);
    assert.equal(r.before!.status, "waiting-on-mark");
    assert.equal(r.entry!.status, "done");
    assert.equal(r.entry!.detail, "Built and OFF.\n\n2026-09-29: Moved to the AI box.");
    assert.ok(!("buttons" in r.entry!), "a closed item has nothing to press");
    assert.equal(r.list[1], r.entry);
    assert.equal(r.list[0], other);
  });

  it("matches the newest item by title when there is no actionId, case-insensitively", () => {
    const older = { ...waiting, at: "2026-09-01T00:00:00.000Z", actionId: undefined };
    const newer = { ...waiting, actionId: undefined };
    const r = patchActivity([newer, older], { title: "sorting youtube comments AND reddit questions" },
      { buttons: [{ label: "Turn on", method: "POST", path: "/api/x" }], actionId: "act-2" }, NOW);
    assert.equal(r.entry, r.list[0]);
    assert.deepEqual(r.entry!.buttons, [{ label: "Turn on", method: "POST", path: "/api/x" }]);
    assert.equal(r.entry!.actionId, "act-2");
    assert.equal(r.list[1], older, "the older twin is untouched");
  });

  it("returns null when nothing matches and leaves the list as it was", () => {
    const stored = [waiting];
    const r = patchActivity(stored, { actionId: "nope" }, { status: "done" }, NOW);
    assert.equal(r.entry, null);
    assert.equal(stored[0]!.status, "waiting-on-mark");
  });

  it("removes the matched item when asked and hands back what it removed", () => {
    const r = patchActivity([other, waiting], { actionId: "act-1" }, { remove: true }, NOW);
    assert.deepEqual(r.list, [other]);
    assert.equal(r.entry!.title, waiting.title);
    assert.equal(r.before!.status, "waiting-on-mark");
  });

  it("replaces the detail when asked, and never edits the list it was given", () => {
    const stored = [waiting];
    const r = patchActivity(stored, { actionId: "act-1" }, { detail: "New text" }, NOW);
    assert.equal(r.entry!.detail, "New text");
    assert.equal(stored[0]!.detail, "Built and OFF.");
  });
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
