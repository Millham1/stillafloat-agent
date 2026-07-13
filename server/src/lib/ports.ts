// ports.ts — the shared cruise-port gazetteer.
//
// Moved out of routes/weather.ts so the Where's-My-Ship tracker can reuse the
// same coordinates for AIS destination matching and port-call detection. The
// weather route imports from here; the slugs are the public /api/weather?place=
// and /forecast.html?place= keys, so they must stay stable.

export interface CruiseLocation {
  slug: string;
  name: string;
  type: "embarkation" | "destination";
  featured?: boolean;
  lat: number;
  lon: number;
}

export const CRUISE_LOCATIONS: CruiseLocation[] = [
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

const BY_SLUG = new Map(CRUISE_LOCATIONS.map((l) => [l.slug, l]));
export function portBySlug(slug: string): CruiseLocation | undefined {
  return BY_SLUG.get(slug);
}

// ── AIS destination-text matching ────────────────────────────────────────────
// AIS "Destination" is crew-typed free text ("MIAMI", "PORT EVERGLADES",
// "COZUMEL,MEX", "US MIA > BS NAS"). Aliases cover the common port-code and
// nickname forms; the fallback scans for a location-name token match.
const DEST_ALIASES: Record<string, string> = {
  "MIAMI": "miami", "US MIA": "miami", "MIA": "miami", "PORTMIAMI": "miami",
  "PORT EVERGLADES": "fort-lauderdale", "EVERGLADES": "fort-lauderdale",
  "FT LAUDERDALE": "fort-lauderdale", "FORT LAUDERDALE": "fort-lauderdale", "US PEF": "fort-lauderdale",
  "PORT CANAVERAL": "port-canaveral", "CANAVERAL": "port-canaveral", "US PCV": "port-canaveral", "CAPE CANAVERAL": "port-canaveral",
  "TAMPA": "tampa", "GALVESTON": "galveston", "US GLS": "galveston",
  "NEW YORK": "new-york", "NYC": "new-york", "BROOKLYN": "new-york", "MANHATTAN": "new-york", "BAYONNE": "new-york", "CAPE LIBERTY": "new-york",
  "NEW ORLEANS": "new-orleans", "NOLA": "new-orleans",
  "SEATTLE": "seattle", "LOS ANGELES": "los-angeles", "SAN PEDRO": "los-angeles",
  "HONOLULU": "honolulu", "BALTIMORE": "baltimore", "SAN FRANCISCO": "san-francisco",
  "NASSAU": "nassau", "BS NAS": "nassau",
  "COZUMEL": "cozumel", "MX CZM": "cozumel",
  "ST THOMAS": "st-thomas", "CHARLOTTE AMALIE": "st-thomas",
  "GRAND CAYMAN": "grand-cayman", "GEORGETOWN": "grand-cayman", "GEORGE TOWN": "grand-cayman",
  "ARUBA": "aruba", "ORANJESTAD": "aruba",
  "ST MAARTEN": "st-maarten", "PHILIPSBURG": "st-maarten", "SINT MAARTEN": "st-maarten",
  "OCHO RIOS": "ocho-rios", "BERMUDA": "bermuda", "KINGS WHARF": "bermuda",
  "SAN JUAN": "san-juan", "COCOCAY": "cococay", "COCO CAY": "cococay", "PERFECT DAY": "cococay",
  "BELIZE": "belize-city", "ROATAN": "roatan", "MAHOGANY BAY": "roatan",
  "AMBER COVE": "amber-cove", "PUERTO PLATA": "amber-cove", "TAINO BAY": "amber-cove",
  "ANTIGUA": "antigua", "ST JOHNS": "antigua",
  "BARBADOS": "barbados", "BRIDGETOWN": "barbados",
  "CABO": "cabo-san-lucas", "CABO SAN LUCAS": "cabo-san-lucas",
  "CARTAGENA": "cartagena", "COSTA MAYA": "costa-maya", "MAHAHUAL": "costa-maya",
  "CURACAO": "curacao", "WILLEMSTAD": "curacao",
  "FALMOUTH": "falmouth-jamaica", "GRAND TURK": "grand-turk",
  "GREAT STIRRUP": "great-stirrup", "HALF MOON CAY": "halfmoon-cay",
  "KEY WEST": "key-west", "LABADEE": "labadee",
  "MONTEGO BAY": "montego-bay", "PRINCESS CAYS": "princess-cays",
  "PUERTO VALLARTA": "puerto-vallarta", "ST KITTS": "st-kitts", "BASSETERRE": "st-kitts",
  "ST LUCIA": "st-lucia", "CASTRIES": "st-lucia", "TORTOLA": "tortola", "ROAD TOWN": "tortola",
  "JUNEAU": "juneau", "KETCHIKAN": "ketchikan", "SKAGWAY": "skagway",
  "VANCOUVER": "vancouver",
};

function normalizeDest(text: string): string {
  return text.toUpperCase().replace(/[^A-Z ]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Match a crew-typed AIS destination string to a known cruise location.
 * AIS destinations sometimes chain legs ("US MIA > BS NAS") — the LAST
 * matching segment wins (that's where the ship is headed).
 */
export function matchDestination(raw: string | null | undefined): CruiseLocation | null {
  if (!raw) return null;
  const norm = normalizeDest(raw);
  if (!norm) return null;
  let hit: string | null = null;
  for (const [alias, slug] of Object.entries(DEST_ALIASES)) {
    const idx = norm.lastIndexOf(alias);
    if (idx === -1) continue;
    // Require word boundaries so "MIA" can't match inside "MIAMI"'s neighbors.
    const before = idx === 0 ? " " : norm[idx - 1];
    const after = idx + alias.length >= norm.length ? " " : norm[idx + alias.length];
    if (before !== " " || after !== " ") continue;
    if (hit === null || alias.length > 2) hit = slug;
  }
  if (hit) return BY_SLUG.get(hit) ?? null;
  // Fallback: first location whose leading name token appears in the text.
  for (const loc of CRUISE_LOCATIONS) {
    const token = normalizeDest(loc.name.split(",")[0]);
    if (token.length >= 5 && norm.includes(token)) return loc;
  }
  return null;
}

// ── Proximity (port-call detection) ──────────────────────────────────────────
const EARTH_RADIUS_KM = 6371;
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/** Nearest known cruise location within `maxKm` of the point, or null. */
export function nearestPort(lat: number, lon: number, maxKm = 4): CruiseLocation | null {
  let best: CruiseLocation | null = null;
  let bestDist = maxKm;
  for (const loc of CRUISE_LOCATIONS) {
    const d = distanceKm(lat, lon, loc.lat, loc.lon);
    if (d <= bestDist) { best = loc; bestDist = d; }
  }
  return best;
}
