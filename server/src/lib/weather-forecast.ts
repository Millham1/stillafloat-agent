// weather-forecast.ts — the Open-Meteo daily forecast for one place, shared by the weather route
// (routes/weather.ts) and the group journey's five-day weather report (lib/group-journey-*.ts).
//
// Moved out of the route unchanged (2026-10-17) so a second caller does not grow a second copy: one upstream
// call per place per 10 minutes however many callers ask, shared while in flight, and — if Open-Meteo refuses a
// refresh — the last good forecast for up to 6 hours more (lib/upstream.ts).

import type { CruiseLocation } from "./ports";
import { fetchWithBackoff, loaderCache } from "./upstream";

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

// One upstream call per place per 10 minutes however many visitors ask, shared while in flight, and — if
// Open-Meteo refuses a refresh — the last good forecast for up to 6 hours more (lib/upstream.ts).
const forecastCache = loaderCache<LoadedForecast>({ ttlMs: 10 * 60_000, staleMs: 6 * 3_600_000 });
export function _resetForecastCache() { forecastCache.clear(); }
export function fetchForecast(loc: CruiseLocation) {
  return forecastCache.get(loc.slug, () => loadForecast(loc));
}

export async function loadForecast(loc: CruiseLocation) {
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
  // waiting as the API asks, with a timeout on each attempt.
  const res = await fetchWithBackoff((u, init) => fetch(u, init), url.toString(), { signal: AbortSignal.timeout(8000) }, { attempts: 3 });
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
