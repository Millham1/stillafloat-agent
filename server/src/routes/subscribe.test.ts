// subscribe.test.ts — the newsletter sign-up (POST /api/subscribe) and the "send a new
// confirmation email" button (POST /api/resend-verification) after the 2026-10-02 fix for
// bots signing strangers up. A real Express app runs the handlers end to end; the subscriber
// table, the email sender and Cloudflare are all in-memory fakes, so nothing touches
// Supabase, Zoho or the network. The real Turnstile check (lib/turnstile.ts) runs, with
// Cloudflare's reply faked.

import { test, before } from "node:test";
import * as assert from "node:assert/strict";
import express, { type RequestHandler } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createSubscribeHandler, createResendVerificationHandler, SUBSCRIBE_MESSAGES,
  type SubscribeDeps, type ResendDeps, type NewSubscriberRow,
} from "./subscribe";
import { verifyTurnstile } from "../lib/turnstile";
import { createSendCap, DEFAULT_VERIFICATION_SENDS_PER_HOUR } from "../lib/verification-send-cap";

before(() => {
  process.env["TURNSTILE_SECRET_KEY"] = "test-secret"; // as on prod
});

const GOOD = "tok-good";

function world(opts: {
  rows?: { email: string; status: string; id?: string; name?: string; lang?: string; token?: string }[];
  capLimit?: number; now?: () => number; limited?: boolean; insertFails?: boolean;
} = {}) {
  const rows = new Map((opts.rows ?? []).map((r) => [r.email, { id: r.id ?? `id-${r.email}`, name: r.name ?? "Old Name", lang: r.lang ?? "en", token: r.token ?? "old-token", ...r }]));
  const inserted: NewSubscriberRow[] = [];
  const sent: { name: string; email: string; token: string; lang: string }[] = [];
  const siteverify: Record<string, unknown>[] = [];
  const lookups: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    siteverify.push(body);
    return new Response(JSON.stringify({ success: body["response"] === GOOD }));
  }) as typeof fetch;
  const sendCap = createSendCap({ limit: opts.capLimit ?? DEFAULT_VERIFICATION_SENDS_PER_HOUR, now: opts.now });
  let n = 0;
  const deps: SubscribeDeps = {
    rateLimited: () => Boolean(opts.limited),
    verifyTurnstile: (token) => verifyTurnstile(token, { form: "subscribe", fetchImpl }),
    findSubscriber: async (email) => { lookups.push(email); const r = rows.get(email); return r ? { status: r.status } : null; },
    insertSubscriber: async (row) => {
      if (opts.insertFails) return { error: new Error("duplicate key") };
      inserted.push(row);
      rows.set(row.email, { id: `id-${row.email}`, ...row });
      return { error: null };
    },
    sendVerification: async (args) => { sent.push(args); return { success: true }; },
    sendCap,
    newToken: () => `token-${++n}`,
  };
  const resendDeps: ResendDeps = {
    rateLimited: () => Boolean(opts.limited),
    findSubscriber: async (email) => {
      const r = rows.get(email);
      return r ? { id: r.id, name: r.name, status: r.status, lang: r.lang } : null;
    },
    setToken: async (id, token) => {
      for (const r of rows.values()) if (r.id === id) r.token = token;
      return { error: null };
    },
    sendVerification: deps.sendVerification,
    sendCap,
    newToken: deps.newToken,
  };
  return { deps, resendDeps, rows, inserted, sent, siteverify, lookups, sendCap };
}

async function post(handler: RequestHandler, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.post("/api/x", handler);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const subscribe = (w: ReturnType<typeof world>, body: Record<string, unknown>) => post(createSubscribeHandler(w.deps), body);
const resend = (w: ReturnType<typeof world>, body: Record<string, unknown>) => post(createResendVerificationHandler(w.resendDeps), body);

const form = (over: Record<string, unknown> = {}) => ({
  name: "Pat Cruiser", email: "Pat@Example.com ", website: "", "cf-turnstile-response": GOOD, ...over,
});

// ── POST /api/subscribe ──────────────────────────────────────────────────────

test("a sign-up with no security token is refused: 400, nothing looked up, saved or sent", async () => {
  const w = world();
  const { status, json } = await subscribe(w, form({ "cf-turnstile-response": undefined }));
  assert.equal(status, 400);
  assert.deepEqual(json, { error: SUBSCRIBE_MESSAGES.en.security });
  assert.equal(json["error"], "Please complete the security check and try again.");
  assert.equal(w.siteverify.length, 0, "no token: Cloudflare is not even asked");
  assert.deepEqual([w.lookups.length, w.inserted.length, w.sent.length], [0, 0, 0]);
  assert.equal(w.sendCap.count(), 0);
});

test("a sign-up with a token Cloudflare rejects is refused: 400, nothing saved or sent", async () => {
  const w = world();
  const { status, json } = await subscribe(w, form({ "cf-turnstile-response": "tok-forged" }));
  assert.equal(status, 400);
  assert.deepEqual(json, { error: SUBSCRIBE_MESSAGES.en.security });
  assert.deepEqual(w.siteverify, [{ secret: "test-secret", response: "tok-forged" }]);
  assert.deepEqual([w.lookups.length, w.inserted.length, w.sent.length], [0, 0, 0]);
});

test("the Spanish page gets the refusal in Spanish", async () => {
  const w = world();
  const { status, json } = await subscribe(w, form({ lang: "es", "cf-turnstile-response": "" }));
  assert.equal(status, 400);
  assert.equal(json["error"], "Por favor completa la verificación de seguridad e inténtalo de nuevo.");
});

test("a sign-up with a good token saves one pending row and sends one confirmation email with that row's token", async () => {
  const w = world();
  const { status, json } = await subscribe(w, form());
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true });
  assert.deepEqual(w.inserted, [{ email: "pat@example.com", name: "Pat Cruiser", status: "pending", token: "token-1", lang: "en" }]);
  assert.deepEqual(w.sent, [{ name: "Pat Cruiser", email: "pat@example.com", token: "token-1", lang: "en" }]);
  assert.equal(w.sendCap.count(), 1);

  const es = world();
  await subscribe(es, form({ email: "ana@ejemplo.com", name: "Ana Crucero", lang: "es" }));
  assert.deepEqual(es.inserted.map((r) => r.lang), ["es"]);
  assert.deepEqual(es.sent.map((s) => s.lang), ["es"]);
});

test(`the confirmation cap: ${DEFAULT_VERIFICATION_SENDS_PER_HOUR} sign-ups in an hour go through, the next gets 429 with nothing saved or sent, and an hour later sign-ups work again`, async () => {
  let t = 1_000_000;
  const w = world({ now: () => t });
  for (let i = 1; i <= DEFAULT_VERIFICATION_SENDS_PER_HOUR; i++) {
    t += 60_000;
    const r = await subscribe(w, form({ email: `guest${i}@example.com` }));
    assert.equal(r.status, 200, `sign-up ${i}`);
  }
  const over = await subscribe(w, form({ email: "one-too-many@example.com" }));
  assert.equal(over.status, 429);
  assert.deepEqual(over.json, { error: "We're getting a lot of signups right now — please try again in a little while." });
  assert.equal(w.inserted.length, DEFAULT_VERIFICATION_SENDS_PER_HOUR, "no row for the refused sign-up");
  assert.equal(w.sent.length, DEFAULT_VERIFICATION_SENDS_PER_HOUR, "no email for the refused sign-up");
  assert.equal(w.rows.has("one-too-many@example.com"), false);

  const overEs = await subscribe(w, form({ email: "otra@ejemplo.com", lang: "es" }));
  assert.equal(overEs.status, 429);
  assert.equal(overEs.json["error"], "Estamos recibiendo muchas suscripciones en este momento — por favor inténtalo de nuevo en un rato.");

  t += 60 * 60 * 1000;
  const later = await subscribe(w, form({ email: "next-hour@example.com" }));
  assert.equal(later.status, 200, "the window rolls");
  assert.equal(w.sent.at(-1)!.email, "next-hour@example.com");
});

test("the honeypot still works: a filled hidden field gets a quiet 200 and nothing is checked, saved or sent", async () => {
  const w = world();
  const { status, json } = await subscribe(w, form({ website: "http://spam.example", "cf-turnstile-response": undefined }));
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true });
  assert.deepEqual([w.siteverify.length, w.lookups.length, w.inserted.length, w.sent.length], [0, 0, 0, 0]);
});

test("the per-IP limit still comes first", async () => {
  const w = world({ limited: true });
  const { status, json } = await subscribe(w, form());
  assert.equal(status, 429);
  assert.deepEqual(json, { error: "Too many attempts. Please try again later." });
  assert.deepEqual([w.siteverify.length, w.inserted.length, w.sent.length], [0, 0, 0]);
});

test("someone already pending or confirmed gets the same answer as before, with no new email and no cap slot used", async () => {
  const w = world({ rows: [{ email: "pat@example.com", status: "pending" }, { email: "sam@example.com", status: "confirmed" }] });
  assert.deepEqual((await subscribe(w, form())).json, { ok: true, already: "pending" });
  assert.deepEqual((await subscribe(w, form({ email: "sam@example.com" }))).json, { ok: true, already: "confirmed" });
  assert.deepEqual([w.inserted.length, w.sent.length, w.sendCap.count()], [0, 0, 0]);
});

test("a failed insert sends nothing and hands its cap slot back", async () => {
  const w = world({ insertFails: true });
  const { status } = await subscribe(w, form());
  assert.equal(status, 500);
  assert.equal(w.sent.length, 0);
  assert.equal(w.sendCap.count(), 0);
});

test("field checks are unchanged and still answer before the security check", async () => {
  const w = world();
  assert.deepEqual((await subscribe(w, form({ name: "P" }))).json, { error: "Please enter your full name." });
  assert.deepEqual((await subscribe(w, form({ email: "not-an-email" }))).json, { error: "Please enter a valid email address." });
  assert.equal(w.siteverify.length, 0);
});

test("with no Turnstile secret (the dev box) the sign-up behaves as contact.ts does: no token needed", async () => {
  const saved = process.env["TURNSTILE_SECRET_KEY"];
  delete process.env["TURNSTILE_SECRET_KEY"];
  try {
    const w = world();
    const { status } = await subscribe(w, form({ "cf-turnstile-response": undefined }));
    assert.equal(status, 200);
    assert.equal(w.siteverify.length, 0);
    assert.equal(w.inserted.length, 1);
  } finally {
    process.env["TURNSTILE_SECRET_KEY"] = saved;
  }
});

// ── POST /api/resend-verification ────────────────────────────────────────────

test("resend: a pending subscriber gets a fresh link, and it counts against the same cap", async () => {
  const w = world({ rows: [{ email: "pat@example.com", status: "pending", name: "Pat Cruiser", lang: "es" }] });
  const { status, json } = await resend(w, { email: " PAT@example.com" });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true });
  assert.deepEqual(w.sent, [{ name: "Pat Cruiser", email: "pat@example.com", token: "token-1", lang: "es" }]);
  assert.equal(w.rows.get("pat@example.com")!.token, "token-1");
  assert.equal(w.sendCap.count(), 1);
});

test("resend: over the cap it is refused with 429, the old link still works and nothing is sent", async () => {
  const w = world({ capLimit: 1, rows: [{ email: "pat@example.com", status: "pending" }, { email: "lee@example.com", status: "pending" }] });
  assert.equal((await subscribe(w, form({ email: "new@example.com" }))).status, 200, "the sign-up used the only slot");
  const { status, json } = await resend(w, { email: "lee@example.com" });
  assert.equal(status, 429);
  assert.deepEqual(json, { error: SUBSCRIBE_MESSAGES.en.busy });
  assert.equal(w.rows.get("lee@example.com")!.token, "old-token");
  assert.deepEqual(w.sent.map((s) => s.email), ["new@example.com"]);
});

test("resend: now has a per-IP limit; confirmed and unknown addresses answer as before without sending", async () => {
  const limited = world({ limited: true, rows: [{ email: "pat@example.com", status: "pending" }] });
  assert.equal((await resend(limited, { email: "pat@example.com" })).status, 429);
  assert.equal(limited.sent.length, 0);

  const w = world({ rows: [{ email: "sam@example.com", status: "confirmed" }, { email: "gone@example.com", status: "unsubscribed" }] });
  assert.deepEqual((await resend(w, { email: "sam@example.com" })).json, { ok: true, already: "confirmed" });
  assert.equal((await resend(w, { email: "gone@example.com" })).status, 400);
  assert.equal((await resend(w, { email: "nobody@example.com" })).status, 404);
  assert.equal((await resend(w, {})).status, 400);
  assert.deepEqual([w.sent.length, w.sendCap.count()], [0, 0]);
});
