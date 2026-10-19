// weather-forecast.ts — the Open-Meteo daily forecast for one place, shared by the weather route
// (routes/weather.ts) and the group journey's five-day weather report (lib/group-journey-*.ts).
//
// Moved out of the route unchanged (2026-10-17) so a second caller does not grow a second copy: one upstream
// call per place per 10 minutes however many callers ask, shared while in flight, and — if Open-Meteo refuses a
// refresh — the last good forecast for up to 6 hours more (lib/upstream.ts).
//
// 2026-10-19: those protections lived in memory, so a restart left none of them. Every good forecast is now also
// noted in a saved copy (lib/last-good-store.ts, platform_state "weather-forecasts-last-good", up to 48 hours old)
// that is read back on boot; fetchForecastOrLastGood answers from it, flagged, when Open-Meteo will not.

import type { CruiseLocation } from "./ports";
import { fetchWithBackoff, loaderCache, raceWithin } from "./upstream";
import { lastGoodStore, type LastGoodStoreOptions } from "./last-good-store";

export const WEATHER_DESC: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "rime fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "heavy showers",
  85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "severe thunderstorm",
};

export function weatherCodeDesc(code: number): string {
  return WEATHER_DESC[code] ?? "partly cloudy";
}

export function weatherEmoji(code: number): string {
  if (code === 0) return "☀️";
  if ([1, 2].includes(code)) return "🌤️";
  if (code === 3) return "☁️";
  if ([45, 48].includes(code)) return "🌫️";
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "🌧️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
  return "🌤️";
}

export function publicLocation(loc: CruiseLocation) {
  return { slug: loc.slug, name: loc.name, type: loc.type, lat: loc.lat, lon: loc.lon };
}

export type LoadedForecast = Awaited<ReturnType<typeof loadForecast>>;

/** One try at Open-Meteo gets this long. Each try has its OWN clock (see loadForecast). */
export const FORECAST_ATTEMPT_MS = 6000;
/** A forecast saved by an earlier run stands in for a failing Open-Meteo for up to this long. */
export const FORECAST_LAST_GOOD_MAX_MS = 48 * 3_600_000;
export const FORECASTS_STORE_KEY = "weather-forecasts-last-good";
/** A reader who finds an earlier copy of a forecast waits this long for a fresh one before being answered from the copy (the fetch carries on in the background). */
export const FORECAST_ANSWER_BUDGET_MS = 3000;

export interface LoadOptions {
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  attemptMs?: number;
}

export async function loadForecast(loc: CruiseLocation, opts: LoadOptions = {}) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(loc.lat));
  url.searchParams.set("longitude", String(loc.lon));
  url.searchParams.set("current", "temperature_2m,weather_code");
  url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "10");
  // open-meteo intermittently returns a response Node's HTTP parser rejects ("Parse Error: Data after
  // Connection: close") under parallel load, and answers 429 in bursts. fetchWithBackoff retries both,
  // waiting as the API asks. Every attempt gets its OWN timeout signal: one AbortSignal.timeout shared by
  // all attempts (the code until 2026-10-19) is already aborted when the second attempt starts, so a timeout
  // was never retried — it surfaced as "The operation was aborted due to timeout" after the first 8 seconds.
  // A timeout is retried ONCE (attemptsOnThrow: 2); a 429/5xx still gets three tries.
  const doFetch = opts.fetchImpl ?? ((u: string, init?: RequestInit) => fetch(u, init));
  const res = await fetchWithBackoff(
    (u, init) => doFetch(u, { ...init, signal: AbortSignal.timeout(opts.attemptMs ?? FORECAST_ATTEMPT_MS) }),
    url.toString(), undefined, { attempts: 3, attemptsOnThrow: 2, sleep: opts.sleep },
  );
  if (!res.ok) throw new Error(`Weather fetch failed for ${loc.slug} (${res.status})`);
  const data = await res.json() as {
    current: { temperature_2m: number; weather_code: number };
    daily: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[] };
  };
  return {
    ...publicLocation(loc),
    temp: Math.round(data.current.temperature_2m),
    emoji: weatherEmoji(data.current.weather_code),
    forecastUrl: `/forecast.html?place=${loc.slug}`,
    forecast: data.daily.time.map((day, i) => ({
      day,
      emoji: weatherEmoji(data.daily.weather_code[i]),
      weatherCode: data.daily.weather_code[i],
      high: Math.round(data.daily.temperature_2m_max[i]),
      low: Math.round(data.daily.temperature_2m_min[i]),
    })),
  };
}

/** A saved forecast the current code can still serve: a place, a temperature and a list of days. */
function isForecast(v: unknown): v is LoadedForecast {
  const f = v as Partial<LoadedForecast> | null;
  return !!f && typeof f === "object" && typeof f.slug === "string" && typeof f.name === "string"
    && typeof f.temp === "number" && Array.isArray(f.forecast) && f.forecast.length > 0;
}

/** A forecast, and — when it is an earlier copy standing in for a refresh that failed — when it was good. */
export interface ForecastAnswer { forecast: LoadedForecast; staleSince?: string }

export interface ForecastServiceDeps extends LoadOptions {
  now?: () => number;
  answerBudgetMs?: number;
  read?: LastGoodStoreOptions<LoadedForecast>["read"];
  write?: LastGoodStoreOptions<LoadedForecast>["write"];
}

/** The forecast fetcher with its caches and its saved copy. The server uses one (below); tests build their own. */
export function makeForecastService(deps: ForecastServiceDeps = {}) {
  const now = deps.now ?? Date.now;
  // One upstream call per place per 10 minutes however many visitors ask, shared while in flight, and — if
  // Open-Meteo refuses a refresh — the last good forecast for up to 6 hours more (lib/upstream.ts).
  const cache = loaderCache<LoadedForecast>({ ttlMs: 10 * 60_000, staleMs: 6 * 3_600_000, now });
  const lastGood = lastGoodStore<LoadedForecast>({
    key: FORECASTS_STORE_KEY, maxEntries: 200, maxAgeMs: FORECAST_LAST_GOOD_MAX_MS, saveDelayMs: 15_000,
    validate: isForecast, read: deps.read, write: deps.write, now,
  });
  async function loadAndRemember(loc: CruiseLocation): Promise<LoadedForecast> {
    const value = await loadForecast(loc, deps);
    lastGood.note(loc.slug, value);
    return value;
  }
  return {
    lastGood,
    reset() { cache.clear(); },
    /** The forecast for a place — fresh, or (silently) the in-memory copy up to 6 hours old when a refresh fails. Throws if neither exists. */
    fetchForecast(loc: CruiseLocation): Promise<LoadedForecast> {
      return cache.get(loc.slug, () => loadAndRemember(loc));
    },
    /**
     * Like fetchForecast, but never gives up while any earlier good forecast of the place is known — including
     * the one saved by an earlier run of the server — and SAYS so (staleSince) when it is not fresh. When an
     * earlier copy is known the caller waits at most `budgetMs` for a fresh forecast (the fetch carries on in the
     * background and is there for the next caller); with none known it waits for the fetch, as fetchForecast does.
     * Throws only when nothing is known.
     */
    async fetchForecastOrLastGood(loc: CruiseLocation, budgetMs: number = deps.answerBudgetMs ?? FORECAST_ANSWER_BUDGET_MS): Promise<ForecastAnswer> {
      await lastGood.ready();
      const attempt: Promise<ForecastAnswer> = cache.getMeta(loc.slug, () => loadAndRemember(loc))
        .then((got) => (got.stale ? { forecast: got.value, staleSince: new Date(got.at).toISOString() } : { forecast: got.value }));
      const earlier = (): ForecastAnswer | null => {
        const saved = lastGood.get(loc.slug);
        return saved ? { forecast: saved.value, staleSince: new Date(saved.at).toISOString() } : null;
      };
      if (!earlier()) return attempt;
      attempt.catch(() => {});   // an attempt nobody waits for any more must not become an unhandled rejection
      try {
        return (await raceWithin(attempt, budgetMs)) ?? earlier() ?? attempt;
      } catch (err) {
        const saved = earlier();
        if (saved) return saved;
        throw err;
      }
    },
  };
}

const forecasts = makeForecastService();
export const forecastService = forecasts;
export function _resetForecastCache() { forecasts.reset(); }
export function fetchForecast(loc: CruiseLocation) { return forecasts.fetchForecast(loc); }
export function fetchForecastOrLastGood(loc: CruiseLocation) { return forecasts.fetchForecastOrLastGood(loc); }
