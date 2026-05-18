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
  // ── US EMBARKATION PORTS ──────────────────────────────────────
  { slug:"miami",            name:"Miami, Florida",                   type:"embarkation", featured:true,  lat:25.7617,   lon:-80.1918  },
  { slug:"fort-lauderdale",  name:"Fort Lauderdale, Florida",         type:"embarkation", featured:true,  lat:26.1224,   lon:-80.1373  },
  { slug:"port-canaveral",   name:"Port Canaveral, Florida",          type:"embarkation", featured:true,  lat:28.3922,   lon:-80.6077  },
  { slug:"tampa",            name:"Tampa, Florida",                   type:"embarkation", featured:true,  lat:27.9506,   lon:-82.4572  },
  { slug:"galveston",        name:"Galveston, Texas",                 type:"embarkation", featured:true,  lat:29.3013,   lon:-94.7977  },
  { slug:"new-york",         name:"New York City, New York",          type:"embarkation", featured:true,  lat:40.7128,   lon:-74.0060  },
  { slug:"new-orleans",      name:"New Orleans, Louisiana",           type:"embarkation", featured:true,  lat:29.9511,   lon:-90.0715  },
  { slug:"seattle",          name:"Seattle, Washington",              type:"embarkation", featured:true,  lat:47.6062,   lon:-122.3321 },
  { slug:"los-angeles",      name:"Los Angeles / San Pedro, CA",      type:"embarkation", featured:true,  lat:33.7405,   lon:-118.2775 },
  { slug:"honolulu",         name:"Honolulu, Hawaii",                 type:"embarkation", featured:true,  lat:21.3069,   lon:-157.8583 },
  { slug:"baltimore",        name:"Baltimore, Maryland",              type:"embarkation", lat:39.2904,   lon:-76.6122  },
  { slug:"boston",           name:"Boston, Massachusetts",            type:"embarkation", lat:42.3601,   lon:-71.0589  },
  { slug:"charleston-sc",    name:"Charleston, South Carolina",       type:"embarkation", lat:32.7765,   lon:-79.9311  },
  { slug:"jacksonville",     name:"Jacksonville, Florida",            type:"embarkation", lat:30.3322,   lon:-81.6557  },
  { slug:"key-west-embark",  name:"Key West, Florida",                type:"embarkation", lat:24.5551,   lon:-81.7800  },
  { slug:"mobile",           name:"Mobile, Alabama",                  type:"embarkation", lat:30.6954,   lon:-88.0399  },
  { slug:"norfolk",          name:"Norfolk, Virginia",                type:"embarkation", lat:36.8508,   lon:-76.2859  },
  { slug:"palm-beach",       name:"Palm Beach, Florida",              type:"embarkation", lat:26.7694,   lon:-80.0534  },
  { slug:"san-diego",        name:"San Diego, California",            type:"embarkation", lat:32.7157,   lon:-117.1611 },
  { slug:"san-francisco",    name:"San Francisco, California",        type:"embarkation", lat:37.7749,   lon:-122.4194 },
  { slug:"san-juan-embark",  name:"San Juan, Puerto Rico",            type:"embarkation", lat:18.4655,   lon:-66.1057  },
  // ── CANADA / PACIFIC ─────────────────────────────────────────
  { slug:"montreal",         name:"Montréal, Canada",                 type:"embarkation", lat:45.5017,   lon:-73.5673  },
  { slug:"vancouver",        name:"Vancouver, Canada",                type:"embarkation", lat:49.2827,   lon:-123.1207 },
  { slug:"victoria-bc",      name:"Victoria, British Columbia",       type:"embarkation", lat:48.4284,   lon:-123.3656 },
  // ── EUROPE EMBARKATION ────────────────────────────────────────
  { slug:"amsterdam",        name:"Amsterdam, Netherlands",           type:"embarkation", lat:52.3676,   lon:4.9041    },
  { slug:"athens-piraeus",   name:"Athens / Piraeus, Greece",         type:"embarkation", lat:37.9420,   lon:23.6469   },
  { slug:"barcelona",        name:"Barcelona, Spain",                 type:"embarkation", lat:41.3851,   lon:2.1734    },
  { slug:"copenhagen",       name:"Copenhagen, Denmark",              type:"embarkation", lat:55.6761,   lon:12.5683   },
  { slug:"dubai",            name:"Dubai, United Arab Emirates",      type:"embarkation", lat:25.2048,   lon:55.2708   },
  { slug:"funchal",          name:"Funchal, Madeira",                 type:"embarkation", lat:32.6669,   lon:-16.9241  },
  { slug:"hamburg",          name:"Hamburg, Germany",                 type:"embarkation", lat:53.5753,   lon:10.0153   },
  { slug:"istanbul",         name:"Istanbul, Turkey",                 type:"embarkation", lat:41.0082,   lon:28.9784   },
  { slug:"las-palmas",       name:"Las Palmas, Gran Canaria",         type:"embarkation", lat:28.1235,   lon:-15.4363  },
  { slug:"lisbon",           name:"Lisbon, Portugal",                 type:"embarkation", lat:38.7223,   lon:-9.1393   },
  { slug:"oslo",             name:"Oslo, Norway",                     type:"embarkation", lat:59.9139,   lon:10.7522   },
  { slug:"rome-civitavecchia",name:"Rome / Civitavecchia, Italy",     type:"embarkation", lat:42.0924,   lon:11.7954   },
  { slug:"rotterdam",        name:"Rotterdam, Netherlands",           type:"embarkation", lat:51.9244,   lon:4.4777    },
  { slug:"southampton",      name:"Southampton, England",             type:"embarkation", lat:50.9097,   lon:-1.4044   },
  { slug:"stockholm",        name:"Stockholm, Sweden",                type:"embarkation", lat:59.3293,   lon:18.0686   },
  { slug:"tenerife",         name:"Tenerife, Spain (Canary Islands)", type:"embarkation", lat:28.2916,   lon:-16.6291  },
  { slug:"venice",           name:"Venice, Italy",                    type:"embarkation", lat:45.4408,   lon:12.3155   },
  // ── ASIA / PACIFIC EMBARKATION ───────────────────────────────
  { slug:"auckland",         name:"Auckland, New Zealand",            type:"embarkation", lat:-36.8485,  lon:174.7633  },
  { slug:"hong-kong",        name:"Hong Kong",                        type:"embarkation", lat:22.3193,   lon:114.1694  },
  { slug:"melbourne",        name:"Melbourne, Australia",             type:"embarkation", lat:-37.8136,  lon:144.9631  },
  { slug:"singapore",        name:"Singapore",                        type:"embarkation", lat:1.3521,    lon:103.8198  },
  { slug:"sydney",           name:"Sydney, Australia",                type:"embarkation", lat:-33.8688,  lon:151.2093  },
  { slug:"yokohama",         name:"Yokohama / Tokyo, Japan",          type:"embarkation", lat:35.4437,   lon:139.6380  },
  // ── SOUTH AMERICA EMBARKATION ────────────────────────────────
  { slug:"buenos-aires",     name:"Buenos Aires, Argentina",          type:"embarkation", lat:-34.6037,  lon:-58.3816  },
  { slug:"rio-de-janeiro",   name:"Rio de Janeiro, Brazil",           type:"embarkation", lat:-22.9068,  lon:-43.1729  },
  { slug:"valparaiso",       name:"Valparaíso, Chile",                type:"embarkation", lat:-33.0472,  lon:-71.6127  },

  // ── CARIBBEAN / BAHAMAS DESTINATIONS ─────────────────────────
  { slug:"nassau",           name:"Nassau, Bahamas",                  type:"destination", featured:true,  lat:25.0443,  lon:-77.3504  },
  { slug:"cozumel",          name:"Cozumel, Mexico",                  type:"destination", featured:true,  lat:20.4229,  lon:-86.9223  },
  { slug:"st-thomas",        name:"St. Thomas, USVI",                 type:"destination", featured:true,  lat:18.3381,  lon:-64.8941  },
  { slug:"grand-cayman",     name:"Grand Cayman",                     type:"destination", featured:true,  lat:19.3133,  lon:-81.2546  },
  { slug:"aruba",            name:"Aruba",                            type:"destination", featured:true,  lat:12.5211,  lon:-69.9683  },
  { slug:"st-maarten",       name:"St. Maarten",                      type:"destination", featured:true,  lat:18.0425,  lon:-63.0548  },
  { slug:"ocho-rios",        name:"Ocho Rios, Jamaica",               type:"destination", featured:true,  lat:18.4074,  lon:-77.1031  },
  { slug:"bermuda",          name:"Bermuda",                          type:"destination", featured:true,  lat:32.3078,  lon:-64.7505  },
  { slug:"san-juan",         name:"San Juan, Puerto Rico",            type:"destination", featured:true,  lat:18.4655,  lon:-66.1057  },
  { slug:"cococay",          name:"CocoCay, Bahamas",                 type:"destination", featured:true,  lat:25.8170,  lon:-77.9390  },
  { slug:"belize-city",      name:"Belize City, Belize",              type:"destination", featured:true,  lat:17.5046,  lon:-88.1962  },
  { slug:"roatan",           name:"Roatán, Honduras",                 type:"destination", featured:true,  lat:16.3247,  lon:-86.5365  },
  { slug:"amber-cove",       name:"Amber Cove (Puerto Plata), DR",    type:"destination", lat:19.8180,  lon:-70.7800  },
  { slug:"antigua",          name:"Antigua",                          type:"destination", lat:17.0608,  lon:-61.7964  },
  { slug:"barbados",         name:"Barbados",                         type:"destination", lat:13.1939,  lon:-59.5432  },
  { slug:"bonaire",          name:"Bonaire",                          type:"destination", lat:12.1784,  lon:-68.2385  },
  { slug:"cabo-san-lucas",   name:"Cabo San Lucas, Mexico",           type:"destination", lat:22.8905,  lon:-109.9167 },
  { slug:"cartagena",        name:"Cartagena, Colombia",              type:"destination", lat:10.3910,  lon:-75.4794  },
  { slug:"colon-panama",     name:"Colón, Panama",                    type:"destination", lat:9.3580,   lon:-79.9010  },
  { slug:"costa-maya",       name:"Costa Maya, Mexico",               type:"destination", lat:18.7140,  lon:-87.7090  },
  { slug:"curacao",          name:"Curaçao",                          type:"destination", lat:12.1696,  lon:-68.9900  },
  { slug:"dominica",         name:"Roseau, Dominica",                 type:"destination", lat:15.3092,  lon:-61.3794  },
  { slug:"ensenada",         name:"Ensenada, Mexico",                 type:"destination", lat:31.8667,  lon:-116.5961 },
  { slug:"falmouth-jamaica", name:"Falmouth, Jamaica",                type:"destination", lat:18.4936,  lon:-77.6559  },
  { slug:"grand-turk",       name:"Grand Turk, Turks & Caicos",       type:"destination", lat:21.4558,  lon:-71.1389  },
  { slug:"great-stirrup",    name:"Great Stirrup Cay, Bahamas",       type:"destination", lat:25.8244,  lon:-77.9120  },
  { slug:"grenada",          name:"Grenada",                          type:"destination", lat:12.1165,  lon:-61.6790  },
  { slug:"guadeloupe",       name:"Guadeloupe",                       type:"destination", lat:16.2650,  lon:-61.5510  },
  { slug:"halfmoon-cay",     name:"Half Moon Cay, Bahamas",           type:"destination", lat:24.7520,  lon:-76.2020  },
  { slug:"huatulco",         name:"Huatulco, Mexico",                 type:"destination", lat:15.7680,  lon:-96.1320  },
  { slug:"key-west",         name:"Key West, Florida",                type:"destination", lat:24.5551,  lon:-81.7800  },
  { slug:"labadee",          name:"Labadee, Haiti",                   type:"destination", lat:19.7800,  lon:-72.2200  },
  { slug:"martinique",       name:"Fort-de-France, Martinique",       type:"destination", lat:14.6037,  lon:-61.0674  },
  { slug:"mazatlan",         name:"Mazatlán, Mexico",                 type:"destination", lat:23.2494,  lon:-106.4111 },
  { slug:"montego-bay",      name:"Montego Bay, Jamaica",             type:"destination", lat:18.4762,  lon:-77.8939  },
  { slug:"montevideo",       name:"Montevideo, Uruguay",              type:"destination", lat:-34.9011, lon:-56.1645  },
  { slug:"princess-cays",    name:"Princess Cays, Bahamas",          type:"destination", lat:23.4700,  lon:-75.5400  },
  { slug:"puerto-vallarta",  name:"Puerto Vallarta, Mexico",          type:"destination", lat:20.6534,  lon:-105.2253 },
  { slug:"st-barts",         name:"St. Barthélemy",                   type:"destination", lat:17.8998,  lon:-62.8518  },
  { slug:"st-croix",         name:"St. Croix, USVI",                  type:"destination", lat:17.7245,  lon:-64.7169  },
  { slug:"st-kitts",         name:"St. Kitts",                        type:"destination", lat:17.3578,  lon:-62.7830  },
  { slug:"st-lucia",         name:"St. Lucia",                        type:"destination", lat:13.9094,  lon:-60.9789  },
  { slug:"st-vincent",       name:"St. Vincent",                      type:"destination", lat:13.1600,  lon:-61.2248  },
  { slug:"tortola",          name:"Tortola, British Virgin Islands",   type:"destination", lat:18.4315,  lon:-64.6235  },
  { slug:"trinidad",         name:"Port of Spain, Trinidad",          type:"destination", lat:10.6549,  lon:-61.5019  },

  // ── ALASKA / PACIFIC NORTHWEST ────────────────────────────────
  { slug:"glacier-bay",      name:"Glacier Bay, Alaska",              type:"destination", lat:58.8742,  lon:-136.8398 },
  { slug:"haines",           name:"Haines, Alaska",                   type:"destination", lat:59.2358,  lon:-135.4453 },
  { slug:"icy-strait",       name:"Icy Strait Point, Alaska",         type:"destination", lat:58.1307,  lon:-135.4504 },
  { slug:"juneau",           name:"Juneau, Alaska",                   type:"destination", lat:58.3019,  lon:-134.4197 },
  { slug:"ketchikan",        name:"Ketchikan, Alaska",                type:"destination", lat:55.3422,  lon:-131.6461 },
  { slug:"sitka",            name:"Sitka, Alaska",                    type:"destination", lat:57.0531,  lon:-135.3300 },
  { slug:"skagway",          name:"Skagway, Alaska",                  type:"destination", lat:59.4583,  lon:-135.3139 },

  // ── HAWAII ───────────────────────────────────────────────────
  { slug:"hilo",             name:"Hilo, Hawaii",                     type:"destination", lat:19.7297,  lon:-155.0890 },
  { slug:"kona",             name:"Kona, Hawaii",                     type:"destination", lat:19.6400,  lon:-155.9900 },
  { slug:"lahaina",          name:"Lahaina, Maui",                    type:"destination", lat:20.8783,  lon:-156.6825 },
  { slug:"nawiliwili",       name:"Nawiliwili, Kauai",                type:"destination", lat:21.9544,  lon:-159.3565 },

  // ── MEDITERRANEAN ────────────────────────────────────────────
  { slug:"cadiz",            name:"Cádiz, Spain",                     type:"destination", lat:36.5298,  lon:-6.2921   },
  { slug:"cagliari",         name:"Cagliari, Sardinia",               type:"destination", lat:39.2238,  lon:9.1217    },
  { slug:"corfu",            name:"Corfu, Greece",                    type:"destination", lat:39.6243,  lon:19.9217   },
  { slug:"dubrovnik",        name:"Dubrovnik, Croatia",               type:"destination", lat:42.6507,  lon:18.0944   },
  { slug:"genoa",            name:"Genoa, Italy",                     type:"destination", lat:44.4056,  lon:8.9463    },
  { slug:"haifa",            name:"Haifa, Israel",                    type:"destination", lat:32.7940,  lon:34.9896   },
  { slug:"heraklion",        name:"Heraklion, Crete",                 type:"destination", lat:35.3387,  lon:25.1442   },
  { slug:"kotor",            name:"Kotor, Montenegro",                type:"destination", lat:42.4236,  lon:18.7714   },
  { slug:"kusadasi",         name:"Kusadasi, Turkey",                 type:"destination", lat:37.8575,  lon:27.2614   },
  { slug:"limassol",         name:"Limassol, Cyprus",                 type:"destination", lat:34.6851,  lon:33.0323   },
  { slug:"livorno",          name:"Livorno (Tuscany), Italy",         type:"destination", lat:43.5479,  lon:10.3118   },
  { slug:"malaga",           name:"Málaga, Spain",                    type:"destination", lat:36.7213,  lon:-4.4214   },
  { slug:"marseille",        name:"Marseille, France",                type:"destination", lat:43.2965,  lon:5.3698    },
  { slug:"messina",          name:"Messina, Sicily",                  type:"destination", lat:38.1938,  lon:15.5540   },
  { slug:"mykonos",          name:"Mykonos, Greece",                  type:"destination", lat:37.4467,  lon:25.3289   },
  { slug:"naples",           name:"Naples, Italy",                    type:"destination", lat:40.8518,  lon:14.2681   },
  { slug:"nice",             name:"Nice, France",                     type:"destination", lat:43.7102,  lon:7.2620    },
  { slug:"palermo",          name:"Palermo, Sicily",                  type:"destination", lat:38.1157,  lon:13.3615   },
  { slug:"palma",            name:"Palma de Mallorca, Spain",         type:"destination", lat:39.5696,  lon:2.6502    },
  { slug:"rhodes",           name:"Rhodes, Greece",                   type:"destination", lat:36.4341,  lon:28.2176   },
  { slug:"santorini",        name:"Santorini, Greece",                type:"destination", lat:36.3932,  lon:25.4615   },
  { slug:"split",            name:"Split, Croatia",                   type:"destination", lat:43.5081,  lon:16.4402   },
  { slug:"valletta",         name:"Valletta, Malta",                  type:"destination", lat:35.8989,  lon:14.5146   },

  // ── NORTHERN EUROPE / NORWAY ─────────────────────────────────
  { slug:"alesund",          name:"Ålesund, Norway",                  type:"destination", lat:62.4721,  lon:6.1549    },
  { slug:"bergen",           name:"Bergen, Norway",                   type:"destination", lat:60.3913,  lon:5.3221    },
  { slug:"flam",             name:"Flåm, Norway",                     type:"destination", lat:60.8633,  lon:7.1167    },
  { slug:"helsinki",         name:"Helsinki, Finland",                type:"destination", lat:60.1699,  lon:24.9384   },
  { slug:"oporto",           name:"Porto, Portugal",                  type:"destination", lat:41.1579,  lon:-8.6291   },
  { slug:"reykjavik",        name:"Reykjavik, Iceland",               type:"destination", lat:64.1466,  lon:-21.9426  },
  { slug:"riga",             name:"Riga, Latvia",                     type:"destination", lat:56.9496,  lon:24.1052   },
  { slug:"st-petersburg",    name:"St. Petersburg, Russia",           type:"destination", lat:59.9311,  lon:30.3609   },
  { slug:"stavanger",        name:"Stavanger, Norway",                type:"destination", lat:58.9700,  lon:5.7331    },
  { slug:"tallinn",          name:"Tallinn, Estonia",                 type:"destination", lat:59.4370,  lon:24.7536   },

  // ── ASIA / PACIFIC ───────────────────────────────────────────
  { slug:"bali",             name:"Bali, Indonesia",                  type:"destination", lat:-8.3405,  lon:115.0920  },
  { slug:"busan",            name:"Busan, South Korea",               type:"destination", lat:35.1796,  lon:129.0756  },
  { slug:"cairns",           name:"Cairns, Australia",                type:"destination", lat:-16.9203, lon:145.7710  },
  { slug:"colombo",          name:"Colombo, Sri Lanka",               type:"destination", lat:6.9271,   lon:79.8612   },
  { slug:"fremantle",        name:"Fremantle (Perth), Australia",     type:"destination", lat:-32.0569, lon:115.7439  },
  { slug:"ho-chi-minh",      name:"Ho Chi Minh City, Vietnam",        type:"destination", lat:10.8231,  lon:106.6297  },
  { slug:"keelung",          name:"Keelung (Taipei), Taiwan",         type:"destination", lat:25.1276,  lon:121.7392  },
  { slug:"ko-samui",         name:"Ko Samui, Thailand",               type:"destination", lat:9.5120,   lon:100.0136  },
  { slug:"langkawi",         name:"Langkawi, Malaysia",               type:"destination", lat:6.3500,   lon:99.8000   },
  { slug:"maldives",         name:"Malé, Maldives",                   type:"destination", lat:4.1755,   lon:73.5093   },
  { slug:"manila",           name:"Manila, Philippines",              type:"destination", lat:14.5995,  lon:120.9842  },
  { slug:"muscat",           name:"Muscat, Oman",                     type:"destination", lat:23.5880,  lon:58.3829   },
  { slug:"nagasaki",         name:"Nagasaki, Japan",                  type:"destination", lat:32.7503,  lon:129.8779  },
  { slug:"osaka",            name:"Osaka, Japan",                     type:"destination", lat:34.6937,  lon:135.5023  },
  { slug:"penang",           name:"Penang, Malaysia",                 type:"destination", lat:5.4141,   lon:100.3288  },
  { slug:"phuket",           name:"Phuket, Thailand",                 type:"destination", lat:7.8804,   lon:98.3923   },

  // ── FRENCH POLYNESIA ─────────────────────────────────────────
  { slug:"bora-bora",        name:"Bora Bora, French Polynesia",      type:"destination", lat:-16.5004, lon:-151.7415 },
  { slug:"moorea",           name:"Moorea, French Polynesia",         type:"destination", lat:-17.5374, lon:-149.8293 },
  { slug:"papeete",          name:"Papeete, Tahiti",                  type:"destination", lat:-17.5334, lon:-149.5667 },

  // ── AFRICA / INDIAN OCEAN ────────────────────────────────────
  { slug:"cape-town",        name:"Cape Town, South Africa",          type:"destination", lat:-33.9249, lon:18.4241   },
  { slug:"mombasa",          name:"Mombasa, Kenya",                   type:"destination", lat:-4.0435,  lon:39.6682   },
  { slug:"port-louis",       name:"Port Louis, Mauritius",            type:"destination", lat:-20.1609, lon:57.4974   },
  { slug:"seychelles",       name:"Mahé, Seychelles",                 type:"destination", lat:-4.6191,  lon:55.4513   },
  { slug:"zanzibar",         name:"Zanzibar, Tanzania",               type:"destination", lat:-6.1630,  lon:39.2080   },
];

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
      high: Math.round(data.daily.temperature_2m_max[i]),
      low: Math.round(data.daily.temperature_2m_min[i]),
    })),
  };
}

router.get("/weather", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1800");
  try {
    const place = String(req.query.place || "").trim();

    if (place) {
      const loc = CRUISE_LOCATIONS.find((l) => l.slug === place);
      if (!loc) { res.status(404).json({ ok: false, error: "Destination not found" }); return; }
      const forecast = await fetchForecast(loc);
      res.json({ ok: true, forecast });
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

    const embarkation = featuredByType("embarkation", 12);
    const destinations = featuredByType("destination", 12);
    const cards = await Promise.all([...embarkation, ...destinations].map(fetchForecast));
    res.json({
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
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: (error as Error).message, embarkation: [], destinations: [] });
  }
});

export default router;
