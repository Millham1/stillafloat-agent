// weather-tiles.test.ts — the homepage weather tiles survive a server restart.
//
// The incident (2026-10-17 21:27Z, 2026-10-19 14:44Z): right after a deploy restart the process held no good
// payload, so one slow or refused Open-Meteo answer became an empty tile list. Here "a restart" is a NEW pair of
// services over the SAME fake disk; Open-Meteo is a fake fetch that answers, times out, or is slow.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTilesService, fillThinLists, TILES_STORE_KEY, TILES_FRESH_MS, TILES_PATCHED_MS } from "./weather-tiles";
import { makeForecastService, FORECASTS_STORE_KEY } from "./weather-forecast";

const MIN = 60_000;
const HOUR = 3_600_000;
const noSleep = async () => {};

const days = Array.from({ length: 10 }, (_, i) => `2026-10-${String(19 + i).padStart(2, "0")}`);
const openMeteo = (temp = 80) => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => ({
    current: { temperature_2m: temp, weather_code: 1 },
    daily: { time: days, weather_code: days.map(() => 2), temperature_2m_max: days.map(() => temp + 4), temperature_2m_min: days.map(() => temp - 6) },
  }),
}) as unknown as Response;
const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

function fakeDisk(opts: { readDelayMs?: number } = {}) {
  const files = new Map<string, unknown>();
  return {
    read: async (key: string) => {
      if (opts.readDelayMs) await new Promise((r) => setTimeout(r, opts.readDelayMs));
      return files.has(key) ? JSON.parse(JSON.stringify(files.get(key))) : null;
    },
    write: async (key: string, payload: unknown) => { files.set(key, JSON.parse(JSON.stringify(payload))); return true; },
    files,
  };
}
type Disk = ReturnType<typeof fakeDisk>;
type Clock = { t: number };
type Weather = { temp?: number; calls: number; slowMs?: number; failSlugs?: Set<string> };

/** One run of the server: its own memory, the shared disk. `air` is what Open-Meteo is doing, changeable while it runs. */
function boot(disk: Disk, clock: Clock, air: Weather, extra: { answerBudgetMs?: number } = {}) {
  const fetchImpl = async (url: string) => {
    air.calls++;
    if (air.slowMs) await new Promise((r) => setTimeout(r, air.slowMs));
    const lat = new URL(url).searchParams.get("latitude");
    if (air.temp === undefined) throw timeoutError();
    // fail by place: Miami is latitude 25.7732
    if (air.failSlugs?.has("miami") && lat === "25.7732") throw timeoutError();
    return openMeteo(air.temp);
  };
  const forecasts = makeForecastService({ fetchImpl, sleep: noSleep, now: () => clock.t, read: disk.read, write: disk.write });
  const tiles = makeTilesService({ forecasts, now: () => clock.t, read: disk.read, write: disk.write, answerBudgetMs: extra.answerBudgetMs ?? 2000 });
  const flush = async () => { await tiles.flush(); await forecasts.lastGood.flush(); };
  return { forecasts, tiles, flush };
}

const START = Date.parse("2026-10-19T08:00:00Z");

describe("a restart with Open-Meteo failing", () => {
  it("the tiles come from the saved payload — 12 departure ports and 12 destinations, flagged stale, not empty", async () => {
    const disk = fakeDisk(); const clock = { t: START };
    const run1 = boot(disk, clock, { temp: 80, calls: 0 });
    const first = await run1.tiles.getTiles();
    assert.equal(first.settled, true);
    assert.equal(first.payload.embarkation.length, 12);
    assert.equal(first.payload.destinations.length, 12);
    assert.equal(first.payload.stale, undefined, "a fully fresh payload carries no stale flag");
    await run1.flush();

    // deploy: new process, three hours later, Open-Meteo times out for everything
    clock.t += 3 * HOUR;
    const air: Weather = { temp: undefined, calls: 0 };
    const run2 = boot(disk, clock, air);
    const second = await run2.tiles.getTiles();       // the very first request, no warm-up, no priming
    assert.equal(second.payload.embarkation.length, 12);
    assert.equal(second.payload.destinations.length, 12);
    assert.equal(second.payload.stale, true);
    assert.equal(second.settled, false);
    assert.ok(second.payload.embarkation.some((c) => c.slug === "miami"), "Miami is on the page");
    assert.equal(second.payload.generatedAt, new Date(clock.t).toISOString(), "assembled now, from the earlier copies — the stale flag says they are earlier");
    assert.ok((second.payload.allEmbarkationPorts as unknown[]).length >= 20, "the port lists are still the code's own");
    assert.ok(air.calls > 0, "Open-Meteo was tried");
  });

  it("with only the saved TILES payload (no per-place copies) the thin lists are topped up from it", async () => {
    const disk = fakeDisk(); const clock = { t: START };
    const run1 = boot(disk, clock, { temp: 80, calls: 0 });
    await run1.tiles.getTiles();
    await run1.flush();
    disk.files.delete(FORECASTS_STORE_KEY);
    clock.t += HOUR;
    const run2 = boot(disk, clock, { temp: undefined, calls: 0 });
    const got = await run2.tiles.getTiles();
    assert.equal(got.payload.embarkation.length, 12);
    assert.equal(got.payload.destinations.length, 12);
    assert.equal(got.payload.stale, true);
  });

  it("the saved copy is in memory before the first request is answered, even when the read is slow", async () => {
    const quick = fakeDisk(); const clock = { t: START };
    const run1 = boot(quick, clock, { temp: 80, calls: 0 });
    await run1.tiles.getTiles();
    await run1.flush();

    const slow = fakeDisk({ readDelayMs: 80 });
    for (const [k, v] of quick.files) slow.files.set(k, v);
    clock.t += HOUR;
    const run2 = boot(slow, clock, { temp: undefined, calls: 0 });
    const got = await run2.tiles.getTiles();          // arrives while the saved copy is still being read
    assert.equal(got.payload.embarkation.length, 12);
  });

  it("nothing saved and Open-Meteo failing: what came back is sent (empty), not cached, and the next request builds again", async () => {
    const disk = fakeDisk(); const clock = { t: START };
    const air: Weather = { temp: undefined, calls: 0 };
    const run = boot(disk, clock, air);
    const bad = await run.tiles.getTiles();
    assert.deepEqual(bad.payload.embarkation, []);
    assert.deepEqual(bad.payload.destinations, []);
    assert.equal(bad.settled, false);
    await run.flush();
    assert.equal(disk.files.has(TILES_STORE_KEY), false, "nothing is saved from a failed build");
    air.temp = 82;                                    // Open-Meteo is back
    const good = await run.tiles.getTiles();
    assert.equal(good.payload.embarkation.length, 12);
    assert.equal(good.settled, true);
  });

  it("a saved payload the current code cannot read is ignored", async () => {
    const disk = fakeDisk(); const clock = { t: START };
    disk.files.set(TILES_STORE_KEY, { savedAt: "x", entries: { tiles: { at: START, value: { generatedAt: "x", embarkation: "nope", destinations: [] } } } });
    const run = boot(disk, clock, { temp: 80, calls: 0 });
    const got = await run.tiles.getTiles();           // builds fresh instead
    assert.equal(got.payload.embarkation.length, 12);
    assert.equal(got.settled, true);
  });
});

describe("what is saved", () => {
  it("a fully fresh build is saved (cards and build time, not the port lists); a build with earlier copies in it is not", async () => {
    const disk = fakeDisk(); const clock = { t: START };
    const run1 = boot(disk, clock, { temp: 80, calls: 0 });
    const fresh = await run1.tiles.getTiles();
    await run1.flush();
    const saved1 = disk.files.get(TILES_STORE_KEY) as { entries: { tiles: { at: number; value: Record<string, unknown> } } };
    assert.equal(saved1.entries.tiles.at, START);
    assert.equal(saved1.entries.tiles.value["generatedAt"], fresh.payload.generatedAt);
    assert.equal((saved1.entries.tiles.value["embarkation"] as unknown[]).length, 12);
    assert.equal("allEmbarkationPorts" in saved1.entries.tiles.value, false);

    clock.t += 2 * HOUR;
    const run2 = boot(disk, clock, { temp: undefined, calls: 0 });
    await run2.tiles.getTiles();                      // stale answer
    await run2.flush();
    const saved2 = disk.files.get(TILES_STORE_KEY) as typeof saved1;
    assert.equal(saved2.entries.tiles.at, START, "the saved payload is still the last FULLY fresh one");
  });
});

describe("a place that fails shows its own last good forecast, and the page retries soon", () => {
  it("Miami fails, the other 23 are fine: Miami is still a tile (its earlier copy), the payload is flagged and cached for 3 minutes only", async () => {
    const disk = fakeDisk(); const clock = { t: START };
    const run1 = boot(disk, clock, { temp: 80, calls: 0 });
    await run1.tiles.getTiles();
    await run1.flush();

    clock.t += 2 * HOUR;
    const air: Weather = { temp: 85, calls: 0, failSlugs: new Set(["miami"]) };
    const run2 = boot(disk, clock, air);
    const a = await run2.tiles.getTiles();
    const miami = a.payload.embarkation.find((c) => c.slug === "miami");
    assert.ok(miami, "the 2026-10-17 homepage had no Miami tile");
    assert.equal(miami.temp, 80, "Miami's earlier copy");
    assert.equal(a.payload.embarkation.find((c) => c.slug === "fort-lauderdale")?.temp, 85, "the others are fresh");
    assert.equal(a.payload.stale, true);
    assert.equal(a.settled, false);

    // inside 3 minutes the same payload; after, a rebuild finds Miami's air back
    const callsBefore = air.calls;
    clock.t += TILES_PATCHED_MS - 1;
    await run2.tiles.getTiles();
    assert.equal(air.calls, callsBefore, "served from memory inside the 3 minutes");
    clock.t += 2;
    air.failSlugs = undefined;
    // the in-memory forecast of the 23 is still fresh (10 minutes); Miami's refresh now answers
    const b = await run2.tiles.getTiles();
    assert.equal(b.payload.embarkation.find((c) => c.slug === "miami")?.temp, 85);
    assert.equal(b.settled, true);
    assert.equal(b.payload.stale, undefined);
  });
});

describe("caching, one build at a time, and the visitor's wait", () => {
  it("a fresh payload is served from memory for 15 minutes without asking Open-Meteo again", async () => {
    const disk = fakeDisk(); const clock = { t: START };
    const air: Weather = { temp: 80, calls: 0 };
    const run = boot(disk, clock, air);
    await run.tiles.getTiles();
    const calls = air.calls;
    clock.t += TILES_FRESH_MS - 1;
    const again = await run.tiles.getTiles();
    assert.equal(air.calls, calls);
    assert.equal(again.settled, true);
  });

  it("visitors arriving together share one build", async () => {
    const disk = fakeDisk(); const clock = { t: START };
    const air: Weather = { temp: 80, calls: 0, slowMs: 30 };
    const run = boot(disk, clock, air);
    const answers = await Promise.all([run.tiles.getTiles(), run.tiles.getTiles(), run.tiles.getTiles()]);
    assert.ok(answers.every((a) => a.payload.embarkation.length === 12));
    assert.equal(air.calls, 24, "24 places, once each");
  });

  it("a slow Open-Meteo does not hold a visitor when an earlier copy is known: they get it at once, flagged, and the rebuild lands for the next one", async () => {
    const disk = fakeDisk(); const clock = { t: START };
    const run1 = boot(disk, clock, { temp: 80, calls: 0 });
    await run1.tiles.getTiles();
    await run1.flush();

    clock.t += 2 * HOUR;
    const air: Weather = { temp: 90, calls: 0, slowMs: 250 };
    const run2 = boot(disk, clock, air, { answerBudgetMs: 30 });
    const t0 = Date.now();
    const quick = await run2.tiles.getTiles();
    assert.ok(Date.now() - t0 < 200, "answered inside the budget, not after the slow fetches");
    assert.equal(quick.payload.stale, true);
    assert.equal(quick.payload.embarkation.length, 12);
    assert.equal(quick.payload.embarkation.find((c) => c.slug === "miami")?.temp, 80);

    await new Promise((r) => setTimeout(r, 500));     // the rebuild finishes in the background
    const next = await run2.tiles.getTiles();
    assert.equal(next.settled, true);
    assert.equal(next.payload.embarkation.find((c) => c.slug === "miami")?.temp, 90);
  });
});

describe("boot warm-up", () => {
  it("builds once after a restart, so the first visitor finds a fresh payload; a second warm-up changes nothing", async () => {
    const disk = fakeDisk(); const clock = { t: START };
    const run1 = boot(disk, clock, { temp: 80, calls: 0 });
    await run1.tiles.getTiles();
    await run1.flush();

    clock.t += 3 * HOUR;
    const air: Weather = { temp: 91, calls: 0 };
    const run2 = boot(disk, clock, air);
    assert.equal(await run2.tiles.warm(), "weather tiles built fresh");
    const calls = air.calls;
    assert.equal(await run2.tiles.warm(), "weather tiles already fresh");
    const visitor = await run2.tiles.getTiles();
    assert.equal(air.calls, calls);
    assert.equal(visitor.settled, true);
    assert.equal(visitor.payload.embarkation.find((c) => c.slug === "miami")?.temp, 91);
    assert.equal(new Date(visitor.payload.generatedAt as string).getTime(), clock.t, "built just now, so the gate's freshness check passes");
  });

  it("with Open-Meteo down at boot the warm-up reports it and the saved tiles keep serving", async () => {
    const disk = fakeDisk(); const clock = { t: START };
    const run1 = boot(disk, clock, { temp: 80, calls: 0 });
    await run1.tiles.getTiles();
    await run1.flush();
    clock.t += 3 * HOUR;
    const run2 = boot(disk, clock, { temp: undefined, calls: 0 });
    assert.match(await run2.tiles.warm(), /earlier copies/);
    const visitor = await run2.tiles.getTiles();
    assert.equal(visitor.payload.embarkation.length, 12);
  });
});

describe("fillThinLists (unchanged rule, moved with the tiles)", () => {
  it("tops up a list short of six from the last good payload, same slugs never twice", () => {
    const fresh = [
      ...["a", "b", "c", "d", "e", "f"].map((slug) => ({ slug, type: "embarkation" })),
      ...["x", "y"].map((slug) => ({ slug, type: "destination" })),
    ];
    const cached = [{ slug: "x", type: "destination" }, { slug: "z", type: "destination" }, { slug: "w", type: "destination" }];
    const { cards, fullyFresh } = fillThinLists(fresh, cached);
    assert.equal(fullyFresh, false);
    assert.deepEqual(cards.filter((c) => c.type === "destination").map((c) => c.slug), ["x", "y", "z", "w"]);
  });
});
