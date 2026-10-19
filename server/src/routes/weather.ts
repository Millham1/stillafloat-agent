import { Router, type IRouter, type Request, type Response } from "express";
import { CRUISE_LOCATIONS, type CruiseLocation } from "../lib/ports";
import { weatherSynopsis, type Lang } from "../lib/weather-voice";
import { fetchForecastOrLastGood, publicLocation, _resetForecastCache } from "../lib/weather-forecast";
import { getWeatherTiles, lastKnownWeatherTiles, fillThinLists, MIN_CARDS_PER_TYPE } from "../lib/weather-tiles";

// The forecast fetch itself (Open-Meteo, cached, with its saved last-good copy) lives in lib/weather-forecast.ts since
// 2026-10-17 so the group journey can use it; the homepage tiles (the cache, the thin-list top-up, the saved payload) live
// in lib/weather-tiles.ts since 2026-10-19. Both re-exported here as before.
export { _resetForecastCache, fillThinLists, MIN_CARDS_PER_TYPE };

const router: IRouter = Router();


// forecast.html can arrive with raw coordinates (the weather page's search dropdown, and the
// Spanish tiles) instead of a port slug. Those visits used to fetch Open-Meteo straight from the
// browser and skipped this route — so they never got Mark's synopsis (Mark, 2026-10-02: Bermuda
// had no ten-day synopsis). Resolve coords to a known port when one is close, otherwise an ad-hoc
// location, and serve them the same payload the slug path gets.
const SNAP_KM = 30;
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(bLat - aLat), dLon = r(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
export function cleanPlaceName(raw: unknown): string {
  return String(raw ?? "").replace(/[^\p{L}\p{N} ,.'’()-]/gu, "").trim().slice(0, 60);
}
export function resolveCoords(latRaw: unknown, lonRaw: unknown, nameRaw: unknown): CruiseLocation | null {
  const lat = Number(latRaw), lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  let best: CruiseLocation | undefined, bestKm = SNAP_KM;
  for (const l of CRUISE_LOCATIONS) {
    const km = haversineKm(lat, lon, l.lat, l.lon);
    if (km < bestKm) { best = l; bestKm = km; }
  }
  if (best) return best;
  // The name is visitor-supplied and ends up in the synopsis prompt: keep it short and plain.
  const name = cleanPlaceName(nameRaw) || `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  return { slug: `ll:${lat.toFixed(2)},${lon.toFixed(2)}`, name, type: "destination", lat, lon };
}

// The forecast page's hero photo. The browser used to call Pexels itself with the API key
// written into forecast.html — public on the page and in the public repo (found 2026-10-02).
// The key now stays on the server (PEXELS_API_KEY in shared.env) and the page asks here.
// One lookup per place per week, and an hourly ceiling on upstream calls so this open
// endpoint cannot be used to burn the Pexels quota (200 requests an hour). No key, no
// result, over budget or any failure → "" and the page keeps its gradient.
export const HERO_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const HERO_HOURLY_BUDGET = 120;
const HERO_CACHE_MAX = 2000;
const heroCache = new Map<string, { url: string; expiresAt: number }>();
let heroWindow = { start: 0, calls: 0 };
export function _resetHero() { heroCache.clear(); heroWindow = { start: 0, calls: 0 }; }

type HeroFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export async function heroImageUrl(
  nameRaw: unknown,
  key: string = process.env["PEXELS_API_KEY"] || "",
  fetchImpl: HeroFetch = fetch as unknown as HeroFetch,
  now: () => number = Date.now,
): Promise<string> {
  const name = cleanPlaceName(nameRaw);
  if (!name || !key) return "";
  const cacheKey = name.toLowerCase();
  const hit = heroCache.get(cacheKey);
  if (hit && now() < hit.expiresAt) return hit.url;

  if (now() - heroWindow.start >= 60 * 60 * 1000) heroWindow = { start: now(), calls: 0 };
  if (heroWindow.calls >= HERO_HOURLY_BUDGET) return "";
  heroWindow.calls++;

  let url = "";
  try {
    const res = await fetchImpl(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(name + " cruise port")}&per_page=1`,
      { headers: { authorization: key }, signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) return "";                    // a failed lookup is not cached — the next visit retries
    const data = (await res.json()) as { photos?: Array<{ src?: { landscape?: unknown } }> };
    const candidate = String(data.photos?.[0]?.src?.landscape ?? "");
    // Only a Pexels image address ever goes back to the page (it lands in a CSS url()).
    if (/^https:\/\/images\.pexels\.com\/[A-Za-z0-9/._?=&%-]+$/.test(candidate)) url = candidate;
  } catch {
    return "";
  }
  if (heroCache.size >= HERO_CACHE_MAX) heroCache.clear();
  heroCache.set(cacheKey, { url, expiresAt: now() + HERO_TTL_MS });
  return url;
}

router.get("/weather/hero", async (req: Request, res: Response) => {
  const url = await heroImageUrl(req.query["q"]);
  res.setHeader("Cache-Control", url ? "public, max-age=86400" : "no-store");
  res.json({ ok: true, url });
});

router.get("/weather", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1800");
  try {
    const place = String(req.query.place || "").trim();
    const byCoords = req.query.lat !== undefined || req.query.lon !== undefined;

    if (place || byCoords) {
      const loc = byCoords
        ? resolveCoords(req.query.lat, req.query.lon, req.query.name)
        : CRUISE_LOCATIONS.find((l) => l.slug === place);
      if (!loc) {
        res.status(byCoords ? 400 : 404).json({ ok: false, error: byCoords ? "Bad coordinates" : "Destination not found" });
        return;
      }
      // Open-Meteo slow or refusing → the last good forecast of this place (this run's, or the one saved before the
      // last restart), flagged `stale` with the time it was good; only a place nothing is known about is a 500.
      const { forecast, staleSince } = await fetchForecastOrLastGood(loc);
      // The synopsis is Mark's read of the week (lib/weather-voice.ts): written in his voice,
      // cached per place+language for six hours, never a restatement of the table. Written from an earlier
      // copy of the forecast it is not cached, so it does not outlive the copy.
      const lang: Lang = String(req.query.lang || "").toLowerCase() === "es" ? "es" : "en";
      const synopsis = await weatherSynopsis(loc, forecast.forecast, lang, undefined, undefined, { cache: !staleSince });
      if (staleSince) res.setHeader("Cache-Control", "s-maxage=60");   // a shared cache must not pin an earlier copy for 15 minutes
      res.json({ ok: true, forecast: { ...forecast, synopsis, ...(staleSince ? { stale: true, staleSince } : {}) } });
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

    // The homepage tiles (lib/weather-tiles.ts): cached 15 minutes, topped up from the last good payload — which
    // survives a restart — and, if that was topped up, sent with a short cache life and `stale: true`.
    try {
      const { payload, settled } = await getWeatherTiles();
      if (!settled) res.setHeader("Cache-Control", "s-maxage=60");
      res.json(payload);
    } catch (error) {
      // Last resort: serve what this process holds instead of blanking the homepage.
      const known = lastKnownWeatherTiles();
      if (!known) throw error;
      res.setHeader("Cache-Control", "s-maxage=60");
      res.json(known);
    }
  } catch (error) {
    res.status(500).json({ ok: false, error: (error as Error).message, embarkation: [], destinations: [] });
  }
});

export default router;
