// weather.test.ts — coordinate visits to /api/weather resolve to a known port when one is close
// (so Bermuda-by-coords shares Bermuda-by-slug's synopsis cache), else to an ad-hoc location.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveCoords, heroImageUrl, _resetHero, HERO_TTL_MS, HERO_HOURLY_BUDGET } from "./weather";

test("coords near a known port snap to it", () => {
  const loc = resolveCoords("32.33022", "-64.74003", "Bermuda");
  assert.equal(loc?.slug, "bermuda");
  assert.equal(loc?.name, "Bermuda");
});

test("coords with no port nearby become an ad-hoc destination with a sanitized name", () => {
  const loc = resolveCoords(48.8566, 2.3522, "Paris <script>alert(1)</script>");
  assert.equal(loc?.slug, "ll:48.86,2.35");
  assert.equal(loc?.type, "destination");
  assert.equal(loc?.name, "Paris scriptalert(1)script");
});

test("a missing name falls back to the coordinates", () => {
  assert.equal(resolveCoords(10, 10, "")?.name, "10.00, 10.00");
});

test("garbage or out-of-range coordinates are rejected", () => {
  assert.equal(resolveCoords("x", "1", "a"), null);
  assert.equal(resolveCoords(91, 0, "a"), null);
  assert.equal(resolveCoords(0, 181, "a"), null);
});

// ── hero photo: key stays on the server, one lookup per place, bounded upstream calls ──
const pexels = (landscape: string, calls: { n: number; auth?: string }) =>
  async (_url: string, init: { headers: Record<string, string> }) => {
    calls.n++; calls.auth = init.headers["authorization"];
    return { ok: true, json: async () => ({ photos: [{ src: { landscape } }] }) };
  };
const IMG = "https://images.pexels.com/photos/1/pexels-photo-1.jpeg?auto=compress&cs=tinysrgb&h=627&w=1200";

test("hero: sends the server key, returns the Pexels image, and looks a place up once", async () => {
  _resetHero();
  const calls = { n: 0 } as { n: number; auth?: string };
  assert.equal(await heroImageUrl("Bermuda", "k", pexels(IMG, calls)), IMG);
  assert.equal(await heroImageUrl("bermuda", "k", pexels(IMG, calls)), IMG);
  assert.equal(calls.n, 1);
  assert.equal(calls.auth, "k");
});

test("hero: the cached photo is looked up again after a week", async () => {
  _resetHero();
  const calls = { n: 0 }; let t = 1_000_000;
  await heroImageUrl("Nassau", "k", pexels(IMG, calls), () => t);
  t += HERO_TTL_MS + 1;
  await heroImageUrl("Nassau", "k", pexels(IMG, calls), () => t);
  assert.equal(calls.n, 2);
});

test("hero: no key, no name, or a non-Pexels address gives no photo", async () => {
  _resetHero();
  const calls = { n: 0 };
  assert.equal(await heroImageUrl("Bermuda", "", pexels(IMG, calls)), "");
  assert.equal(await heroImageUrl("<>", "k", pexels(IMG, calls)), "");
  assert.equal(calls.n, 0);
  assert.equal(await heroImageUrl("Cozumel", "k", pexels('https://evil.example/x.jpg") , url("y', calls)), "");
});

test("hero: upstream calls stop at the hourly budget and resume the next hour", async () => {
  _resetHero();
  const calls = { n: 0 }; let t = 5_000_000;
  for (let i = 0; i < HERO_HOURLY_BUDGET + 10; i++) await heroImageUrl(`Place ${i}`, "k", pexels(IMG, calls), () => t);
  assert.equal(calls.n, HERO_HOURLY_BUDGET);
  t += 60 * 60 * 1000;
  assert.equal(await heroImageUrl("Fresh place", "k", pexels(IMG, calls), () => t), IMG);
});

test("hero: a failed lookup is not cached", async () => {
  _resetHero();
  let n = 0;
  const failing = async () => { n++; return { ok: false, json: async () => ({}) }; };
  await heroImageUrl("Roatan", "k", failing); await heroImageUrl("Roatan", "k", failing);
  assert.equal(n, 2);
});
