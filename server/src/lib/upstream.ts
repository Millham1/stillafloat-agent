// Two small guards for calls to a free third-party API that rate-limits in bursts (Open-Meteo).
//
// 2026-10-11: two full release-gate sweeps run minutes apart made the weather API answer 429 for a while,
// and the weather routes failed ("Weather fetch failed for amsterdam (429)", homepage cards 5 of 6) because
// the old code retried once, instantly, and fetched the same place from scratch on every request. So:
//   • fetchWithBackoff — retries a 429 or a 5xx or a dropped connection, waiting as the API asks
//     (Retry-After, capped) or a growing pause with jitter, instead of hammering it again at once;
//   • loaderCache — keeps a good answer for a few minutes (one upstream call per place, however many
//     visitors), shares a call already in flight, and, when a refresh fails, serves the last good answer
//     for a while longer: a slightly old forecast beats an error.

type Resp = { ok: boolean; status: number; headers: { get(name: string): string | null } };
export type FetchLike<R extends Resp = Response> = (url: string, init?: RequestInit) => Promise<R>;

export interface BackoffOptions {
  attempts?: number;
  /** Stop after this many attempts that THREW (a timeout, a dropped connection) — a 429/5xx answer still gets all `attempts`. Default: `attempts`. */
  attemptsOnThrow?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxWaitMs?: number;
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

/** How long to wait before retry number `attempt` (0-based): the server's Retry-After, else 400 ms doubling, plus jitter. Pure. */
export function backoffMs(attempt: number, retryAfter: string | null, random = Math.random, maxWaitMs = 4000): number {
  const asked = Number(retryAfter);
  if (retryAfter && Number.isFinite(asked) && asked >= 0) return Math.min(maxWaitMs, Math.ceil(asked * 1000));
  return Math.min(maxWaitMs, 400 * 2 ** attempt + Math.floor(random() * 250));
}

/** fetch, retrying 429/5xx/network errors up to `attempts` times in total. Returns the last response (ok or not); throws only if every attempt threw. */
export async function fetchWithBackoff<R extends Resp>(
  fetchImpl: FetchLike<R>, url: string, init: RequestInit | undefined, opts: BackoffOptions = {},
): Promise<R> {
  const attempts = opts.attempts ?? 3;
  const throwLimit = opts.attemptsOnThrow ?? attempts;
  let thrown = 0;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: R | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetchImpl(url, init);
      if (!RETRYABLE(res.status)) return res;
      last = res;
      lastErr = undefined;
      if (attempt < attempts - 1) await sleep(backoffMs(attempt, res.headers.get("retry-after"), opts.random, opts.maxWaitMs));
    } catch (err) {
      lastErr = err;
      last = undefined;
      if (++thrown >= throwLimit) break;
      if (attempt < attempts - 1) await sleep(backoffMs(attempt, null, opts.random, opts.maxWaitMs));
    }
  }
  if (last) return last;
  throw lastErr;
}

export interface LoaderCacheOptions {
  ttlMs: number;       // how long an answer is served without asking again
  staleMs: number;     // how long past that an answer may stand in when a refresh fails
  max?: number;        // entries kept (the whole map is dropped when it is exceeded)
  now?: () => number;
}

/** The promise's value, or null if it has not settled within `ms` (it keeps running; a rejection inside the window still rejects). */
export function raceWithin<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); timer.unref?.(); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** What a cache lookup hands back: the value, when it was loaded, and whether it is the old copy standing in for a refresh that failed. */
export interface Loaded<T> { value: T; at: number; stale: boolean }

export function loaderCache<T>(opts: LoaderCacheOptions) {
  const now = opts.now ?? Date.now;
  const max = opts.max ?? 500;
  const store = new Map<string, { value: T; at: number }>();
  const inflight = new Map<string, Promise<Loaded<T>>>();
  // getMeta is get() that also says whether the answer is the stale stand-in — callers that must tell a
  // reader "this is an earlier forecast" (the weather route) need that; everyone else uses get().
  function getMeta(key: string, load: () => Promise<T>): Promise<Loaded<T>> {
    const hit = store.get(key);
    if (hit && now() - hit.at < opts.ttlMs) return Promise.resolve({ value: hit.value, at: hit.at, stale: false });
    const running = inflight.get(key);
    if (running) return running;
    const p = (async (): Promise<Loaded<T>> => {
      try {
        const value = await load();
        if (store.size >= max) store.clear();
        const at = now();
        store.set(key, { value, at });
        return { value, at, stale: false };
      } catch (err) {
        if (hit && now() - hit.at < opts.ttlMs + opts.staleMs) return { value: hit.value, at: hit.at, stale: true };
        throw err;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }
  return {
    async get(key: string, load: () => Promise<T>): Promise<T> {
      return (await getMeta(key, load)).value;
    },
    getMeta,
    clear() { store.clear(); inflight.clear(); },
    size() { return store.size; },
  };
}
