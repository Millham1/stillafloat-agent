// contact.test.ts — the Work-with-Mark / cabin-request contact form (POST /api/contact) must
// behave exactly as before its Turnstile check moved to lib/turnstile.ts (2026-10-02).
//
// The real contact router runs. Safety: the Supabase and mailer keys are removed BEFORE the
// router is loaded (persistence.ts reads them at load time), and Cloudflare's siteverify is
// answered by a stub, so no test here can reach the database, send an email or leave the Mac.
// A request that gets past the Turnstile gate therefore ends in the router's own 500
// ("no Supabase key") — which is how these tests see that the gate opened.

import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import express, { type Router } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const realFetch = globalThis.fetch;
const siteverify: Record<string, unknown>[] = [];
let contactRouter: Router;
let ipSeq = 0;

before(async () => {
  for (const k of ["SUPABASE_SERVICE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "IDEAS_API_KEY", "APPROVAL_EMAIL"]) delete process.env[k];
  process.env["TURNSTILE_SECRET_KEY"] = "test-secret";
  process.env["TURNSTILE_SITE_KEY"] = "test-site-key";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://challenges.cloudflare.com/")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      siteverify.push(body);
      return new Response(JSON.stringify({ success: body["response"] === "tok-good" }));
    }
    if (!url.startsWith("http://127.0.0.1:")) throw new Error(`contact.test: unexpected network call to ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
  contactRouter = (await import("./contact")).default;
});

after(() => {
  globalThis.fetch = realFetch;
});

async function call(method: "GET" | "POST", path: string, body?: Record<string, unknown>, ip = `198.51.100.${++ipSeq}`) {
  const app = express();
  app.use(express.json());
  app.use("/api", contactRouter);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const lead = (over: Record<string, unknown> = {}) => ({
  first_name: "Pat", last_name: "Cruiser", email: "pat@example.com", num_travelers: 2,
  travel_dates: "March 2027", first_time: true, ...over,
});

const VERIFICATION_FAILED = "Verification failed. Please refresh the page and try again.";

test("contact: no Turnstile token → 400 with the same message as always, Cloudflare not asked", async () => {
  const before = siteverify.length;
  const { status, json } = await call("POST", "/contact", lead());
  assert.equal(status, 400);
  assert.deepEqual(json, { error: VERIFICATION_FAILED });
  assert.equal(siteverify.length, before);
});

test("contact: a token Cloudflare rejects → 400, asked with the secret and the token", async () => {
  siteverify.length = 0;
  const { status, json } = await call("POST", "/contact", lead({ "cf-turnstile-response": "tok-forged" }));
  assert.equal(status, 400);
  assert.deepEqual(json, { error: VERIFICATION_FAILED });
  assert.deepEqual(siteverify, [{ secret: "test-secret", response: "tok-forged" }]);
});

test("contact: a good token opens the gate (the request goes on to the save step)", async () => {
  siteverify.length = 0;
  const { status, json } = await call("POST", "/contact", lead({ "cf-turnstile-response": "tok-good" }));
  assert.deepEqual(siteverify, [{ secret: "test-secret", response: "tok-good" }]);
  assert.notEqual(json["error"], VERIFICATION_FAILED);
  assert.equal(status, 500, "past the gate, the save fails only because this test has no database key");
});

test("contact: field checks still answer before the security check", async () => {
  siteverify.length = 0;
  assert.deepEqual((await call("POST", "/contact", lead({ first_name: "" }))).json, { error: "First name is required." });
  assert.deepEqual((await call("POST", "/contact", lead({ email: "nope" }))).json, { error: "Please enter a valid email address." });
  assert.deepEqual((await call("POST", "/contact", lead({ num_travelers: 0 }))).json, { error: "Please tell us how many travelers (1–20)." });
  assert.equal(siteverify.length, 0);
});

test("contact: the per-IP limit is unchanged — five an hour, the sixth is refused", async () => {
  const ip = "203.0.113.77";
  for (let i = 1; i <= 5; i++) assert.equal((await call("POST", "/contact", lead(), ip)).status, 400, `attempt ${i} reaches the form checks`);
  const sixth = await call("POST", "/contact", lead(), ip);
  assert.equal(sixth.status, 429);
  assert.deepEqual(sixth.json, { error: "Too many submissions. Please try again later." });
});

test("public-config still hands the pages the Turnstile site key", async () => {
  const { status, json } = await call("GET", "/public-config");
  assert.equal(status, 200);
  assert.deepEqual(json, { turnstileSiteKey: "test-site-key" });
});
