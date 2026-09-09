// weather-voice.test.ts — the forecast synopsis in Mark's voice: cached per place and
// language, banned words rewritten once then dropped, model failure = empty string.
import { test, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import { weatherSynopsis, hasBanned, _resetCache, TTL_MS, BANNED } from "./weather-voice";

const loc = { slug: "nassau", name: "Nassau", type: "destination" };
const rows = [{ day: "2026-09-10", high: 88, low: 78, weatherCode: 80 }, { day: "2026-09-11", high: 87, low: 77, weatherCode: 2 }];

beforeEach(() => _resetCache());

test("prompt carries Mark's voice rules and the forecast table, and the result is cached per place+lang", async () => {
  const calls: { system: string; user: string }[] = [];
  const gen = async (a: { system: string; user: string }) => { calls.push(a); return "Pack the light rain jacket and don't cancel anything."; };
  const a = await weatherSynopsis(loc, rows, "en", gen);
  const b = await weatherSynopsis(loc, rows, "en", gen);
  assert.equal(a, b);
  assert.equal(calls.length, 1, "second call must hit the cache");
  assert.match(calls[0]!.system, /AS Mark Millham/);
  assert.match(calls[0]!.system, /Do NOT recite the daily highs and lows/);
  assert.match(calls[0]!.system, /Never open with the month/);
  assert.match(calls[0]!.user, /Thu, Sep 10: high 88°F, low 78°F, light showers/);
  assert.doesNotMatch(calls[0]!.user, /Day 1/);
  assert.match(calls[0]!.user, /port of call/);
  await weatherSynopsis(loc, rows, "es", gen);
  assert.equal(calls.length, 2, "Spanish is its own cache entry");
  assert.match(calls[1]!.system, /COMO Mark Millham/);
});

test("cache expires after TTL", async () => {
  let t = 1_000_000; let n = 0;
  const gen = async () => { n++; return "Shorts and a hat; the showers pass by lunch."; };
  await weatherSynopsis(loc, rows, "en", gen, () => t);
  t += TTL_MS - 1; await weatherSynopsis(loc, rows, "en", gen, () => t);
  assert.equal(n, 1);
  t += 2; await weatherSynopsis(loc, rows, "en", gen, () => t);
  assert.equal(n, 2);
});

test("a banned word triggers one rewrite; a second offence drops the synopsis and caches nothing", async () => {
  let n = 0;
  const gen = async (a: { user: string }) => { n++; return n === 1 ? "Actually, bring a jacket." : "Bring a jacket; the evenings turn." + (a.user.includes("Rewrite") ? "" : "x"); };
  const out = await weatherSynopsis(loc, rows, "en", gen);
  assert.equal(out, "Bring a jacket; the evenings turn.");
  assert.equal(n, 2);
  _resetCache();
  let m = 0;
  const stubborn = async () => { m++; return "Navigating the showers is thrilling."; };
  assert.equal(await weatherSynopsis(loc, rows, "en", stubborn), "");
  assert.equal(m, 2);
  assert.equal(await weatherSynopsis(loc, rows, "en", stubborn), "");
  assert.equal(m, 4, "an empty result is never cached");
});

test("model failure degrades to an empty synopsis", async () => {
  const gen = async () => { throw new Error("boom"); };
  assert.equal(await weatherSynopsis(loc, rows, "en", gen), "");
});

test("hasBanned covers Mark's list", () => {
  assert.equal(hasBanned("Cruise smarter."), null);
  assert.equal(hasBanned("This is actually fine"), "actually");
  assert.ok(BANNED.includes("cheaper"));
});
