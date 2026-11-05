import test from "node:test";
import assert from "node:assert/strict";
import { commentaryText } from "./newsletter-commentary";

test("keeps the commentary's own paragraphs, one per line, with no markup", () => {
  const html = "<p>First &amp; foremost.</p><p>It&#39;s &quot;fine&quot;.</p>";
  assert.equal(commentaryText(html), `First & foremost.\nIt's "fine".`);
});

test("drops empty paragraphs and tolerates plain text", () => {
  assert.equal(commentaryText("<p> </p><p>Only one.</p>"), "Only one.");
  assert.equal(commentaryText("Just text"), "Just text");
});
