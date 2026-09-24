import { strict as assert } from "node:assert";
import { test } from "node:test";
import { briefly } from "./brief-error";

test("briefly pulls the reason out of a provider's HTML error page", () => {
  // Shape of what Supabase actually returned on the first live run, 2026-09-23:
  // a full Cloudflare 522 page. `logger.error({ err })` serialised the whole
  // thing — thousands of characters of markup for a five-word fault.
  const cloudflare = `<!DOCTYPE html>
<html class="no-js" lang="en-US"><head>
<title>supabase.co | 522: Connection timed out</title>
<meta charset="UTF-8" /></head><body>
<h1><span class="inline-block">Connection timed out</span>
<span class="code-label">Error code 522</span></h1>
<p>The initial connection between Cloudflare's network and the origin web server
timed out. As a result, the web page can not be displayed.</p>
</body></html>`;
  const out = briefly(new Error(cloudflare));
  assert.equal(out, "supabase.co | 522: Connection timed out");
  assert.ok(!out.includes("<"), "must not leak markup into the log");
});

test("briefly leaves an ordinary error message alone", () => {
  assert.equal(briefly(new Error("relation \"ships\" does not exist")),
    'relation "ships" does not exist');
  assert.equal(briefly("plain string failure"), "plain string failure");
});

test("briefly takes the first line of a stack-like message", () => {
  assert.equal(briefly(new Error("boom\n  at foo (bar.ts:1:1)\n  at baz")), "boom");
});

test("briefly caps a long message so one fault cannot flood the log", () => {
  const out = briefly(new Error("x".repeat(5000)));
  assert.equal(out.length, 201);          // 200 + the ellipsis
  assert.ok(out.endsWith("…"));
});
