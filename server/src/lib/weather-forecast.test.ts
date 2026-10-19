// weather-forecast.test.ts — one place's Open-Meteo forecast: a timeout is retried (each try has its own clock),
// and when Open-Meteo will not answer the last good forecast — this run's, or the one saved before a restart —
// stands in, flagged. Everything injected: the fetch, the clock, the disk.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadForecast, makeForecastService, FORECASTS_STORE_KEY, FORECAST_LAST_GOOD_MAX_MS } from "./weather-forecast";
import type { CruiseLocation } from "./ports";

const AMSTERDAM: CruiseLocation = { slug: "amsterdam", name: "Amsterdam, Netherlands", type: "embarkation", lat: 52.3676, lon: 4.9041 };
const MIAMI: CruiseLocation = { slug: "miami", name: "Miami, Florida", type: "embarkation", featured: true, lat: 25.7732, lon: -80.1608 };
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
const refusal = (status: number) => ({ ok: false, status, headers: { get: () => null }, json: async () => ({}) }) as unknown as Response;
const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

function fakeDisk() {
  const files = new Map<string, unknown>();
  return {
    read: async (key: string) => (files.has(key) ? JSON.parse(JSON.stringify(files.get(key))) : null),
    write: async (key: string, payload: unknown) => { files.set(key, JSON.parse(JSON.stringify(payload))); return true; },
    files,
  };
}

describe("loadForecast: every try at Open-Meteo has its own timeout", () => {
  it("a first try that times out is retried and the second try gets its own, unexpired clock", async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    // AbortSignal.timeout's own timer is unref'd, so a hung connection alone would not keep the test process alive
    const keepAlive = setTimeout(() => {}, 2000);
    const fetchImpl = (_u: string, init?: RequestInit) => {
      calls++;
      signals.push(init!.signal!);
      if (calls === 1) {
        // a hung connection: nothing comes back until this try's own clock runs out
        return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
      }
      assert.equal(init!.signal!.aborted, false, "the second try must not start already aborted");
      return Promise.resolve(openMeteo(77));
    };
    const f = await loadForecast(AMSTERDAM, { fetchImpl, sleep: noSleep, attemptMs: 15 });
    assert.equal(f.temp, 77);
    assert.equal(calls, 2);
    assert.notEqual(signals[0], signals[1], "one signal per try");
    clearTimeout(keepAlive);
  });

  it("a timeout is retried once, not more, and then the failure is the timeout", async () => {
    let calls = 0;
    await assert.rejects(
      loadForecast(AMSTERDAM, { fetchImpl: async () => { calls++; throw timeoutError(); }, sleep: noSleep }),
      /aborted due to timeout/,
    );
    assert.equal(calls, 2);
  });

  it("a 429 or 5xx still gets three tries", async () => {
    let calls = 0;
    await assert.rejects(loadForecast(AMSTERDAM, { fetchImpl: async () => { calls++; return refusal(503); }, sleep: noSleep }), /Weather fetch failed for amsterdam \(503\)/);
    assert.equal(calls, 3);
  });
});

describe("fetchForecastOrLastGood", () => {
  it("fresh answer: no stale flag, and the forecast is saved", async () => {
    const disk = fakeDisk(); const clock = { t: Date.parse("2026-10-19T12:00:00Z") };
    const svc = makeForecastService({ fetchImpl: async () => openMeteo(81), sleep: noSleep, now: () => clock.t, read: disk.read, write: disk.write });
    const got = await svc.fetchForecastOrLastGood(AMSTERDAM);
    assert.equal(got.staleSince, undefined);
    assert.equal(got.forecast.temp, 81);
    await svc.lastGood.flush();
    const saved = disk.files.get(FORECASTS_STORE_KEY) as { entries: Record<string, { at: number; value: { temp: number } }> };
    assert.equal(saved.entries["amsterdam"]?.value.temp, 81);
    assert.equal(saved.entries["amsterdam"]?.at, clock.t);
  });

  it("this run's copy (under six hours) stands in for a failed refresh, flagged with the time it was good", async () => {
    const clock = { t: Date.parse("2026-10-19T12:00:00Z") };
    let up = true;
    const svc = makeForecastService({ fetchImpl: async () => { if (!up) throw timeoutError(); return openMeteo(81); }, sleep: noSleep, now: () => clock.t, read: fakeDisk().read, write: fakeDisk().write });
    await svc.fetchForecastOrLastGood(MIAMI);
    up = false; clock.t += 30 * 60_000;
    const got = await svc.fetchForecastOrLastGood(MIAMI);
    assert.equal(got.forecast.temp, 81);
    assert.equal(got.staleSince, "2026-10-19T12:00:00.000Z");
  });

  it("AFTER A RESTART: nothing in memory, Open-Meteo times out — the forecast saved by the earlier run answers, flagged", async () => {
    const disk = fakeDisk(); const clock = { t: Date.parse("2026-10-19T08:00:00Z") };
    const run1 = makeForecastService({ fetchImpl: async () => openMeteo(79), sleep: noSleep, now: () => clock.t, read: disk.read, write: disk.write });
    await run1.fetchForecastOrLastGood(AMSTERDAM);
    await run1.lastGood.flush();

    clock.t += 9 * HOUR;                  // longer than the six hours the in-memory cache would ever have kept it
    let calls = 0;
    const run2 = makeForecastService({ fetchImpl: async () => { calls++; throw timeoutError(); }, sleep: noSleep, now: () => clock.t, read: disk.read, write: disk.write });
    const got = await run2.fetchForecastOrLastGood(AMSTERDAM);   // the very first request of the new process
    assert.equal(got.forecast.temp, 79);
    assert.equal(got.forecast.forecast.length, 10);
    assert.equal(got.staleSince, "2026-10-19T08:00:00.000Z");
    assert.equal(calls, 2, "it did try Open-Meteo (twice) before falling back");
  });

  it("a slow Open-Meteo does not hold a reader who has an earlier copy: answered from it at the budget, flagged; the fetch lands for the next reader", async () => {
    const clock = { t: Date.parse("2026-10-19T12:00:00Z") };
    let temp = 81, slowMs = 0;
    const fetchImpl = async () => { if (slowMs) await new Promise((r) => setTimeout(r, slowMs)); return openMeteo(temp); };
    const svc = makeForecastService({ fetchImpl, sleep: noSleep, now: () => clock.t, answerBudgetMs: 20, read: fakeDisk().read, write: fakeDisk().write });
    await svc.fetchForecastOrLastGood(MIAMI);
    clock.t += 11 * 60_000;               // past the ten minutes: a refresh is due
    temp = 90; slowMs = 150;
    const t0 = Date.now();
    const quick = await svc.fetchForecastOrLastGood(MIAMI);
    assert.ok(Date.now() - t0 < 120, "did not wait for the slow fetch");
    assert.equal(quick.forecast.temp, 81);
    assert.ok(quick.staleSince);
    await new Promise((r) => setTimeout(r, 300));
    const next = await svc.fetchForecastOrLastGood(MIAMI);
    assert.equal(next.forecast.temp, 90);
    assert.equal(next.staleSince, undefined);
  });

  it("nothing known about the place → the failure itself, so the route answers 500 as before", async () => {
    const svc = makeForecastService({ fetchImpl: async () => { throw timeoutError(); }, sleep: noSleep, read: fakeDisk().read, write: fakeDisk().write });
    await assert.rejects(svc.fetchForecastOrLastGood(AMSTERDAM), /aborted due to timeout/);
  });

  it("a saved forecast older than 48 hours is not used", async () => {
    const disk = fakeDisk(); const clock = { t: Date.parse("2026-10-19T08:00:00Z") };
    const run1 = makeForecastService({ fetchImpl: async () => openMeteo(79), sleep: noSleep, now: () => clock.t, read: disk.read, write: disk.write });
    await run1.fetchForecastOrLastGood(AMSTERDAM);
    await run1.lastGood.flush();
    clock.t += FORECAST_LAST_GOOD_MAX_MS + 1;
    const run2 = makeForecastService({ fetchImpl: async () => { throw timeoutError(); }, sleep: noSleep, now: () => clock.t, read: disk.read, write: disk.write });
    await assert.rejects(run2.fetchForecastOrLastGood(AMSTERDAM), /aborted due to timeout/);
  });

  it("a saved copy that cannot be read does not stop a fresh answer", async () => {
    const svc = makeForecastService({
      fetchImpl: async () => openMeteo(70), sleep: noSleep,
      read: async () => { throw new Error("supabase down"); }, write: async () => true,
    });
    const got = await svc.fetchForecastOrLastGood(MIAMI);
    assert.equal(got.forecast.temp, 70);
    assert.equal(got.staleSince, undefined);
  });

  it("plain fetchForecast (the group journey's call) keeps its old rule: the in-memory copy within six hours, never the saved one", async () => {
    const disk = fakeDisk(); const clock = { t: Date.parse("2026-10-19T08:00:00Z") };
    const run1 = makeForecastService({ fetchImpl: async () => openMeteo(79), sleep: noSleep, now: () => clock.t, read: disk.read, write: disk.write });
    await run1.fetchForecast(AMSTERDAM);
    await run1.lastGood.flush();
    clock.t += HOUR;
    const run2 = makeForecastService({ fetchImpl: async () => { throw timeoutError(); }, sleep: noSleep, now: () => clock.t, read: disk.read, write: disk.write });
    await assert.rejects(run2.fetchForecast(AMSTERDAM), /aborted due to timeout/);
  });
});
