import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

interface CruiseLocation {
  slug: string;
  name: string;
  type: "embarkation" | "destination";
  featured?: boolean;
  lat: number;
  lon: number;
}

const CRUISE_LOCATIONS: CruiseLocation[] = [
  // ── US EMBARKATION PORTS ─────────────────────────────────────
  { slug:"miami",              name:"Miami, Florida",              type:"embarkation", featured:true, lat:25.7617,  lon:-80.1918  },
  { slug:"fort-lauderdale",    name:"Fort Lauderdale, Florida",    type:"embarkation", featured:true, lat:26.1224,  lon:-80.1373  },
  { slug:"port-canaveral",     name:"Port Canaveral, Florida",     type:"embarkation", featured:true, lat:28.3922,  lon:-80.6077  },
  { slug:"tampa",              name:"Tampa, Florida",              type:"embarkation", featured:true, lat:27.9506,  lon:-82.4572  },
  { slug:"galveston",          name:"Galveston, Texas",            type:"embarkation", featured:true, lat:29.3013,  lon:-94.7977  },
  { slug:"new-york",           name:"New York City, New York",     type:"embarkation", featured:true, lat:40.7128,  lon:-74.0060  },
  { slug:"new-orleans",        name:"New Orleans, Louisiana",      type:"embarkation", featured:true, lat:29.9511,  lon:-90.0715  },
  { slug:"seattle",            name:"Seattle, Washington",         type:"embarkation", featured:true, lat:47.6062,  lon:-122.3321 },
  { slug:"los-angeles",        name:"Los Angeles / San Pedro, CA", type:"embarkation", featured:true, lat:33.7405,  lon:-118.2775 },
  { slug:"honolulu",           name:"Honolulu, Hawaii",            type:"embarkation", featured:true, lat:21.3069,  lon:-157.8583 },
  { slug:"baltimore",          name:"Baltimore, Maryland",         type:"embarkation", featured:true, lat:39.2904,  lon:-76.6122  },
  { slug:"san-francisco",      name:"San Francisco, California",   type:"embarkation", featured:true, lat:37.7749,  lon:-122.4194 },
  { slug:"boston",             name:"Boston, Massachusetts",       type:"embarkation", lat:42.3601,  lon:-71.0589  },
  { slug:"charleston-sc",      name:"Charleston, South Carolina",  type:"embarkation", lat:32.7765,  lon:-79.9311  },
  { slug:"jacksonville",       name:"Jacksonville, Florida",       type:"embarkation", lat:30.3322,  lon:-81.6557  },
  { slug:"norfolk",            name:"Norfolk, Virginia",           type:"embarkation", lat:36.8508,  lon:-76.2859  },
  { slug:"san-diego",          name:"San Diego, California",       type:"embarkation", lat:32.7157,  lon:-117.1611 },
  // ── INTERNATIONAL EMBARKATION ────────────────────────────────
  { slug:"amsterdam",          name:"Amsterdam, Netherlands",      type:"embarkation", lat:52.3676,  lon:4.9041    },
  { slug:"athens-piraeus",     name:"Athens / Piraeus, Greece",    type:"embarkation", lat:37.9420,  lon:23.6469   },
  { slug:"barcelona",          name:"Barcelona, Spain",            type:"embarkation", lat:41.3851,  lon:2.1734    },
  { slug:"buenos-aires",       name:"Buenos Aires, Argentina",     type:"embarkation", lat:-34.6037, lon:-58.3816  },
  { slug:"copenhagen",         name:"Copenhagen, Denmark",         type:"embarkation", lat:55.6761,  lon:12.5683   },
  { slug:"dubai",              name:"Dubai, UAE",                  type:"embarkation", lat:25.2048,  lon:55.2708   },
  { slug:"hong-kong",          name:"Hong Kong",                   type:"embarkation", lat:22.3193,  lon:114.1694  },
  { slug:"rome-civitavecchia", name:"Rome / Civitavecchia, Italy", type:"embarkation", lat:42.0924,  lon:11.7954   },
  { slug:"singapore",          name:"Singapore",                   type:"embarkation", lat:1.3521,   lon:103.8198  },
  { slug:"southampton",        name:"Southampton, England",        type:"embarkation", lat:50.9097,  lon:-1.4044   },
  { slug:"sydney",             name:"Sydney, Australia",           type:"embarkation", lat:-33.8688, lon:151.2093  },
  { slug:"vancouver",          name:"Vancouver, Canada",           type:"embarkation", lat:49.2827,  lon:-123.1207 },
  { slug:"venice",             name:"Venice, Italy",               type:"embarkation", lat:45.4408,  lon:12.3155   },
  { slug:"yokohama",           name:"Yokohama / Tokyo, Japan",     type:"embarkation", lat:35.4437,  lon:139.6380  },

  // ── CARIBBEAN / BAHAMAS DESTINATIONS ─────────────────────────
  { slug:"nassau",           name:"Nassau, Bahamas",              type:"destination", featured:true, lat:25.0443,  lon:-77.3504  },
  { slug:"cozumel",          name:"Cozumel, Mexico",              type:"destination", featured:true, lat:20.4229,  lon:-86.9223  },
  { slug:"st-thomas",        name:"St. Thomas, USVI",             type:"destination", featured:true, lat:18.3381,  lon:-64.8941  },
  { slug:"grand-cayman",     name:"Grand Cayman",                 type:"destination", featured:true, lat:19.3133,  lon:-81.2546  },
  { slug:"aruba",            name:"Aruba",                        type:"destination", featured:true, lat:12.5211,  lon:-69.9683  },
  { slug:"st-maarten",       name:"St. Maarten",                  type:"destination", featured:true, lat:18.0425,  lon:-63.0548  },
  { slug:"ocho-rios",        name:"Ocho Rios, Jamaica",           type:"destination", featured:true, lat:18.4074,  lon:-77.1031  },
  { slug:"bermuda",          name:"Bermuda",                      type:"destination", featured:true, lat:32.3078,  lon:-64.7505  },
  { slug:"san-juan",         name:"San Juan, Puerto Rico",        type:"destination", featured:true, lat:18.4655,  lon:-66.1057  },
  { slug:"cococay",          name:"CocoCay, Bahamas",             type:"destination", featured:true, lat:25.8170,  lon:-77.9390  },
  { slug:"belize-city",      name:"Belize City, Belize",          type:"destination", featured:true, lat:17.5046,  lon:-88.1962  },
  { slug:"roatan",           name:"Roatán, Honduras",             type:"destination", featured:true, lat:16.3247,  lon:-86.5365  },
  { slug:"amber-cove",       name:"Amber Cove (Puerto Plata), DR",type:"destination", lat:19.8180,  lon:-70.7800  },
  { slug:"antigua",          name:"Antigua",                      type:"destination", lat:17.0608,  lon:-61.7964  },
  { slug:"barbados",         name:"Barbados",                     type:"destination", lat:13.1939,  lon:-59.5432  },
  { slug:"cabo-san-lucas",   name:"Cabo San Lucas, Mexico",       type:"destination", lat:22.8905,  lon:-109.9167 },
  { slug:"cartagena",        name:"Cartagena, Colombia",          type:"destination", lat:10.3910,  lon:-75.4794  },
  { slug:"costa-maya",       name:"Costa Maya, Mexico",           type:"destination", lat:18.7140,  lon:-87.7090  },
  { slug:"curacao",          name:"Curaçao",                      type:"destination", lat:12.1696,  lon:-68.9900  },
  { slug:"falmouth-jamaica", name:"Falmouth, Jamaica",            type:"destination", lat:18.4936,  lon:-77.6559  },
  { slug:"grand-turk",       name:"Grand Turk, Turks & Caicos",   type:"destination", lat:21.4558,  lon:-71.1389  },
  { slug:"great-stirrup",    name:"Great Stirrup Cay, Bahamas",   type:"destination", lat:25.8244,  lon:-77.9120  },
  { slug:"halfmoon-cay",     name:"Half Moon Cay, Bahamas",       type:"destination", lat:24.7520,  lon:-76.2020  },
  { slug:"key-west",         name:"Key West, Florida",            type:"destination", lat:24.5551,  lon:-81.7800  },
  { slug:"labadee",          name:"Labadee, Haiti",               type:"destination", lat:19.7800,  lon:-72.2200  },
  { slug:"montego-bay",      name:"Montego Bay, Jamaica",         type:"destination", lat:18.4762,  lon:-77.8939  },
  { slug:"princess-cays",    name:"Princess Cays, Bahamas",       type:"destination", lat:23.4700,  lon:-75.5400  },
  { slug:"puerto-vallarta",  name:"Puerto Vallarta, Mexico",      type:"destination", lat:20.6534,  lon:-105.2253 },
  { slug:"st-kitts",         name:"St. Kitts",                    type:"destination", lat:17.3578,  lon:-62.7830  },
  { slug:"st-lucia",         name:"St. Lucia",                    type:"destination", lat:13.9094,  lon:-60.9789  },
  { slug:"tortola",          name:"Tortola, BVI",                 type:"destination", lat:18.4315,  lon:-64.6235  },
  // ── ALASKA ───────────────────────────────────────────────────
  { slug:"juneau",           name:"Juneau, Alaska",               type:"destination", lat:58.3019,  lon:-134.4197 },
  { slug:"ketchikan",        name:"Ketchikan, Alaska",            type:"destination", lat:55.3422,  lon:-131.6461 },
  { slug:"skagway",          name:"Skagway, Alaska",              type:"destination", lat:59.4583,  lon:-135.3139 },
  // ── MEDITERRANEAN ────────────────────────────────────────────
  { slug:"dubrovnik",        name:"Dubrovnik, Croatia",           type:"destination", lat:42.6507,  lon:18.0944   },
  { slug:"mykonos",          name:"Mykonos, Greece",              type:"destination", lat:37.4467,  lon:25.3289   },
  { slug:"naples",           name:"Naples, Italy",                type:"destination", lat:40.8518,  lon:14.2681   },
  { slug:"santorini",        name:"Santorini, Greece",            type:"destination", lat:36.3932,  lon:25.4615   },
  // ── PACIFIC / OTHER ──────────────────────────────────────────
  { slug:"bali",             name:"Bali, Indonesia",              type:"destination", lat:-8.3405,  lon:115.0920  },
  { slug:"bora-bora",        name:"Bora Bora, French Polynesia",  type:"destination", lat:-16.5004, lon:-151.7415 },
  { slug:"phuket",           name:"Phuket, Thailand",             type:"destination", lat:7.8804,   lon:98.3923   },
  { slug:"reykjavik",        name:"Reykjavik, Iceland",           type:"destination", lat:64.1466,  lon:-21.9426  },
];

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
      Authorization: `Bearer ${process.env["OPENAI_API_KEY"] || process.env["REPLIT_OPENAI_API_KEY"]}`,
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
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Weather fetch failed for ${loc.slug}`);
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

    const embarkation = featuredByType("embarkation", 12);
    const destinations = featuredByType("destination", 12);
    const cards = await Promise.all([...embarkation, ...destinations].map(fetchForecast));
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
    allPortsCache = { payload, expiresAt: Date.now() + 15 * 60 * 1000 };
    res.json(payload);
  } catch (error) {
    res.status(500).json({ ok: false, error: (error as Error).message, embarkation: [], destinations: [] });
  }
});

export default router;
