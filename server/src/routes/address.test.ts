// address.test.ts (routes) — POST /api/address/lookup behind the details page's home address (Mark 2026-10-24). The real router runs with the USPS service
// stubbed at the network edge (no credentials, no network, no real address): what the page can rely on is "{ available: false }" when the service is not
// there, a limit per address, the bot trap, and that nothing about what was typed is logged or cached by the browser.

import { test, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import express, { type Router } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resetAddressLookupState } from "../lib/address-lookup";

const realFetch = globalThis.fetch;
let router: Router;
let uspsCalls: string[] = [];
let uspsMode: "found" | "none" | "down" = "found";

before(async () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://apis.usps.com/")) {
      uspsCalls.push(url);
      if (url.includes("/oauth2/")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      if (uspsMode === "down") return new Response("{}", { status: 503 });
      if (uspsMode === "none") return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ address: { streetAddress: "500 E DAVIE ST", city: "RALEIGH", state: "NC", ZIPCode: "27601" } }), { status: 200 });
    }
    if (!url.startsWith("http://127.0.0.1:")) throw new Error(`address route test: unexpected network call to ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
  router = (await import("./address")).default;
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { uspsCalls = []; uspsMode = "found"; resetAddressLookupState(); delete process.env["USPS_CLIENT_ID"]; delete process.env["USPS_CLIENT_SECRET"]; });

let visitor = 0;
async function lookup(body: unknown, o: { ip?: string; method?: string } = {}) {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/address/lookup`, {
      method: o.method ?? "POST", headers: { "content-type": "application/json", "x-forwarded-for": o.ip ?? `203.0.113.${(++visitor % 250) + 1}` },
      body: o.method === "GET" ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, any> = {};
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const FULL = { q: "500 e davie street", city: "ral", state: "nc", zip: "", website: "" };

test("with no USPS credentials on this box the answer is 'not available', and the page takes the address as typed", async () => {
  const r = await lookup(FULL);
  assert.deepEqual([r.status, r.json], [200, { success: true, available: false }]);
  assert.equal(uspsCalls.length, 0);
});

test("with credentials a full address comes back in the post office's spelling, up to five suggestions in the same shape; private headers", async () => {
  process.env["USPS_CLIENT_ID"] = "id"; process.env["USPS_CLIENT_SECRET"] = "secret";
  const r = await lookup(FULL);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { success: true, available: true, suggestions: [{ street: "500 E Davie St", city: "Raleigh", state: "NC", zip: "27601", formatted: "500 E Davie St, Raleigh, NC 27601" }] });
  assert.match(r.headers.get("cache-control") ?? "", /no-store/);
  assert.match(r.headers.get("x-robots-tag") ?? "", /noindex/);
  assert.match(r.headers.get("referrer-policy") ?? "", /no-referrer/);
  // not enough typed yet: said quietly, and nothing is asked of the post office
  uspsCalls.length = 0;
  const half = await lookup({ q: "500 e davie street" });
  assert.deepEqual(half.json, { success: true, available: true, suggestions: [], incomplete: true });
  assert.equal(uspsCalls.length, 0);
  // the post office has no such address
  uspsMode = "none";
  const none = await lookup({ q: "9999 nowhere road", city: "Raleigh", state: "NC" });
  assert.deepEqual(none.json, { success: true, available: true, suggestions: [] });
  // the post office is down: not available, and the page takes it as typed
  uspsMode = "down";
  const down = await lookup({ q: "1 other street", city: "Raleigh", state: "NC" });
  assert.deepEqual(down.json, { success: true, available: false });
});

test("the bot trap answers as if nothing could be found and asks nobody; a street under five characters is refused; only POST exists", async () => {
  process.env["USPS_CLIENT_ID"] = "id"; process.env["USPS_CLIENT_SECRET"] = "secret";
  const bot = await lookup({ ...FULL, website: "http://spam.example" });
  assert.deepEqual([bot.status, bot.json], [200, { success: true, available: false }]);
  assert.equal(uspsCalls.length, 0);
  for (const q of ["", "1234", "  12  ", undefined, 12345, null]) {
    const r = await lookup({ ...FULL, q });
    assert.equal(r.status, 400, JSON.stringify(q));
    assert.equal(r.json["error"], "Type at least five characters of the street.");
  }
  assert.equal((await lookup({}, { method: "GET" })).status, 404, "an address is never in a URL: there is no GET");
  assert.equal(uspsCalls.length, 0);
});

test("lookups are limited per address: the 401st in an hour is a 429 (the type-ahead asks as the street is typed), and another address is unaffected", async () => {
  const ip = "198.51.100.200";
  let last = 0;
  for (let i = 0; i < 401; i++) last = (await lookup({ q: "12" }, { ip })).status;     // short streets are cheap to refuse and count the same
  assert.equal(last, 429);
  assert.equal((await lookup(FULL, { ip: "198.51.100.201" })).status, 200);
});
