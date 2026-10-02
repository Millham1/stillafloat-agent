// turnstile.test.ts — the shared Cloudflare Turnstile check (moved out of routes/contact.ts on
// 2026-10-02 so the newsletter sign-up could use it). Cloudflare is never called: every test
// hands verifyTurnstile a fake fetch and records what it would have sent.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { verifyTurnstile, turnstileEnforced, TURNSTILE_VERIFY_URL } from "./turnstile";

const ORIGINAL_SECRET = process.env["TURNSTILE_SECRET_KEY"];
afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env["TURNSTILE_SECRET_KEY"];
  else process.env["TURNSTILE_SECRET_KEY"] = ORIGINAL_SECRET;
});

function fakeCloudflare(reply: unknown | (() => never)) {
  const calls: { url: string; method?: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
    if (typeof reply === "function") (reply as () => never)();
    return new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("no secret configured (the dev box): every request passes and Cloudflare is not asked", async () => {
  delete process.env["TURNSTILE_SECRET_KEY"];
  const cf = fakeCloudflare({ success: false });
  assert.equal(turnstileEnforced(), false);
  assert.equal(await verifyTurnstile(null, { fetchImpl: cf.fetchImpl }), true);
  assert.equal(await verifyTurnstile("anything", { form: "subscribe", fetchImpl: cf.fetchImpl }), true);
  assert.equal(cf.calls.length, 0);
});

test("secret configured, no token: refused without asking Cloudflare", async () => {
  process.env["TURNSTILE_SECRET_KEY"] = "test-secret";
  const cf = fakeCloudflare({ success: true });
  assert.equal(turnstileEnforced(), true);
  assert.equal(await verifyTurnstile(null, { fetchImpl: cf.fetchImpl }), false);
  assert.equal(await verifyTurnstile("", { fetchImpl: cf.fetchImpl }), false);
  assert.equal(cf.calls.length, 0);
});

test("secret configured, token: Cloudflare's siteverify decides, asked exactly as contact.ts always asked", async () => {
  process.env["TURNSTILE_SECRET_KEY"] = "test-secret";
  const good = fakeCloudflare({ success: true });
  assert.equal(await verifyTurnstile("tok-good", { fetchImpl: good.fetchImpl }), true);
  assert.deepEqual(good.calls, [{ url: TURNSTILE_VERIFY_URL, method: "POST", body: { secret: "test-secret", response: "tok-good" } }]);
  assert.equal(TURNSTILE_VERIFY_URL, "https://challenges.cloudflare.com/turnstile/v0/siteverify");

  const bad = fakeCloudflare({ success: false, "error-codes": ["invalid-input-response"] });
  assert.equal(await verifyTurnstile("tok-bad", { fetchImpl: bad.fetchImpl }), false);

  const odd = fakeCloudflare({ success: "true" });
  assert.equal(await verifyTurnstile("tok-odd", { fetchImpl: odd.fetchImpl }), false, "only a real boolean true passes");
});

test("Cloudflare unreachable: refused (fails closed)", async () => {
  process.env["TURNSTILE_SECRET_KEY"] = "test-secret";
  const down = fakeCloudflare(() => { throw new Error("ECONNRESET"); });
  assert.equal(await verifyTurnstile("tok", { fetchImpl: down.fetchImpl }), false);
  assert.equal(down.calls.length, 1);
});
