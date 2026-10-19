// last-good-store.ts — a keyed copy of "the last good answer" that survives a server restart.
//
// Why: the weather route's protections against a failing Open-Meteo (a topped-up card list, the stale
// forecast when a refresh fails — routes/weather.ts, lib/upstream.ts) all lived in memory, so they only
// worked once the process had ONE good answer. Right after a deploy restart there was none: a slow or
// refused Open-Meteo call became an empty tile list or a 500, twice in one weekend (2026-10-17 21:27Z, no
// Miami tile; 2026-10-19 14:44Z, three gate checks red five minutes after a restart, fine three minutes
// later). Mark 2026-10-19: "the dev server should always have a working website top to bottom".
//
// What: every good answer is noted here with the time it was good; the whole map is written (debounced) to
// platform_state under one key, and read back once on boot. An entry older than maxAgeMs is neither served
// nor saved. Nothing here ever throws into a request: a failed read means "start without a copy", a failed
// write is logged and tried again later. The store never writes before it has read (a failed read must not
// let a thin in-memory map overwrite the saved copy — the persistence.ts rule for read-modify-write).

import { logger } from "./logger";
import { readJson, writeJson } from "./persistence";

export interface LastGoodEntry<T> { at: number; value: T }

export interface LastGoodStoreOptions<T> {
  /** platform_state key the map is saved under. */
  key: string;
  /** Entries kept and saved; the oldest go first. */
  maxEntries: number;
  /** An entry older than this is neither served nor saved. */
  maxAgeMs: number;
  /** How long after the first unsaved change the save waits, so a burst of notes is one write. */
  saveDelayMs: number;
  /** Keep only saved entries the current code can still read (an older shape is dropped, not served). */
  validate?: (value: unknown) => value is T;
  /** Tests inject these; the defaults are platform_state (lib/persistence.ts) and the real clock. */
  read?: (key: string) => Promise<unknown>;
  write?: (key: string, payload: unknown) => Promise<unknown>;
  now?: () => number;
}

/** After a failed read or write, the next try is no sooner than this. */
export const LAST_GOOD_RETRY_MS = 60_000;

type Saved = { savedAt?: string; entries?: Record<string, { at?: unknown; value?: unknown }> } | null;

export function lastGoodStore<T>(opts: LastGoodStoreOptions<T>) {
  const now = opts.now ?? Date.now;
  const read = opts.read ?? ((key: string) => readJson<unknown>(key, null));
  const write = opts.write ?? ((key: string, payload: unknown) => writeJson(key, payload));
  const entries = new Map<string, LastGoodEntry<T>>();
  let loaded = false;
  let loading: Promise<void> | null = null;
  let failedAt = 0;
  let dirty = false;
  let saving = false;
  let timer: NodeJS.Timeout | null = null;

  const usable = (e: LastGoodEntry<T>) => now() - e.at <= opts.maxAgeMs;

  function prune(): void {
    for (const [k, e] of entries) if (!usable(e)) entries.delete(k);
    if (entries.size <= opts.maxEntries) return;
    const oldestFirst = [...entries].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of oldestFirst.slice(0, entries.size - opts.maxEntries)) entries.delete(k);
  }

  async function readSaved(): Promise<void> {
    try {
      const saved = (await read(opts.key)) as Saved;
      for (const [k, raw] of Object.entries(saved?.entries ?? {})) {
        if (!raw || typeof raw.at !== "number" || !Number.isFinite(raw.at)) continue;
        if (opts.validate ? !opts.validate(raw.value) : (raw.value === null || typeof raw.value !== "object")) continue;
        const entry: LastGoodEntry<T> = { at: raw.at, value: raw.value as T };
        if (!usable(entry)) continue;
        const cur = entries.get(k);
        if (!cur || cur.at < entry.at) entries.set(k, entry);   // never replace what this boot already learnt
      }
      prune();
      loaded = true;
    } catch (err) {
      failedAt = now();
      logger.warn({ err, key: opts.key }, "last-good: could not read the saved copy (starting without it)");
    }
  }

  /** Read the saved copy once. Never rejects. After a failed read it tries again, but not within a minute. */
  function load(): Promise<void> {
    if (loaded) return Promise.resolve();
    if (loading) return loading;
    if (failedAt && now() - failedAt < LAST_GOOD_RETRY_MS) return Promise.resolve();
    const p = readSaved();
    loading = p;
    void p.then(() => { if (loading === p) loading = null; });
    return p;
  }

  /** load(), but a request never waits longer than maxWaitMs for it. */
  async function ready(maxWaitMs = 2500): Promise<void> {
    if (loaded) return;
    let timeout: NodeJS.Timeout | undefined;
    const cap = new Promise<void>((resolve) => { timeout = setTimeout(resolve, maxWaitMs); timeout.unref?.(); });
    try { await Promise.race([load(), cap]); } finally { clearTimeout(timeout); }
  }

  function scheduleSave(delayMs: number): void {
    dirty = true;
    if (timer || saving) return;
    timer = setTimeout(() => { timer = null; void save(); }, delayMs);
    timer.unref?.();   // a bookkeeping write never keeps the process alive
  }

  async function save(): Promise<void> {
    if (saving) return;
    saving = true;
    let retryMs = opts.saveDelayMs;
    try {
      await load();
      if (!loaded) { retryMs = LAST_GOOD_RETRY_MS; return; }   // never write over a copy we could not read
      prune();
      dirty = false;
      const out: Record<string, LastGoodEntry<T>> = {};
      for (const [k, e] of entries) out[k] = e;
      await write(opts.key, { savedAt: new Date(now()).toISOString(), entries: out });
    } catch (err) {
      dirty = true;
      retryMs = LAST_GOOD_RETRY_MS;
      logger.warn({ err, key: opts.key }, "last-good: save failed (will try again)");
    } finally {
      saving = false;
      if (dirty && !timer) scheduleSave(retryMs);
    }
  }

  return {
    load,
    ready,
    /** Remember a good answer. */
    note(key: string, value: T, at: number = now()): void {
      entries.set(key, { at, value });
      if (entries.size > opts.maxEntries) prune();
      scheduleSave(opts.saveDelayMs);
    },
    /** The last good answer for the key, unless it is older than maxAgeMs. */
    get(key: string): LastGoodEntry<T> | undefined {
      const e = entries.get(key);
      return e && usable(e) ? e : undefined;
    },
    size(): number { return entries.size; },
    /** Write now if anything is unsaved (tests; and a clean shutdown if one is ever wired). */
    async flush(): Promise<void> {
      if (timer) { clearTimeout(timer); timer = null; }
      if (dirty) await save();
    },
  };
}
