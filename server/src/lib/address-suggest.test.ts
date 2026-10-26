// address-suggest.test.ts — the home-address type-ahead (Mark 2026-10-26), on a stubbed fetch.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fromSmarty, resetAddressSuggestState, suggestAddresses } from "./address-suggest";

const ENV = { SMARTY_AUTH_ID: "id-1", SMARTY_AUTH_TOKEN: "tok-1" };
const T0 = 1_800_000_000_000;
function stub(answers: Array<{ status: number; json?: unknown } | Error>) {
  const urls: string[] = [];
  let i = 0;
  const f = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const a = answers[Math.min(i++, answers.length - 1)]!;
    if (a instanceof Error) throw a;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json ?? {} } as Response;
  }) as typeof fetch;
  return { urls, fetch: f };
}
const HITS = { status: 200, json: { suggestions: [
  { street_line: "100 Goodsell Ct", secondary: "", city: "Fuquay Varina", state: "NC", zipcode: "27526", entries: 0 },
  { street_line: "100 Goodsell Ct", secondary: "", city: "Fuquay Varina", state: "NC", zipcode: "27526", entries: 0 },
  { street_line: "100 Goodwin St", secondary: "Apt 2", city: "Raleigh", state: "NC", zipcode: "27601", entries: 1 },
  { street_line: "", city: "Nowhere", state: "NC", zipcode: "27601" },
] } };

beforeEach(() => resetAddressSuggestState());

test("no keys: not available, and nobody is asked", async () => {
  const s = stub([HITS]);
  assert.deepEqual(await suggestAddresses("100 Good", { fetch: s.fetch, env: {}, now: () => T0 }), { available: false });
  assert.equal(s.urls.length, 0);
});

test("as the street is typed, whole addresses come back in the post office's spelling, duplicates and broken ones left out", async () => {
  const s = stub([HITS]);
  const r = await suggestAddresses("100 good", { fetch: s.fetch, env: ENV, now: () => T0 });
  assert.deepEqual(r, { available: true, suggestions: [
    { street: "100 Goodsell Ct", city: "Fuquay Varina", state: "NC", zip: "27526", formatted: "100 Goodsell Ct, Fuquay Varina, NC 27526" },
    { street: "100 Goodwin St Apt 2", city: "Raleigh", state: "NC", zip: "27601", formatted: "100 Goodwin St Apt 2, Raleigh, NC 27601" },
  ] });
  const u = new URL(s.urls[0]!);
  assert.equal(u.hostname, "us-autocomplete-pro.api.smarty.com");
  assert.equal(u.searchParams.get("search"), "100 good");
  assert.equal(u.searchParams.get("auth-id"), "id-1");
  // the same keystrokes again are answered from memory
  await suggestAddresses("100 GOOD", { fetch: s.fetch, env: ENV, now: () => T0 + 1000 });
  assert.equal(s.urls.length, 1);
});

test("too little typed asks nobody; any failure means 'not available' so the page falls back to the post office check", async () => {
  const s = stub([HITS]);
  assert.deepEqual(await suggestAddresses("10 ", { fetch: s.fetch, env: ENV, now: () => T0 }), { available: true, suggestions: [] });
  assert.equal(s.urls.length, 0);
  for (const bad of [{ status: 401 }, { status: 429 }, { status: 500 }, new Error("network")]) {
    resetAddressSuggestState();
    assert.deepEqual(await suggestAddresses("100 Goodsell", { fetch: stub([bad]).fetch, env: ENV, now: () => T0 }), { available: false });
  }
  assert.equal(fromSmarty({ street_line: "1 Main St", city: "Raleigh", state: "North Carolina", zipcode: "27601" }), null);
});
