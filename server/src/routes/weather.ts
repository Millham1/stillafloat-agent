import { Router, type IRouter, type Request, type Response } from "express";
import { CRUISE_LOCATIONS, type CruiseLocation } from "../lib/ports";

const router: IRouter = Router();


const WEATHER_DESC: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "rime fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "heavy showers",
  85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "severe thunderstorm",
};

function weatherCodeDesc(code: number): string {
  return WEATHER_DESC[code] ?? "partly cloudy";
}

async function generateSynopsis(
  locationName: string,
  forecast: { day: string; high: number; low: number; emoji: string; weatherCode: number }[]
): Promise<string> {
  const lines = forecast.map((d, i) =>
    `Day ${i + 1} (${d.day}): high ${d.high}°F, low ${d.low}°F, ${weatherCodeDesc(d.weatherCode)}`
  );
  const prompt =
    `Location: ${locationName}\n10-day forecast:\n${lines.join("\n")}\n\n` +
    `Write a 2–3 sentence weather synopsis for cruise travelers. ` +
    `Mention the temperature range (highs and lows), general sky conditions, and any precipitation patterns. ` +
    `Be specific and practical. Do not start with "The weather" — start with the city/location name.`;

  const oaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env["OPENAI_API_KEY"]}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You write concise, practical weather summaries for cruise travelers. Plain prose, no bullet points, no markdown." },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
      max_tokens: 120,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!oaiRes.ok) return "";
  const oaiData = (await oaiRes.json()) as { choices: { message: { content: string } }[] };
  return oaiData.choices[0]?.message?.content?.trim() ?? "";
}

function weatherEmoji(code: number): string {
  if (code === 0) return "☀️";
  if ([1, 2].includes(code)) return "🌤️";
  if (code === 3) return "☁️";
  if ([45, 48].includes(code)) return "🌫️";
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "🌧️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
  return "🌤️";
}

function publicLocation(loc: CruiseLocation) {
  return { slug: loc.slug, name: loc.name, type: loc.type, lat: loc.lat, lon: loc.lon };
}

function featuredByType(type: string, limit = 12) {
  const typed = CRUISE_LOCATIONS.filter((l) => l.type === type);
  const featured = typed.filter((l) => l.featured);
  const rest = typed.filter((l) => !l.featured);
  const combined = [...featured, ...rest];
  const seen = new Set<string>();
  return combined
    .filter((l) => { if (seen.has(l.slug)) return false; seen.add(l.slug); return true; })
    .slice(0, limit);
}

async function fetchForecast(loc: CruiseLocation) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(loc.lat));
  url.searchParams.set("longitude", String(loc.lon));
  url.searchParams.set("current", "temperature_2m,weather_code");
  url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "10");
  // open-meteo intermittently returns a response Node's HTTP parser rejects
  // ("Parse Error: Data after Connection: close") under parallel load. Retry
  // once, with a timeout, so a single transient hiccup doesn't kill the card.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
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
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// 15-minute in-memory cache for the all-ports response (avoids 24 parallel fetches on every page load)
let allPortsCache: { payload: object; expiresAt: number } | null = null;

router.get("/weather", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1800");
  try {
    const place = String(req.query.place || "").trim();

    if (place) {
      const loc = CRUISE_LOCATIONS.find((l) => l.slug === place);
      if (!loc) { res.status(404).json({ ok: false, error: "Destination not found" }); return; }
      const forecast = await fetchForecast(loc);
      const synopsis = await generateSynopsis(loc.name, forecast.forecast).catch(() => "");
      res.json({ ok: true, forecast: { ...forecast, synopsis } });
      return;
    }

    // ?list=true → return full alphabetized port lists, no weather fetch (fast)
    if (req.query.list === "true") {
      const allEmbarkationPorts = CRUISE_LOCATIONS
        .filter((l) => l.type === "embarkation")
        .map(publicLocation)
        .sort((a, b) => a.name.localeCompare(b.name));
      const allDestinations = CRUISE_LOCATIONS
        .filter((l) => l.type === "destination")
        .map(publicLocation)
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ ok: true, allEmbarkationPorts, allDestinations });
      return;
    }

    // Return cached response if still fresh
    if (allPortsCache && Date.now() < allPortsCache.expiresAt) {
      res.json(allPortsCache.payload);
      return;
    }

    const targets = [...featuredByType("embarkation", 12), ...featuredByType("destination", 12)];
    // Tolerate partial upstream failures: a single bad open-meteo fetch must
    // never blank the whole homepage. Keep whatever cards succeeded.
    const settled = await Promise.allSettled(targets.map(fetchForecast));
    const cards = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));

    // If too few cards came back, serve the last good payload rather than a
    // half-empty homepage (don't overwrite a healthy cache with a degraded set).
    const minOk = Math.ceil(targets.length / 2);
    if (cards.length < minOk && allPortsCache) {
      res.json(allPortsCache.payload);
      return;
    }

    const payload = {
      ok: true,
      generatedAt: new Date().toISOString(),
      embarkation: cards.filter((c) => c.type === "embarkation"),
      destinations: cards.filter((c) => c.type === "destination"),
      allEmbarkationPorts: CRUISE_LOCATIONS
        .filter((l) => l.type === "embarkation")
        .map(publicLocation)
        .sort((a, b) => a.name.localeCompare(b.name)),
      allDestinations: CRUISE_LOCATIONS
        .filter((l) => l.type === "destination")
        .map(publicLocation)
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
    // Only cache a healthy payload so we never pin an empty result for 15 min.
    if (cards.length >= minOk) {
      allPortsCache = { payload, expiresAt: Date.now() + 15 * 60 * 1000 };
    }
    res.json(payload);
  } catch (error) {
    // Last resort: serve stale cache instead of blanking the homepage.
    if (allPortsCache) { res.json(allPortsCache.payload); return; }
    res.status(500).json({ ok: false, error: (error as Error).message, embarkation: [], destinations: [] });
  }
});

export default router;
