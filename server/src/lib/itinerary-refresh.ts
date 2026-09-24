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
import { briefly } from "./brief-error";
import { CRUISEMAPPER_BASE as BASE } from "./cruisemapper";
import {
  fetchCruiseMapper, isNonPort, pageIdentity, parsePortTable, parseSchedule, resolvePort,
} from "./cruisemapper";

/** ~50 requests a minute. We are a guest on a free site; do not hammer it. */
const PAUSE_MS = 1200;
/** Far enough back to catch a sailing already under way. */
const BACK_DAYS = 21;
/** A monthly refresh only needs the near horizon; 90 days covers hurricane season. */
const FWD_DAYS = 90;
const MAX_SAILINGS_PER_SHIP = 12;
export const SOURCE = "cruisemapper";
/** Backoff after a failed run, in minutes. Covers a provider blip without hammering. */
const RETRY_DELAYS_MIN = [5, 20, 60, 180] as const;

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
  errors: { ship: string; error: string }[];
}

interface RegistryShip {
  name: string;
  cruise_line: string | null;
  mmsi: string | null;
  imo: string | null;
  cruisemapper_id: string;
}

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
  const hi = isoDay(FWD_DAYS);
  const wanted = parseSchedule(page.body)
    .filter((s) => s.start >= lo && s.start <= hi)
    .slice(0, MAX_SAILINGS_PER_SHIP);

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
}

export async function refreshItineraries(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const out: RefreshResult = {
    ships: 0, sailings: 0, portCalls: 0, unmatchedPorts: 0, written: 0, errors: [],
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

  const ships = ((data ?? []) as RegistryShip[]).slice(0, opts.limit ?? Infinity);
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

/**
 * Monthly, and once a few minutes after boot so a fresh box is not left with a
 * stale table. Itineraries are published months ahead and barely move, so a
 * faster cadence would just be traffic on someone else's free website.
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
        setTimeout(() => void tick(), wait * 60 * 1000);
      } else {
        logger.error({ attempts: retries + 1 },
          "Itinerary refresh gave up — waiting for the next monthly run");
        retries = 0;
      }
    }
  };
  setTimeout(() => void tick(), 5 * 60 * 1000);
  setInterval(() => void tick(), 30 * 24 * 60 * 60 * 1000);
  logger.info("Itinerary refresh scheduled — 5 min after boot, then every 30 days");
}
