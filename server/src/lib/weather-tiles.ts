// weather-tiles.ts — the homepage weather tiles (GET /api/weather with no place): up to 12 departure ports and
// 12 destinations, each a place's ten-day forecast card.
//
// Moved out of routes/weather.ts on 2026-10-19 so it can be built with injected fetches and an injected store and
// tested; the rules that were in the route are unchanged, and these are new:
//   • the last fully fresh payload is saved (platform_state "weather-tiles-last-good") and read back on boot into
//     the cache as an EXPIRED copy, before the first request is answered — so "top up a thin list from the last
//     good payload" and "serve the last good payload when the build comes up short" work from the first second
//     after a restart, not only after the process has built one good payload itself;
//   • a place whose fetch fails shows its own last good forecast (lib/weather-forecast.ts keeps one per place,
//     saved the same way) instead of a gap — the 2026-10-17 homepage had no Miami tile that way;
//   • one build at a time, and a visitor who finds a known copy waits at most TILES_ANSWER_BUDGET_MS for the
//     rebuild — a slow Open-Meteo gets the earlier tiles, flagged `stale: true`, while the rebuild finishes.
// Mark 2026-10-19: "the dev server should always have a working website top to bottom".

import { CRUISE_LOCATIONS, type CruiseLocation } from "./ports";
import { forecastService, publicLocation, type ForecastAnswer } from "./weather-forecast";
import { lastGoodStore, type LastGoodStoreOptions } from "./last-good-store";
import { raceWithin } from "./upstream";

export type WeatherCard = { slug: string; type: string; [k: string]: unknown };
export type WeatherPayload = { embarkation: WeatherCard[]; destinations: WeatherCard[]; [k: string]: unknown };
/** What is saved: the cards and when they were built — the port lists are rebuilt from the code on load. */
type SavedTiles = { generatedAt: string; embarkation: WeatherCard[]; destinations: WeatherCard[] };

export const TILES_STORE_KEY = "weather-tiles-last-good";
/** A fully fresh payload is served from memory this long. */
export const TILES_FRESH_MS = 15 * 60_000;
/** A payload that needed an earlier copy for some cards is served this long — the next request retries soon. */
export const TILES_PATCHED_MS = 3 * 60_000;
/** After a build that came up too short to show, the known copy stands this long before the next try. */
export const TILES_FAILED_MS = 60_000;
/** A visitor who finds a known copy waits this long for the rebuild before being answered from the copy. */
export const TILES_ANSWER_BUDGET_MS = 4000;
/** A saved payload older than this is not used. */
export const TILES_LAST_GOOD_MAX_MS = 7 * 24 * 3_600_000;

function featuredByType(locations: CruiseLocation[], type: string, limit = 12) {
  const typed = locations.filter((l) => l.type === type);
  const featured = typed.filter((l) => l.featured);
  const rest = typed.filter((l) => !l.featured);
  const combined = [...featured, ...rest];
  const seen = new Set<string>();
  return combined
    .filter((l) => { if (seen.has(l.slug)) return false; seen.add(l.slug); return true; })
    .slice(0, limit);
}

// The homepage shows up to 12 departure ports and 12 destinations; fewer than 6 of either reads as
// broken. open-meteo fails in bursts, and 2026-10-09 14:21Z the release gate caught the dev homepage
// with 5 destination cards cached for 15 min: 7 of 12 destination fetches had failed while the
// embarkation side was fine, so the old "at least half of ALL cards" guard let the thin set through.
// Judge each list on its own: a list short of MIN_CARDS_PER_TYPE is topped up from the last good
// payload (same slugs never twice), and a payload that needed topping up is cached only briefly.
export const MIN_CARDS_PER_TYPE = 6;
export function fillThinLists<T extends { slug: string; type: string }>(
  fresh: T[], cached: T[] | null | undefined, min = MIN_CARDS_PER_TYPE,
): { cards: T[]; fullyFresh: boolean } {
  const out = [...fresh];
  let fullyFresh = true;
  for (const type of ["embarkation", "destination"]) {
    const have = fresh.filter((c) => c.type === type);
    if (have.length >= min) continue;
    fullyFresh = false;
    const seen = new Set(have.map((c) => c.slug));
    for (const c of cached ?? []) {
      if (c.type === type && !seen.has(c.slug)) { out.push(c); seen.add(c.slug); }
    }
  }
  return { cards: out, fullyFresh };
}

function isSavedTiles(v: unknown): v is SavedTiles {
  const s = v as Partial<SavedTiles> | null;
  const cardsOk = (list: unknown) => Array.isArray(list) && list.length > 0
    && list.every((c) => !!c && typeof c === "object" && typeof (c as WeatherCard).slug === "string" && typeof (c as WeatherCard).type === "string");
  return !!s && typeof s === "object" && typeof s.generatedAt === "string" && cardsOk(s.embarkation) && cardsOk(s.destinations);
}

/** One answer for the route: the payload as it goes out, and whether it is a settled, fully fresh one (so a shared cache may keep it). */
export interface TilesAnswer { payload: WeatherPayload; settled: boolean }

export interface TilesDeps {
  forecasts?: {
    fetchForecastOrLastGood(loc: CruiseLocation): Promise<ForecastAnswer>;
    lastGood: { ready(maxWaitMs?: number): Promise<void> };
  };
  locations?: CruiseLocation[];
  read?: LastGoodStoreOptions<SavedTiles>["read"];
  write?: LastGoodStoreOptions<SavedTiles>["write"];
  now?: () => number;
  /** How long a visitor waits for a rebuild when an earlier copy is known (tests shorten it). */
  answerBudgetMs?: number;
}

export function makeTilesService(deps: TilesDeps = {}) {
  const now = deps.now ?? Date.now;
  const locations = deps.locations ?? CRUISE_LOCATIONS;
  const forecasts = deps.forecasts ?? forecastService;
  const budgetMs = deps.answerBudgetMs ?? TILES_ANSWER_BUDGET_MS;
  const saved = lastGoodStore<SavedTiles>({
    key: TILES_STORE_KEY, maxEntries: 1, maxAgeMs: TILES_LAST_GOOD_MAX_MS, saveDelayMs: 1000,
    validate: isSavedTiles, read: deps.read, write: deps.write, now,
  });

  let cache: { payload: WeatherPayload; expiresAt: number; stale: boolean } | null = null;
  let building: Promise<TilesAnswer> | null = null;

  const portList = (type: string) => locations.filter((l) => l.type === type).map(publicLocation).sort((a, b) => a.name.localeCompare(b.name));
  function payloadOf(generatedAt: string, cards: WeatherCard[]): WeatherPayload {
    return {
      ok: true,
      generatedAt,
      embarkation: cards.filter((c) => c.type === "embarkation"),
      destinations: cards.filter((c) => c.type === "destination"),
      allEmbarkationPorts: portList("embarkation"),
      allDestinations: portList("destination"),
    };
  }
  const present = (payload: WeatherPayload, stale: boolean): WeatherPayload => (stale ? { ...payload, stale: true } : payload);

  /** Read the saved copies (a request never waits more than a couple of seconds for them) and, if this process has no payload of its own yet, start from the saved one — expired, so it is rebuilt at once but stands in until then. */
  async function ready(): Promise<void> {
    await Promise.all([saved.ready(), forecasts.lastGood.ready()]);
    if (!cache) {
      const e = saved.get("tiles");
      if (e) cache = { payload: payloadOf(e.value.generatedAt, [...e.value.embarkation, ...e.value.destinations]), expiresAt: 0, stale: true };
    }
  }

  async function buildOnce(): Promise<TilesAnswer> {
    const targets = [...featuredByType(locations, "embarkation", 12), ...featuredByType(locations, "destination", 12)];
    // Tolerate partial upstream failures: a single bad open-meteo fetch must never blank the whole homepage.
    // A place that cannot be fetched shows its own last good forecast, if one is known.
    const settled = await Promise.allSettled(targets.map((l) => forecasts.fetchForecastOrLastGood(l)));
    const cards: WeatherCard[] = [];
    let earlierCopies = 0;
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      cards.push(r.value.forecast as WeatherCard);
      if (r.value.staleSince) earlierCopies++;
    }
    // A thin list (fewer than MIN_CARDS_PER_TYPE departure ports OR destinations) is topped up from
    // the last good payload instead of being shown — or cached — as is. See fillThinLists.
    const lastGood = cache ? [...cache.payload.embarkation, ...cache.payload.destinations] : null;
    const { cards: filled, fullyFresh } = fillThinLists(cards, lastGood);
    const minOk = Math.ceil(targets.length / 2);
    if (filled.length < minOk) {
      // Too little to show. With a known payload, that one stands (briefly, then retried); with none, what came back is sent, uncached, as before.
      if (cache) {
        cache = { ...cache, expiresAt: now() + TILES_FAILED_MS, stale: true };
        return { payload: present(cache.payload, true), settled: false };
      }
      return { payload: payloadOf(new Date(now()).toISOString(), filled), settled: false };
    }
    const stale = !fullyFresh || earlierCopies > 0;
    const payload = payloadOf(new Date(now()).toISOString(), filled);
    // Only a healthy payload is cached, so an empty result is never pinned for 15 min; one that needed an
    // earlier copy for some card is cached for 3 min only, so the next fetch retries soon.
    cache = { payload, expiresAt: now() + (stale ? TILES_PATCHED_MS : TILES_FRESH_MS), stale };
    if (!stale) saved.note("tiles", { generatedAt: payload.generatedAt as string, embarkation: payload.embarkation, destinations: payload.destinations });
    return { payload: present(payload, stale), settled: !stale };
  }

  function startBuild(): Promise<TilesAnswer> {
    if (!building) {
      const p = buildOnce().finally(() => { if (building === p) building = null; });
      p.catch(() => {});   // a rebuild nobody is waiting for any more must not become an unhandled rejection
      building = p;
    }
    return building;
  }

  return {
    ready,
    /** Read the saved copies now (index.ts calls this before the server listens). */
    prime(): Promise<void> { return ready(); },
    /** The tiles for a request. Throws only if the build itself breaks; the route answers 500 then. */
    async getTiles(): Promise<TilesAnswer> {
      await ready();
      if (cache && now() < cache.expiresAt) return { payload: present(cache.payload, cache.stale), settled: !cache.stale };
      const build = startBuild();
      if (!cache) return build;
      const known = cache;
      return (await raceWithin(build, budgetMs)) ?? { payload: present(known.payload, true), settled: false };
    },
    /** Build once in the background after boot so the first visitor finds a fresh payload. */
    async warm(): Promise<string> {
      await ready();
      if (cache && now() < cache.expiresAt) return "weather tiles already fresh";
      const a = await startBuild();
      return a.settled ? "weather tiles built fresh" : "weather tiles built, with earlier copies standing in for some cards";
    },
    /** The payload this process holds, whatever its age (the route's last resort), flagged stale. */
    lastKnown(): WeatherPayload | null { return cache ? present(cache.payload, true) : null; },
    flush(): Promise<void> { return saved.flush(); },
  };
}

const tiles = makeTilesService();
export const getWeatherTiles = () => tiles.getTiles();
export const lastKnownWeatherTiles = () => tiles.lastKnown();
export const primeWeatherOnBoot = () => tiles.prime();
export const warmWeatherTiles = () => tiles.warm();
