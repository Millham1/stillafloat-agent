import { test } from "node:test";
import assert from "node:assert/strict";
import { redactLogUrl } from "./log-redact";

test("a paperwork link's token never reaches the request log, whether it is in the path or the query", () => {
  const token = "A".repeat(43);
  assert.equal(redactLogUrl(`/api/forms/${token}`), "/api/forms/[link]");
  assert.equal(redactLogUrl(`/api/forms/${token}/sign`), "/api/forms/[link]/sign");
  assert.equal(redactLogUrl(`/forms.html?t=${token}`), "/forms.html");
  // the guest's "Your details" link after Count me in (Mark 2026-10-23) is a credential in the same two places
  assert.equal(redactLogUrl(`/api/group-details/${token}`), "/api/group-details/[link]");
  assert.equal(redactLogUrl(`/api/group-details/${token}/choice`), "/api/group-details/[link]/choice");
  assert.equal(redactLogUrl(`/api/group-details/${token}/hold`), "/api/group-details/[link]/hold");
  assert.equal(redactLogUrl(`/api/group-details/${token}/pick`), "/api/group-details/[link]/pick");
  assert.equal(redactLogUrl(`/details.html?t=${token}&choice=call`), "/details.html");
  assert.equal(redactLogUrl(`/es/details.html?t=${token}`), "/es/details.html");
  assert.equal(redactLogUrl("/api/groups/abc/signatures?x=1"), "/api/groups/abc/signatures");
  assert.equal(redactLogUrl(undefined), undefined);
});
