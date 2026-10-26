// address-lookup.test.ts — the post office's address service behind the details page's home address (Mark 2026-10-24), with a stubbed fetch: no network,
// no credentials, no real address.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { formatAddress, lookupAddress, resetAddressLookupState, splitOneLine, titleCaseAddress, US_STATES } from "./address-lookup";

const ENV = { USPS_CLIENT_ID: "test-id", USPS_CLIENT_SECRET: "test-secret" };
const T0 = 1_800_000_000_000;

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };
function stub(answers: Array<{ status: number; json?: unknown } | Error>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: typeof init?.body === "string" ? init.body : null });
    const a = answers[Math.min(i++, answers.length - 1)]!;
    if (a instanceof Error) throw a;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json ?? {} } as Response;
  }) as typeof fetch;
  return { calls, fetch: fetchStub };
}
const TOKEN = { status: 200, json: { access_token: "tok-1", expires_in: 3600 } };
const FOUND = { status: 200, json: { address: { streetAddress: "123 MAIN ST", secondaryAddress: "", city: "RALEIGH", state: "NC", ZIPCode: "27601", ZIPPlus4: "1234" } } };

beforeEach(() => resetAddressLookupState());

test("no credentials: the lookup says it is not available and asks nobody", async () => {
  const s = stub([TOKEN, FOUND]);
  assert.deepEqual(await lookupAddress({ q: "123 Main St", city: "Raleigh", state: "NC" }, { fetch: s.fetch, env: {}, now: () => T0 }), { available: false });
  assert.deepEqual(await lookupAddress({ q: "123 Main St", city: "Raleigh", state: "NC" }, { fetch: s.fetch, env: { USPS_CLIENT_ID: "x" }, now: () => T0 }), { available: false });
  assert.equal(s.calls.length, 0);
});

test("a full address is asked of the post office with a bearer token, and the answer comes back in its spelling, title-cased", async () => {
  const s = stub([TOKEN, FOUND]);
  const r = await lookupAddress({ q: "123 main st", city: "ral", state: "nc", zip: "" }, { fetch: s.fetch, env: ENV, now: () => T0 });
  assert.deepEqual(r, { available: true, suggestions: [{ street: "123 Main St", city: "Raleigh", state: "NC", zip: "27601", formatted: "123 Main St, Raleigh, NC 27601" }] });
  assert.equal(s.calls.length, 2);
  const [tok, adr] = s.calls as [Call, Call];
  assert.equal(tok.url, "https://apis.usps.com/oauth2/v3/token");
  assert.equal(tok.method, "POST");
  assert.deepEqual(JSON.parse(tok.body!), { grant_type: "client_credentials", client_id: "test-id", client_secret: "test-secret" });
  const u = new URL(adr.url);
  assert.equal(`${u.origin}${u.pathname}`, "https://apis.usps.com/addresses/v3/address");
  assert.deepEqual(Object.fromEntries(u.searchParams), { streetAddress: "123 main st", city: "ral", state: "NC" });
  assert.equal(adr.headers["authorization"], "Bearer tok-1");
});

test("what is asked: a street with a state and a ZIP is enough; the whole line typed into the street box is split; an apartment goes in its own part", async () => {
  const s = stub([TOKEN, FOUND, FOUND, FOUND]);
  const ask = (input: Parameters<typeof lookupAddress>[0]) => lookupAddress(input, { fetch: s.fetch, env: ENV, now: () => T0 });
  await ask({ q: "123 Main St", state: "NC", zip: "27601-1234" });
  assert.deepEqual(Object.fromEntries(new URL(s.calls[1]!.url).searchParams), { streetAddress: "123 Main St", state: "NC", ZIPCode: "27601" });
  await ask({ q: "500 E Davie St, Raleigh, NC 27601" });
  assert.deepEqual(Object.fromEntries(new URL(s.calls[2]!.url).searchParams), { streetAddress: "500 E Davie St", city: "Raleigh", state: "NC", ZIPCode: "27601" });
  await ask({ q: "77 Oak Ave Apt 4B", city: "Cary", state: "NC" });
  assert.deepEqual(Object.fromEntries(new URL(s.calls[3]!.url).searchParams), { streetAddress: "77 Oak Ave", secondaryAddress: "Apt 4B", city: "Cary", state: "NC" });
});

test("not enough typed yet (no state, no city or ZIP, a short street) is 'incomplete': nothing is asked and nothing is said", async () => {
  const s = stub([TOKEN, FOUND]);
  const ask = (input: Parameters<typeof lookupAddress>[0]) => lookupAddress(input, { fetch: s.fetch, env: ENV, now: () => T0 });
  const incomplete = { available: true, suggestions: [], incomplete: true };
  assert.deepEqual(await ask({ q: "123 Main St" }), incomplete);
  assert.deepEqual(await ask({ q: "123 Main St", city: "Raleigh" }), incomplete);
  assert.deepEqual(await ask({ q: "123 Main St", state: "NC" }), incomplete);
  assert.deepEqual(await ask({ q: "12 M", city: "Raleigh", state: "NC" }), incomplete);
  assert.deepEqual(await ask({ q: "123 Main St", city: "Raleigh", state: "ZZ" }), incomplete, "not a state");
  assert.equal(s.calls.length, 0);
});

test("the post office has no such address (404 or 400): an answer with no suggestions, and the service stays available", async () => {
  for (const status of [404, 400]) {
    resetAddressLookupState();
    const s = stub([TOKEN, { status }]);
    assert.deepEqual(await lookupAddress({ q: "9999 Nowhere Rd", city: "Raleigh", state: "NC" }, { fetch: s.fetch, env: ENV, now: () => T0 }), { available: true, suggestions: [] }, String(status));
  }
  // an answer that is missing parts of the address is not trusted either
  const s = stub([TOKEN, { status: 200, json: { address: { streetAddress: "1 A ST", city: "X", state: "NC" } } }]);
  assert.deepEqual(await lookupAddress({ q: "1 A St", city: "X", state: "NC" }, { fetch: s.fetch, env: ENV, now: () => T0 }), { available: true, suggestions: [] });
});

test("any failure means 'not available' (take it as typed): a refused token, a 429, a 500, a network error, a token with no access_token", async () => {
  const cases: Array<Array<{ status: number; json?: unknown } | Error>> = [
    [{ status: 401 }],
    [TOKEN, { status: 429 }],
    [TOKEN, { status: 500 }],
    [new Error("network down")],
    [TOKEN, new Error("timeout")],
    [{ status: 200, json: {} }],
  ];
  for (const answers of cases) {
    resetAddressLookupState();
    const s = stub(answers);
    assert.deepEqual(await lookupAddress({ q: "123 Main St", city: "Raleigh", state: "NC" }, { fetch: s.fetch, env: ENV, now: () => T0 }), { available: false });
  }
});

test("a stale token (401 on the address call) is renewed once and the question asked again; the token is reused until it is nearly out", async () => {
  const s = stub([TOKEN, { status: 401 }, { status: 200, json: { access_token: "tok-2", expires_in: 3600 } }, FOUND]);
  const r = await lookupAddress({ q: "123 Main St", city: "Raleigh", state: "NC" }, { fetch: s.fetch, env: ENV, now: () => T0 });
  assert.equal(r.available, true);
  assert.equal(s.calls.length, 4);
  assert.equal(s.calls[3]!.headers["authorization"], "Bearer tok-2");
  // a second, different question reuses the token (no new token call)
  const s2 = stub([FOUND]);
  await lookupAddress({ q: "124 Main St", city: "Raleigh", state: "NC" }, { fetch: s2.fetch, env: ENV, now: () => T0 + 60_000 });
  assert.equal(s2.calls.length, 1);
  assert.ok(!s2.calls.some((c) => c.url.includes("/oauth2/")));
});

test("the same question is answered from memory for an hour; the free allowance per hour stops the calls and then says 'not available'", async () => {
  const s = stub([TOKEN, FOUND, FOUND, { status: 200, json: { access_token: "tok-3", expires_in: 3600 } }, FOUND]);
  const ask = (q: string, at = T0) => lookupAddress({ q, city: "Raleigh", state: "NC" }, { fetch: s.fetch, env: { ...ENV, USPS_HOURLY_CAP: "2" }, now: () => at });
  await ask("100 Main St"); await ask("100 MAIN st");
  assert.equal(s.calls.length, 2, "token + one address call: the repeat came from memory");
  await ask("101 Main St");
  assert.equal(s.calls.length, 3);
  assert.deepEqual(await ask("102 Main St"), { available: false }, "over the allowance");
  assert.equal(s.calls.length, 3);
  assert.equal((await ask("102 Main St", T0 + 61 * 60_000)).available, true, "the next hour starts fresh");
});

test("the helpers: title-casing keeps directions and ordinals, the line is split, a state set is the US", () => {
  assert.equal(titleCaseAddress("123 NE 5TH AVE"), "123 NE 5th Ave");
  assert.equal(titleCaseAddress("PO BOX 12"), "PO Box 12");
  assert.equal(titleCaseAddress("o'brien-smith st"), "O'Brien-Smith St");
  assert.equal(formatAddress({ street: "1 A St", city: "Cary", state: "NC", zip: "27511" }), "1 A St, Cary, NC 27511");
  assert.deepEqual(splitOneLine("1 A St"), { street: "1 A St" });
  assert.deepEqual(splitOneLine("1 A St, Cary, NC 27511"), { street: "1 A St", city: "Cary", state: "NC", zip: "27511" });
  assert.deepEqual(splitOneLine("1 A St, NC"), { street: "1 A St", state: "NC" });
  assert.deepEqual(splitOneLine("1 A St, Cary, 27511"), { street: "1 A St", city: "Cary", zip: "27511" });
  assert.ok(US_STATES.has("NC") && US_STATES.has("DC") && US_STATES.has("PR") && !US_STATES.has("ZZ"));
});

test("a street and a ZIP are enough (Mark 2026-10-26): the ZIP's state comes from the post office first, then the address is asked", async () => {
  const s = stub([TOKEN, { status: 200, json: { city: "RALEIGH", state: "NC", ZIPCode: "27601" } }, FOUND]);
  const r = await lookupAddress({ q: "123 main st", zip: "27601" }, { fetch: s.fetch, env: ENV, now: () => T0 });
  assert.deepEqual(r, { available: true, suggestions: [{ street: "123 Main St", city: "Raleigh", state: "NC", zip: "27601", formatted: "123 Main St, Raleigh, NC 27601" }] });
  assert.match(s.calls[1]!.url, /\/addresses\/v3\/city-state\?ZIPCode=27601$/);
  const addr = new URL(s.calls[2]!.url);
  assert.equal(addr.searchParams.get("state"), "NC");
  assert.equal(addr.searchParams.get("ZIPCode"), "27601");
  // a ZIP the post office does not know: no suggestion, and the address is not asked
  resetAddressLookupState();
  const n = stub([TOKEN, { status: 404 }]);
  assert.deepEqual(await lookupAddress({ q: "123 main st", zip: "00000" }, { fetch: n.fetch, env: ENV, now: () => T0 }), { available: true, suggestions: [] });
  assert.equal(n.calls.length, 2);
});
