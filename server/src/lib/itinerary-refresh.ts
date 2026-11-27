/**
 * itinerary-refresh.ts — keep planned_sailings stocked from CruiseMapper.
 *
 * Mark, 2026-09-21: "every ship should have an itinerary that is updated once a
 * month or so. this can be pulled off the internet as well and does not need an
 * API." This is that job. It costs nothing: no key, no browser, no per-call
 * billing. The paid alternative (Live-AIS /vessel/{mmsi}/ports) would run about
 * 1,575 credits a month for the fleet against a 2,500-credit balance.
 *
 * Why it matters: the storm detector used to infer a ship's normal run from the
 * ports terrestrial AIS happened to hear her at, and filed 25 false diversions in
 * three days — every one a scheduled call at a small private island no shore
 * receiver covers. With a published itinerary on file it stops guessing.
 *
 * Parsing lives in cruisemapper.ts (pure, tested). This file is the I/O: fetch,
 * pace, resolve ports to slugs, upsert.
 */

import { getSupabase } from "./persistence";
import { logger } from "./logger";
import { after, briefly } from "./brief-error";
import { CRUISEMAPPER_BASE as BASE } from "./cruisemapper";
import {
  fetchCruiseMapper, isNonPort, pageIdentity, parsePortTable, parseSchedule, resolvePort, type ScheduleRow,
} from "./cruisemapper";
import { shipNameKeys } from "./cruise-api-core";

/** ~50 requests a minute. We are a guest on a free site; do not hammer it. */
const PAUSE_MS = 1200;
/** Far enough back to catch a sailing already under way. */
const BACK_DAYS = 21;
/**
 * EVERY sailing the site lists is kept (about 17 months ahead). This was 90 days and 12 sailings a ship,
 * which was enough for the storm tracker it was written for and useless for booking: Mark, 2026-11-27,
 * on finding the Vacation Genie could not see Islander past December: "That's ridiculous when people
 * are planning up to 2 years out." and "we need to be able to retrieve the sailings for all cruise lines
 * that fall within the requested dates in order for the genie to work. if it is faster to keep this info
 * in a table then that is what we do."
 *
 * What keeps the monthly run short is not reading less, it is not re-reading: a sailing's ports cost one
 * request each, so a sailing already on file is believed until it is REREAD_AFTER_DAYS old, except inside
 * NEAR_DAYS, where the storm tracker needs today's ports and every run reads them again. The first run
 * after this change reads everything (about 100 sailings a ship); the ones after it read a month's worth.
 */
const NEAR_DAYS = 90;
const FWD_DAYS = 800;
const REREAD_AFTER_DAYS = 100;
export const SOURCE = "cruisemapper";
/** Backoff after a failed run, in minutes. Covers a provider blip without hammering. */
const RETRY_DELAYS_MIN = [5, 20, 60, 180] as const;
/**
 * Mark, 2026-09-25: "it is only supposed to fire once a month at the beginning
 * of the month." So: the 1st of each month at RUN_HOUR_UTC (04:00/05:00 New
 * York), plus a boot run ONLY when the newest CruiseMapper row is older than
 * STALE_AFTER_DAYS — a rebuilt box is stocked once, and a redeploy is not a
 * fleet crawl (eleven restarts on 2026-09-24 ran the whole pass four times).
 */
export const RUN_HOUR_UTC = 9;
export const STALE_AFTER_DAYS = 35;
const BOOT_CHECK_DELAY_MS = 5 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RefreshOptions {
  /** Stop after this many ships. Unset = the whole fleet. */
  limit?: number;
  /** Parse and report without writing. */
  dryRun?: boolean;
  /** Only this ship, by registry name. */
  shipName?: string;
}

export interface RefreshResult {
  ships: number;
  sailings: number;
  portCalls: number;
  unmatchedPorts: number;
  written: number;
  /** Listed sailings believed from the copy on file, not read again this run. */
  alreadyOnFile: number;
  /** Rows deleted because the site no longer lists the sailing. */
  removed: number;
  errors: { ship: string; error: string }[];
}

export interface RegistryShip {
  name: string;
  cruise_line: string | null;
  mmsi: string | null;
  imo: string | null;
  cruisemapper_id: string;
}

/**
 * Ships we sell whose sailings we need, but that are NOT switched on in the tracker registry.
 *
 * Margaritaville at Sea Beachcomber is the former Costa Fortuna (IMO 9239783, CruiseMapper page 723). Mark
 * switched the Costa Fortuna row off on 2026-09-22 ("remove norwegian sky and cost fortuna for the time
 * being and set a reminder to talk to me about it in mid December"), and that decision is still his. The
 * Vacation Genie offers her (she is in cabin_ships), so her schedule is read here under her own name
 * without touching that row: no tracking, no public ship list, only planned sailings. When the registry
 * row is renamed and switched back on, delete this entry (a ship listed both ways is read once).
 */
export const SOLD_NOT_TRACKED: readonly RegistryShip[] = [
  { name: "Margaritaville at Sea Beachcomber", cruise_line: "Margaritaville at Sea", mmsi: null, imo: "9239783", cruisemapper_id: "723" },
];

function isoDay(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function refreshShip(ship: RegistryShip, opts: RefreshOptions, out: RefreshResult) {
  const url = `${BASE}/ships/Ship-${ship.cruisemapper_id}`;
  const page = await fetchCruiseMapper(url);

  // CruiseMapper ignores the slug and keys ONLY on the number: /ships/x-551 and
  // /ships/Carnival-Legend-551 both return ship 551. That is convenient here and
  // dangerous everywhere — a wrong id serves a DIFFERENT ship's itinerary with
  // HTTP 200 and no error, which is how you end up publishing one ship's ports
  // under another ship's name. Our ids were resolved by IMO offline, so confirm
  // the page still agrees before believing a word of it.
  const who = pageIdentity(page.body);
  const knows = (a: string | null, b: string | null) => Boolean(a && b && a === b);
  if (!knows(who.imo, ship.imo) && !knows(who.mmsi, ship.mmsi)) {
    throw new Error(
      `identity mismatch on page ${ship.cruisemapper_id}: page says imo=${who.imo ?? "?"} ` +
      `mmsi=${who.mmsi ?? "?"}, registry says imo=${ship.imo ?? "?"} mmsi=${ship.mmsi ?? "?"}`);
  }

  const lo = isoDay(-BACK_DAYS);
  const listed = parseSchedule(page.body).filter((s) => s.start >= lo && s.start <= isoDay(FWD_DAYS));

  // What is already on file for her from this source, so only what is new, near or old is read again.
  const { data: fileData, error: fileErr } = await getSupabase().from("planned_sailings")
    .select("ref,start_date,updated_at").eq("source", SOURCE).eq("ship_name", ship.name)
    .gte("start_date", lo).order("ref").limit(1000);
  if (fileErr) throw new Error(fileErr.message);
  const onFile = (fileData ?? []) as OnFile[];
  const wanted = sailingsToRead(listed, onFile, new Date());
  out.alreadyOnFile += listed.length - wanted.length;

  const supabase = getSupabase();
  for (const sched of wanted) {
    await sleep(PAUSE_MS);
    const raw = await fetchCruiseMapper(`${BASE}/ships/cruise.json?id=${sched.cruiseId}`, {
      referer: url, cookie: page.cookie, xhr: true,
    });
    const table = (JSON.parse(raw.body) as { result?: string }).result ?? "";
    const calls = parsePortTable(table, sched.start).filter((p) => !isNonPort(p.name));
    if (!calls.length) continue;

    const ports = calls.map(resolvePort);
    out.sailings += 1;
    out.portCalls += ports.length;
    out.unmatchedPorts += ports.filter((p) => !p.slug).length;
    const last = calls[calls.length - 1];
    const first = ports[0];
    const lastPort = ports[ports.length - 1];

    if (opts.dryRun) continue;
    const { error } = await supabase.from("planned_sailings").upsert({
      source: SOURCE,
      ref: `${SOURCE}:${sched.cruiseId}`,
      ship_name: ship.name,
      mmsi: ship.mmsi,
      operator: ship.cruise_line,
      start_date: sched.start,
      end_date: last?.date ?? null,
      from_code: first?.slug ?? null,
      to_code: lastPort?.slug ?? null,
      ports,
      updated_at: new Date().toISOString(),
    } as never, { onConflict: "ref" });
    if (error) throw new Error(error.message);
    out.written += 1;
  }

  // A sailing the site has stopped listing (cancelled, re-dated, the ship moved) must not stay on file as
  // something a traveler can be offered. Only her own rows from this source, only from today on, and
  // only inside the dates the page itself covers.
  if (!opts.dryRun) {
    const gone = refsNoLongerListed(listed, onFile, isoDay(0));
    for (let i = 0; i < gone.length; i += 100) {
      const { error } = await supabase.from("planned_sailings").delete().eq("source", SOURCE).in("ref", gone.slice(i, i + 100));
      if (error) throw new Error(error.message);
    }
    out.removed += gone.length;
  }
}

interface OnFile { ref: string; start_date: string; updated_at: string | null }

/**
 * Which listed sailings need their ports read this run: one we do not hold, one inside the near horizon
 * (read every run), or one whose copy is older than REREAD_AFTER_DAYS. Exported for tests.
 */
export function sailingsToRead(listed: readonly ScheduleRow[], onFile: readonly OnFile[], now: Date): ScheduleRow[] {
  const held = new Map(onFile.map((r) => [r.ref, r.updated_at]));
  const near = new Date(now.getTime() + NEAR_DAYS * 86_400_000).toISOString().slice(0, 10);
  const oldBefore = now.getTime() - REREAD_AFTER_DAYS * 86_400_000;
  return listed.filter((s) => {
    const ref = `${SOURCE}:${s.cruiseId}`;
    if (!held.has(ref)) return true;
    if (s.start <= near) return true;
    const at = Date.parse(held.get(ref) ?? "");
    return !Number.isFinite(at) || at < oldBefore;
  });
}

/**
 * Rows on file that the page no longer lists: from `today` on, and no later than the last sailing the
 * page shows (what lies beyond the page is unknown, not gone). An empty page removes nothing. Exported for tests.
 */
export function refsNoLongerListed(listed: readonly ScheduleRow[], onFile: readonly OnFile[], today: string): string[] {
  if (!listed.length) return [];
  const last = listed.reduce((m, s) => (s.start > m ? s.start : m), "");
  const now = new Set(listed.map((s) => `${SOURCE}:${s.cruiseId}`));
  return onFile.filter((r) => r.start_date >= today && r.start_date <= last && !now.has(r.ref)).map((r) => r.ref);
}

export async function refreshItineraries(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const out: RefreshResult = {
    ships: 0, sailings: 0, portCalls: 0, unmatchedPorts: 0, written: 0, alreadyOnFile: 0, removed: 0, errors: [],
  };
  const supabase = getSupabase();
  let q = supabase.from("ships")
    .select("name, cruise_line, mmsi, imo, cruisemapper_id")
    .eq("active", true)
    .not("cruisemapper_id", "is", null)
    .order("name");
  if (opts.shipName) q = q.eq("name", opts.shipName);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  // The ships we sell first (the fleet the Vacation Genie and the Room Concierge offer), then the rest of
  // the registry: the first full run takes hours, and a traveler's question must not wait behind an
  // expedition yacht.
  const { data: fleetData } = await supabase.from("cabin_ships").select("ship").eq("in_fleet", true);
  const fleet = new Set(((fleetData ?? []) as { ship: string }[]).flatMap((f) => shipNameKeys(f.ship)));
  const sold = (sh: RegistryShip) => shipNameKeys(sh.name).some((k) => fleet.has(k));
  const registry = (data ?? []) as RegistryShip[];
  const named = new Set(registry.map((r) => r.name));
  const extra = SOLD_NOT_TRACKED.filter((x) => !named.has(x.name) && (!opts.shipName || opts.shipName === x.name));
  const ships = [...registry, ...extra]
    .sort((a, b) => Number(sold(b)) - Number(sold(a)))
    .slice(0, opts.limit ?? Infinity);
  for (const ship of ships) {
    try {
      await refreshShip(ship, opts, out);
      out.ships += 1;
    } catch (err) {
      // One ship's bad page must not cost the other 312.
      out.errors.push({ ship: ship.name, error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(PAUSE_MS);
  }
  return out;
}

/** The next 1st-of-the-month run strictly after `now`. Exported for tests. */
export function nextMonthlyRunAt(now: Date, hourUtc = RUN_HOUR_UTC): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const thisMonth = new Date(Date.UTC(y, m, 1, hourUtc));
  return thisMonth.getTime() > now.getTime() ? thisMonth : new Date(Date.UTC(y, m + 1, 1, hourUtc));
}

/** Boot run only when the newest CruiseMapper row is missing or too old. Exported for tests. */
export function bootRefreshNeeded(newestUpdatedAt: string | null, now: Date, staleAfterDays = STALE_AFTER_DAYS): boolean {
  if (!newestUpdatedAt) return true;
  const age = now.getTime() - Date.parse(newestUpdatedAt);
  return !Number.isFinite(age) || age > staleAfterDays * 24 * 60 * 60 * 1000;
}

/**
 * A table that stops short of SHALLOW_DAYS ahead was filled by the old 90-day capture (or is half filled):
 * read everything now instead of waiting for the 1st. After one full pass the farthest sailing sits about
 * 500 days out, so this fires once per box, not on every restart. Exported for tests.
 */
export const SHALLOW_DAYS = 270;
export function tableIsShallow(farthestStart: string | null, now: Date, shallowDays = SHALLOW_DAYS): boolean {
  if (!farthestStart) return true;
  const ahead = (Date.parse(farthestStart + "T00:00:00Z") - now.getTime()) / 86_400_000;
  return !Number.isFinite(ahead) || ahead < shallowDays;
}

async function farthestCruiseMapperStart(): Promise<string | null> {
  const { data, error } = await getSupabase().from("planned_sailings")
    .select("start_date").eq("source", SOURCE)
    .order("start_date", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { start_date?: string | null } | null)?.start_date ?? null;
}

async function newestCruiseMapperRow(): Promise<string | null> {
  const { data, error } = await getSupabase().from("planned_sailings")
    .select("updated_at").eq("source", SOURCE)
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { updated_at?: string | null } | null)?.updated_at ?? null;
}

/**
 * The 1st of the month at RUN_HOUR_UTC, and at boot only if the table is empty
 * or stale. Itineraries are published months ahead and barely move, so a faster
 * cadence would just be traffic on someone else's free website.
 */
export function scheduleItineraryRefresh() {
  if (process.env["DISABLE_ITINERARY_REFRESH"] === "1") {
    logger.info("Itinerary refresh DISABLED (DISABLE_ITINERARY_REFRESH=1)");
    return;
  }

  let retries = 0;
  const tick = async () => {
    try {
      const r = await refreshItineraries();
      retries = 0;
      logger.info({
        ships: r.ships, sailings: r.sailings, portCalls: r.portCalls,
        portsWithoutAKnownSlug: r.unmatchedPorts, rowsWritten: r.written,
        believedFromFile: r.alreadyOnFile, removedNoLongerListed: r.removed,
        shipsThatFailed: r.errors.length,
      }, "Itinerary refresh complete");
    } catch (err) {
      // Log the REASON, not the page. Supabase answered the first live run with
      // a Cloudflare 522 HTML page and `{ err }` serialised the whole thing —
      // thousands of characters of markup in the log for a five-word fault.
      logger.error({ reason: briefly(err), attempt: retries + 1 }, "Itinerary refresh failed");

      // A transient fault must not cost a month of itineraries. That first run
      // died on a Supabase blip; on the original 30-day timer the table would
      // have stayed empty until late October, and the storm detector would have
      // gone right back to guessing from AIS port history.
      if (retries < RETRY_DELAYS_MIN.length) {
        const wait = RETRY_DELAYS_MIN[retries]!;
        retries += 1;
        logger.info({ retryInMinutes: wait }, "Itinerary refresh will retry");
        after(wait * 60 * 1000, () => void tick());
      } else {
        logger.error({ attempts: retries + 1 },
          "Itinerary refresh gave up — waiting for the next monthly run");
        retries = 0;
      }
    }
  };
  // Boot: stock a fresh box once; never re-crawl the fleet because pm2 restarted.
  after(BOOT_CHECK_DELAY_MS, () => void (async () => {
    try {
      const newest = await newestCruiseMapperRow();
      const farthest = await farthestCruiseMapperStart();
      if (!bootRefreshNeeded(newest, new Date()) && !tableIsShallow(farthest, new Date())) {
        logger.info({ newest, farthest }, "Itinerary refresh: table is fresh and deep, no boot run");
        return;
      }
      logger.info({ newest, farthest }, "Itinerary refresh: table empty, stale or shallow — running at boot");
      await tick();
    } catch (err) {
      logger.error({ reason: briefly(err) }, "Itinerary refresh: boot freshness check failed — waiting for the monthly run");
    }
  })());

  // Monthly: the 1st at RUN_HOUR_UTC. `after` chains any wait past Node's
  // 2^31-1 ms timer cap (the 9/23 outage). The +60 s keeps a timer that fires a
  // hair early from re-arming for the same instant.
  const arm = () => {
    const next = nextMonthlyRunAt(new Date(Date.now() + 60_000));
    after(next.getTime() - Date.now(), () => { void tick(); arm(); });
    logger.info({ next: next.toISOString() }, "Itinerary refresh scheduled — 1st of the month");
  };
  arm();
}
