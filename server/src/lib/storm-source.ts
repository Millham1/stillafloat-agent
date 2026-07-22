// storm-source.ts — pull raw tropical-cyclone data from NOAA/NHC (free, no key).
//
// Two products, combined:
//   • CurrentStorms.json — structured active/named systems, all basins.
//   • index-{at,ep,cp}.xml — the Tropical Weather Outlook (pre-named
//     disturbances / invests + formation chances) as RSS prose.
// Everything is best-effort: a failing source degrades to [] rather than throwing.

import { logger } from "./logger";

export interface RawSystem {
  nhcId: string;
  basin: "atlantic" | "eastern_pacific" | "central_pacific";
  name: string;
  classification: string;          // "Hurricane", "Tropical Storm", "Disturbance", …
  lat: number | null;
  lon: number | null;
  intensity: string | null;        // e.g. "65 kt"
  movement: string | null;
  formationChance: number | null;  // 0-100 (Tropical Weather Outlook)
  advisoryUrl: string | null;
  coneUrl: string | null;          // NHC forecast cone/track image (named systems)
  outlookText?: string;            // TWO prose (for the AI to summarise)
  source: "current_storms" | "outlook";
  raw: unknown;
}

const OUTLOOK_FEEDS: Array<{ url: string; basin: RawSystem["basin"] }> = [
  { url: "https://www.nhc.noaa.gov/index-at.xml", basin: "atlantic" },
  { url: "https://www.nhc.noaa.gov/index-ep.xml", basin: "eastern_pacific" },
  { url: "https://www.nhc.noaa.gov/index-cp.xml", basin: "central_pacific" },
];

async function fetchText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) { logger.warn({ url, status: r.status }, "storm-source: non-200"); return null; }
    return await r.text();
  } catch (err) {
    logger.warn({ url, err }, "storm-source: fetch failed");
    return null;
  }
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

function basinFromId(id: string): RawSystem["basin"] {
  const p = id.slice(0, 2).toUpperCase(); // AL092025 / EP052025 / CP012025
  if (p === "EP") return "eastern_pacific";
  if (p === "CP") return "central_pacific";
  return "atlantic";
}

function classify(code: string): string {
  const map: Record<string, string> = {
    TD: "Tropical Depression", TS: "Tropical Storm", HU: "Hurricane",
    MH: "Major Hurricane",
    STS: "Subtropical Storm", SD: "Subtropical Depression",
    PTC: "Potential Tropical Cyclone",
  };
  return map[code.toUpperCase()] ?? (code || "Tropical System");
}

/** Active/named systems from CurrentStorms.json (all basins). */
async function fetchActiveStorms(): Promise<RawSystem[]> {
  const txt = await fetchText("https://www.nhc.noaa.gov/CurrentStorms.json");
  if (!txt) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(txt); } catch { return []; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const storms: any[] = Array.isArray((parsed as any)?.activeStorms) ? (parsed as any).activeStorms : [];
  return storms.map((s): RawSystem => {
    const id = String(s.id ?? s.binNumber ?? "").trim();
    return {
      nhcId: id || `${s.name ?? "system"}-${s.classification ?? ""}`,
      basin: id ? basinFromId(id) : "atlantic",
      name: s.name ? String(s.name) : "Unnamed system",
      classification: classify(String(s.classification ?? "")),
      lat: num(s.latitudeNumeric ?? s.latitude),
      lon: num(s.longitudeNumeric ?? s.longitude),
      intensity: s.intensity ? `${s.intensity} kt` : null,
      movement: s.movementDir && s.movementSpeed
        ? `${s.movementDir} at ${s.movementSpeed} kt` : null,
      formationChance: null,
      advisoryUrl: s?.publicAdvisory?.url ? String(s.publicAdvisory.url) : null,
      coneUrl: s?.forecastCone?.url ? String(s.forecastCone.url)
        : (s?.forecastTrack?.url ? String(s.forecastTrack.url) : null),
      source: "current_storms",
      raw: s,
    };
  });
}

/** Extract the max "formation chance … N percent" figure from TWO prose. */
function maxFormationChance(text: string): number | null {
  const valid: number[] = [];
  for (const m of text.matchAll(/(\d{1,3})\s*percent/gi)) {
    const n = Number(m[1]);
    if (n >= 0 && n <= 100) valid.push(n);
  }
  return valid.length ? Math.max(...valid) : null;
}

/**
 * Tropical Weather Outlook disturbances per basin. NHC bundles the whole outlook
 * into one RSS item of prose; we surface one "disturbance" system per basin when
 * any formation chance is mentioned, and hand the full text to the AI to describe
 * the individual areas. (Precise per-invest parsing is a fast-follow — see the
 * ship-tracking-API task.)
 */
async function fetchOutlooks(): Promise<RawSystem[]> {
  const out: RawSystem[] = [];
  for (const feed of OUTLOOK_FEEDS) {
    const xml = await fetchText(feed.url);
    if (!xml) continue;
    // Grab the "Tropical Weather Outlook" item's <description> (CDATA-wrapped).
    const item = xml.split(/<item>/i).find((chunk) => /Tropical Weather Outlook/i.test(chunk));
    if (!item) continue;
    const descMatch = item.match(/<description>([\s\S]*?)<\/description>/i);
    const desc = (descMatch?.[1] ?? "")
      .replace(/<!\[CDATA\[|\]\]>/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!desc) continue;
    const chance = maxFormationChance(desc);
    // Only surface disturbances with a meaningful formation chance (>=25%).
    // Skips "near 0 percent / not expected to develop" noise.
    if (chance == null || chance < 25) continue;
    out.push({
      nhcId: `TWO-${feed.basin}`,
      basin: feed.basin,
      name: "Area(s) of disturbed weather",
      classification: "Disturbance",
      lat: null, lon: null, intensity: null, movement: null,
      formationChance: chance,
      advisoryUrl: feed.url,
      coneUrl: null,
      outlookText: desc.slice(0, 2000),
      source: "outlook",
      raw: { basin: feed.basin, outlook: desc.slice(0, 2000) },
    });
  }
  return out;
}

/** All current systems worth considering (active storms + outlook disturbances). */
export async function fetchSystems(): Promise<RawSystem[]> {
  const [active, outlooks] = await Promise.all([fetchActiveStorms(), fetchOutlooks()]);
  return [...active, ...outlooks];
}

/** A canned system for exercising the pipeline off-season / in tests / for demos. */
export function fixtureSystem(): RawSystem {
  return {
    nhcId: "AL092026-FIXTURE",
    basin: "atlantic",
    name: "Fiona",
    classification: "Tropical Storm",
    lat: 15.2, lon: -60.1,
    intensity: "55 kt",
    movement: "WNW at 14 kt",
    formationChance: null,
    advisoryUrl: "https://www.nhc.noaa.gov/",
    coneUrl: null,
    source: "current_storms",
    raw: { fixture: true, note: "sample system for the storm-alert pipeline" },
  };
}

/** Public NOAA graphics per basin (verified live): satellite sector + 7-day outlook image. */
export function basinGraphics(basin: RawSystem["basin"]): { satellite: string; outlook: string } {
  switch (basin) {
    case "eastern_pacific":
      return {
        satellite: "https://cdn.star.nesdis.noaa.gov/GOES18/ABI/SECTOR/eep/GEOCOLOR/latest.jpg",
        outlook: "https://www.nhc.noaa.gov/xgtwo/two_pac_7d0.png",
      };
    case "central_pacific":
      return {
        satellite: "https://cdn.star.nesdis.noaa.gov/GOES18/ABI/SECTOR/hi/GEOCOLOR/latest.jpg",
        outlook: "https://www.nhc.noaa.gov/xgtwo/two_pac_7d0.png",
      };
    default: // atlantic
      return {
        satellite: "https://cdn.star.nesdis.noaa.gov/GOES19/ABI/SECTOR/taw/GEOCOLOR/latest.jpg",
        outlook: "https://www.nhc.noaa.gov/xgtwo/two_atl_7d0.png",
      };
  }
}
