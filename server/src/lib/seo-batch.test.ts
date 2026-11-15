import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSeoBatchPayload, planItem, batchApprovalNote, itemNote, type SeoBatchItem } from "./seo-batch";

const override = {
  type: "seo-override" as const,
  page: "https://stillafloatcruising.com/news/some-story-abc123.html",
  title: "New title",
};

describe("seo-batch: the search worker's one-decision batch", () => {
  it("recognises a batch and refuses anything that is not one", () => {
    assert.equal(isSeoBatchPayload({ type: "seo-batch", items: [{ taskId: "t1", title: "Build a guide" }] }), true);
    assert.equal(isSeoBatchPayload({ type: "seo-batch", items: [] }), false); // an empty batch decides nothing
    assert.equal(isSeoBatchPayload({ type: "seo-override", page: "/news/x-abc123.html", title: "t" }), false);
    assert.equal(isSeoBatchPayload({ type: "seo-batch", items: [{ title: "no task id" }] }), false);
    assert.equal(isSeoBatchPayload({ type: "seo-batch", items: [{ taskId: " ", title: "blank id" }] }), false);
    assert.equal(isSeoBatchPayload(null), false);
    assert.equal(isSeoBatchPayload("seo-batch"), false);
  });

  it("applies a story-page override at once and only stamps everything else as approved", () => {
    const withAction: SeoBatchItem = { taskId: "t1", title: "Rewrite the story title", action: override };
    const build: SeoBatchItem = { taskId: "t2", title: "Build a winter guide", kind: "content" };
    assert.deepEqual(planItem(withAction, { status: "open" }), { step: "apply", action: override });
    assert.deepEqual(planItem(build, { status: "open" }), { step: "approve" });
  });

  it("an action that changes nothing or names no page is approved to build, never applied", () => {
    const noChange = { taskId: "t1", title: "x", action: { type: "seo-override" as const, page: "/news/x-abc123.html" } };
    const noTarget = { taskId: "t2", title: "y", action: { type: "seo-override" as const, title: "New" } };
    assert.deepEqual(planItem(noChange, { status: "open" }), { step: "approve" });
    assert.deepEqual(planItem(noTarget, { status: "open" }), { step: "approve" });
  });

  it("skips a task that moved on since the batch was filed, and says why", () => {
    const item: SeoBatchItem = { taskId: "t1", title: "Build a guide" };
    assert.deepEqual(planItem(item, { status: "done" }), { step: "skip", reason: "the task is already done" });
    assert.deepEqual(planItem(item, { status: "dismissed" }), { step: "skip", reason: "the task is already dismissed" });
    assert.deepEqual(planItem(item, null), { step: "skip", reason: "the task no longer exists" });
  });

  it("writes an approval note that counts each outcome and names every item", () => {
    const note = batchApprovalNote(
      [
        { title: "Rewrite the story title", result: "applied", note: 'title: "Old" → "New"' },
        { title: "Build a winter guide", result: "approved" },
        { title: "Add a guides strip", result: "approved" },
        { title: "Old idea", result: "skipped", note: "the task is already done" },
      ],
      "2026-11-16",
    );
    assert.equal(
      note,
      [
        "[approved 2026-11-16] 1 applied to the site now, 2 approved to be built, 1 skipped.",
        '- Applied: Rewrite the story title (title: "Old" → "New")',
        "- Approved to build: Build a winter guide",
        "- Approved to build: Add a guides strip",
        "- Skipped: Old idea (the task is already done)",
      ].join("\n"),
    );
    assert.equal(
      batchApprovalNote([{ title: "A", result: "approved" }], "2026-11-16").split("\n")[0],
      "[approved 2026-11-16] 0 applied to the site now, 1 approved to be built.",
    );
  });

  it("stamps each task with who decided, when, and in which batch", () => {
    assert.equal(
      itemNote("approved", "2026-11-16", "Search batch 2026-11-15: 5 changes for your OK"),
      '[approved by Mark 2026-11-16] Approved in "Search batch 2026-11-15: 5 changes for your OK". To be built and shipped through dev.',
    );
    assert.match(itemNote("dismissed", "2026-11-16", "Search batch"), /^\[dismissed by Mark 2026-11-16\].*Not to be offered again\.$/);
  });
});
