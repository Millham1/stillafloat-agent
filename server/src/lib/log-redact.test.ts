import { test } from "node:test";
import assert from "node:assert/strict";
import { redactLogUrl } from "./log-redact";

test("a paperwork link's token never reaches the request log, whether it is in the path or the query", () => {
  const token = "A".repeat(43);
  assert.equal(redactLogUrl(`/api/forms/${token}`), "/api/forms/[link]");
  assert.equal(redactLogUrl(`/api/forms/${token}/sign`), "/api/forms/[link]/sign");
  assert.equal(redactLogUrl(`/forms.html?t=${token}`), "/forms.html");
  assert.equal(redactLogUrl("/api/groups/abc/signatures?x=1"), "/api/groups/abc/signatures");
  assert.equal(redactLogUrl(undefined), undefined);
});
