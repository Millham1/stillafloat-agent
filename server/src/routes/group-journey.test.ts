// group-journey.test.ts (routes) — the real journey routers run, with the database keys removed BEFORE they load, so no
// request here can reach Supabase or send an email. What is tested is what happens before the database is touched: Mark's
// token gate, the validation of what he types, the dry run's switch, and everything a stranger's request is refused on.
// A request that gets past those gates ends in the router's own 500 ("no Supabase key"), which is how these tests see the gate opened.

import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import express, { type Router } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const realFetch = globalThis.fetch;
let journey: Router;
let cruise: Router;
let ipSeq = 0;
const TOKEN = "test-agent-token";
const GOOD_LINK = "A".repeat(43);

before(async () => {
  for (const k of ["SUPABASE_SERVICE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "IDEAS_API_KEY"]) delete process.env[k];
  process.env["AGENT_APPROVAL_TOKEN"] = TOKEN;
  delete process.env["GROUP_JOURNEY_SIM"];
  process.env["PUBLIC_URL"] = "https://dev.example.test";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("http://127.0.0.1:")) throw new Error(`group-journey routes test: unexpected network call to ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
  journey = (await import("./group-journey")).default;
  cruise = (await import("./my-cruise")).default;
});

after(() => { globalThis.fetch = realFetch; });

type Res = { status: number; json: Record<string, any>; headers: Headers };
async function call(router: Router, method: string, path: string, o: { body?: unknown; token?: boolean; ip?: string } = {}): Promise<Res> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {} }; next(); });
  app.use("/api", router);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: { "content-type": "application/json", "x-real-ip": "127.0.0.1", "x-forwarded-for": o.ip ?? `198.51.100.${++ipSeq}`, ...(o.token ? { "x-affiliate-token": TOKEN } : {}) },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any>, headers: res.headers };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const ZERO = "00000000-0000-4000-8000-000000000000";

// ── Mark's side ───────────────────────────────────────────────────────────────

test("every journey route needs Mark's token", async () => {
  for (const [m, p] of [
    ["GET", `/groups/${ZERO}/journey`], ["PUT", `/groups/${ZERO}/journey/approve`], ["GET", `/groups/${ZERO}/journey/preview/t-120`],
    ["POST", `/groups/${ZERO}/journey/change-notice`], ["POST", `/groups/${ZERO}/travelers/${ZERO}/cruise-link`],
  ] as const) {
    const r = await call(journey, m, p, { body: m === "GET" ? undefined : {} });
    assert.equal(r.status, 401, `${m} ${p}`);
  }
});

test("approving takes real kinds and a real yes or no, and nothing else", async () => {
  const put = (body: unknown) => call(journey, "PUT", `/groups/${ZERO}/journey/approve`, { body, token: true });
  assert.equal((await put({ kinds: [], approved: true })).status, 400);
  assert.equal((await put({ kinds: ["t-120", "nonsense"], approved: true })).status, 400);
  assert.equal((await put({ kinds: ["change-notice"], approved: true })).status, 400, "a change notice is approved by sending it, not here");
  assert.equal((await put({ kinds: ["t-120"], approved: "yes" })).status, 400);
  assert.equal((await put({ kinds: ["t-120"] })).status, 400, "no answer is not an answer");
  assert.equal((await put({ kinds: "t-120", approved: true })).status, 400);
  for (const approved of [true, false, null]) assert.equal((await put({ kinds: ["t-120"], approved })).status, 500, `approved=${approved} reaches the database (absent here)`);
});

test("a preview asks for a message that exists", async () => {
  const get = (kind: string) => call(journey, "GET", `/groups/${ZERO}/journey/preview/${kind}`, { token: true });
  assert.equal((await get("t-121")).status, 404);
  assert.equal((await get("change-notice")).status, 404, "a change notice is previewed from its own composer");
  assert.equal((await get("t-120")).status, 500, "a real kind reaches the database (absent here)");
});

test("a change notice needs text, a bounded list of changes, and no card number; a valid one reaches the database", async () => {
  const post = (body: unknown, q = "") => call(journey, "POST", `/groups/${ZERO}/journey/change-notice${q}`, { body, token: true });
  assert.match((await post({})).json["error"], /Write what changed/);
  assert.equal((await post({ text: "x".repeat(4001) })).status, 400);
  assert.equal((await post({ text: "ok", fields: Array.from({ length: 13 }, () => ({ label: "a", before: "b", after: "c" })) })).status, 400);
  assert.match((await post({ text: "ok", fields: [{ label: "", before: "a", after: "b" }] })).json["error"], /needs a name/);
  assert.match((await post({ text: "Pay with 4111 1111 1111 1111" })).json["error"], /card number/);
  assert.match((await post({ text: "ok", fields: [{ label: "Ship", before: "4111111111111111", after: "x" }] })).json["error"], /card number/);
  assert.equal((await post({ text: "The ship changes.", fields: [{ label: "Ship", before: "A", after: "B" }] })).status, 500);
  assert.equal((await post({ text: "The ship changes." }, "?preview=1")).status, 500);
});

test("the dry run answers like a page that does not exist unless this box asks for it, token or no token", async () => {
  delete process.env["GROUP_JOURNEY_SIM"];
  for (const token of [false, true]) {
    for (const m of ["POST", "DELETE"]) {
      const r = await call(journey, m, `/groups/${ZERO}/journey/simulate`, { body: m === "POST" ? { traveler_id: ZERO, to_email: "a@example.test" } : undefined, token });
      assert.deepEqual([r.status, r.json["error"]], [404, "Not found"], `${m} token=${token}`);
    }
  }
  // the flag alone is not enough on the production site
  process.env["GROUP_JOURNEY_SIM"] = "1";
  process.env["PUBLIC_URL"] = "https://stillafloatcruising.com";
  assert.equal((await call(journey, "POST", `/groups/${ZERO}/journey/simulate`, { body: { traveler_id: ZERO, to_email: "a@example.test" }, token: true })).status, 404);
  process.env["PUBLIC_URL"] = "https://dev.example.test";
  // on a box that asks, Mark's token is needed, and a real test address
  assert.equal((await call(journey, "POST", `/groups/${ZERO}/journey/simulate`, { body: { traveler_id: ZERO, to_email: "a@example.test" } })).status, 401);
  assert.equal((await call(journey, "POST", `/groups/${ZERO}/journey/simulate`, { body: { traveler_id: ZERO, to_email: "not-an-address" }, token: true })).status, 400);
  assert.equal((await call(journey, "POST", `/groups/${ZERO}/journey/simulate`, { body: { traveler_id: ZERO, to_email: "a@example.test" }, token: true })).status, 500);
  delete process.env["GROUP_JOURNEY_SIM"];
});

// ── the traveler's side ───────────────────────────────────────────────────────

test("every wrong link gets the same neutral answer, never cached or indexed", async () => {
  const seen = new Set<string>();
  for (const t of ["short", "../../etc/passwd", "B".repeat(44), "%00"]) {
    const r = await call(cruise, "GET", `/my-cruise/${encodeURIComponent(t)}`);
    assert.equal(r.status, 404, t);
    assert.match(r.json["error"], /not valid.*no es válido/s);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.match(r.headers.get("x-robots-tag") ?? "", /noindex/);
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    seen.add(JSON.stringify(r.json));
  }
  assert.equal(seen.size, 1);
  for (const [m, p] of [["POST", `/my-cruise/short/checklist/${ZERO}/done`], ["POST", "/my-cruise/short/details"]] as const) {
    const r = await call(cruise, m, p, { body: {} });
    assert.equal(r.status, 404, `${m} ${p}`);
  }
});

test("guessing links is limited per address", async () => {
  const ip = "198.51.100.250";
  let last = 0;
  for (let i = 0; i < 45; i++) last = (await call(cruise, "GET", "/my-cruise/short", { ip })).status;
  assert.equal(last, 429);
  assert.equal((await call(cruise, "GET", "/my-cruise/short", { ip: "198.51.100.251" })).status, 404, "another address is not affected");
});

test("the cruise page's save: the bot trap stores nothing and says nothing, and a huge body is refused before any lookup", async () => {
  const trap = await call(cruise, "POST", `/my-cruise/${GOOD_LINK}/details`, { body: { website: "http://spam.test", hotel_name: "x" } });
  assert.deepEqual([trap.status, trap.json], [200, { success: true }]);
  const big = await call(cruise, "POST", `/my-cruise/${GOOD_LINK}/details`, { body: { hotel_name: "x".repeat(30_000) } });
  assert.equal(big.status, 413);
  // a well-formed link reaches the lookup, which has no database here
  assert.equal((await call(cruise, "GET", `/my-cruise/${GOOD_LINK}`)).status, 500);
});
