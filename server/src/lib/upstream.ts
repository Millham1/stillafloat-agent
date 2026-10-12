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

export function loaderCache<T>(opts: LoaderCacheOptions) {
  const now = opts.now ?? Date.now;
  const max = opts.max ?? 500;
  const store = new Map<string, { value: T; at: number }>();
  const inflight = new Map<string, Promise<T>>();
  return {
    async get(key: string, load: () => Promise<T>): Promise<T> {
      const hit = store.get(key);
      if (hit && now() - hit.at < opts.ttlMs) return hit.value;
      const running = inflight.get(key);
      if (running) return running;
      const p = (async () => {
        try {
          const value = await load();
          if (store.size >= max) store.clear();
          store.set(key, { value, at: now() });
          return value;
        } catch (err) {
          if (hit && now() - hit.at < opts.ttlMs + opts.staleMs) return hit.value;
          throw err;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, p);
      return p;
    },
    clear() { store.clear(); inflight.clear(); },
    size() { return store.size; },
  };
}
