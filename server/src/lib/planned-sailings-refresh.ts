// planned-sailings-refresh.ts — keep planned_sailings current from the Cruise API.
//
// Daily, on the Pro plan (Mark, 2026-09-13; the rules and the measurements
// behind them are in planned-sweep-core.ts):
//   1. PRIORITY: ships in a storm cone or followed by someone get their first
//      page again (the sailing under way and the next few), every run.
//   2. SWEEP: then, with the rest of the day's budget, ships are paged through
//      a two-year window in turns, with a cursor, so the whole fleet refreshes
//      about twice a month. A ship is only started if the budget can finish
//      it, so a sweep never straddles two runs.
// After a complete sweep, sailings the operator no longer lists in that window
// are removed, so a cancelled or re-planned sailing stops drawing a route.
import { getSupabase, readJson, writeJson, PATHS } from "./persistence";
import { logger } from "./logger";
import { searchCruises, shipCodes, cruiseApiEnabled } from "./cruise-api";
import { seaRoute } from "./sea-route";
import { resetPlannedRouteCaches } from "./planned-route-service";
import type { PlannedSailing } from "./planned-sailings";
import {
  CRUISE_API_PAGE_SIZE, DEFAULT_HORIZON_DAYS, LOOKBACK_DAYS, LIVE_SOURCE,
  sweepShip, refsToRemove, pagesToHold, removableWindow, runIsDue, type SweepPage,
} from "./planned-sweep-core";

export interface RefreshShip { name: string; mmsi: string; cruiseLine: string; priority: number }
export interface RefreshState {
  ranAt: string; nextIndex: number; searched: number; sailings: number; legs: number; removed: number;
  shipsSwept: number; priorityShips: number; stoppedReason: string | null; eligible: number; skipped: string[];
  /** Pages each ship took last sweep — how much budget to hold before starting it again. */
  pagesByShip: Record<string, number>;
}

/** Searches one run may spend. ~130 a day keeps a 30-day cycle under Pro's 4,000. */
export function dailySearchBudget(): number {
  const n = Number(process.env["CRUISE_API_DAILY_SEARCHES"]);
  return Number.isFinite(n) && n >= 0 ? n : 130;
}
export function refreshHorizonDays(): number {
  const n = Number(process.env["CRUISE_API_HORIZON_DAYS"]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HORIZON_DAYS;
}
const PRIORITY_SHIPS_MAX = 10;
const PACE_MS = 1100; // the plan allows about one request per second

function norm(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function addDays(date: Date, n: number): string { return new Date(date.getTime() + n * 86_400_000).toISOString().slice(0, 10); }
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Store sailings under the registry ship they were searched for. */
async function upsertSailings(rows: PlannedSailing[], ship: RefreshShip): Promise<number> {
  if (!rows.length) return 0;
  const supabase = getSupabase();
  const now = new Date().toISOString();
  const byRef = new Map<string, Record<string, unknown>>();
  for (const s of rows) {
    byRef.set(s.ref, {
      source: s.source, ref: s.ref, ship_name: ship.name, mmsi: ship.mmsi || null, operator: s.operator,
      start_date: s.startDate, end_date: s.endDate, from_code: s.fromCode, to_code: s.toCode,
      ports: s.ports.map((p) => ({ ...p, ordered: s.ordered })), updated_at: now,
    });
  }
  const payload = [...byRef.values()];
  const { error } = await (supabase.from("planned_sailings") as ReturnType<typeof supabase.from>).upsert(payload, { onConflict: "ref" });
  if (error) { logger.warn({ err: error, ship: ship.name }, "planned-refresh: upsert failed"); return 0; }
  return payload.length;
}

async function removeStale(ship: RefreshShip, seen: Set<string>, window: { from: string; to: string }, complete: boolean): Promise<number> {
  if (!complete) return 0;
  const supabase = getSupabase();
  const { data, error } = await supabase.from("planned_sailings")
    .select("ref, start_date")
    .eq("source", LIVE_SOURCE)
    .ilike("ship_name", ship.name)
    .gte("start_date", window.from)
    .lte("start_date", window.to);
  if (error) { logger.warn({ err: error, ship: ship.name }, "planned-refresh: stale read failed"); return 0; }
  const stored = ((data ?? []) as { ref: string; start_date: string }[]).map((r) => ({ ref: r.ref, startDate: r.start_date }));
  const refs = refsToRemove(stored, seen, window, complete);
  if (!refs.length) return 0;
  const del = await (supabase.from("planned_sailings") as ReturnType<typeof supabase.from>).delete().in("ref", refs);
  if (del.error) { logger.warn({ err: del.error, ship: ship.name }, "planned-refresh: stale delete failed"); return 0; }
  logger.info({ ship: ship.name, removed: refs.length }, "planned-refresh: operator no longer lists these sailings");
  return refs.length;
}

async function storeMissingLegs(rows: PlannedSailing[]): Promise<number> {
  const supabase = getSupabase();
  const pairs = new Map<string, { a: { lat: number; lon: number }; b: { lat: number; lon: number } }>();
  for (const s of rows) {
    const rp = s.ports.filter((p) => p.slug && p.lat !== null && p.lon !== null);
    for (let i = 0; i + 1 < rp.length; i++) {
      const a = rp[i]!, b = rp[i + 1]!;
      if (a.slug !== b.slug) pairs.set(`${a.slug}>${b.slug}`, { a: { lat: a.lat!, lon: a.lon! }, b: { lat: b.lat!, lon: b.lon! } });
    }
  }
  if (!pairs.size) return 0;
  const keys = [...pairs.keys()];
  const have = new Set<string>();
  // Chunked: a two-year sweep can carry hundreds of port pairs, too many for one filter.
  for (let i = 0; i < keys.length; i += 60) {
    const or = keys.slice(i, i + 60).map((k) => { const [a, b] = k.split(">"); return `and(from_slug.eq.${a},to_slug.eq.${b})`; }).join(",");
    const { data } = await supabase.from("port_routes").select("from_slug, to_slug").or(or);
    for (const r of (data ?? []) as { from_slug: string; to_slug: string }[]) have.add(`${r.from_slug}>${r.to_slug}`);
  }
  const batch: unknown[] = [];
  for (const [key, { a, b }] of pairs) {
    if (have.has(key)) continue;
    const [from, to] = key.split(">");
    const r = await seaRoute(a, b).catch(() => null);
    if (r && r.points.length >= 2) batch.push({ from_slug: from, to_slug: to, points: r.points, nm: Math.round((r.lengthNm ?? 0) * 10) / 10, source: "searoute-js", computed_at: new Date().toISOString() });
  }
  if (batch.length) {
    const { error } = await (supabase.from("port_routes") as ReturnType<typeof supabase.from>).upsert(batch, { onConflict: "from_slug,to_slug" });
    if (error) logger.warn({ err: error }, "planned-refresh: legs upsert failed");
  }
  return batch.length;
}

/**
 * One refresh run. Ships whose line the API does not carry are skipped without
 * spending. Stops early, keeping its place, when the day's budget, the plan's
 * allowance or the API gives out.
 */
export async function refreshPlannedSailings(
  ships: RefreshShip[],
  opts: { budget?: number; horizonDays?: number; now?: Date; force?: boolean } = {},
): Promise<RefreshState> {
  const now = opts.now ?? new Date();
  const budget = opts.budget ?? dailySearchBudget();
  const horizon = opts.horizonDays ?? refreshHorizonDays();
  const window = { from: addDays(now, -LOOKBACK_DAYS), to: addDays(now, horizon) };

  let prev: Partial<RefreshState> = {};
  try { prev = await readJson<Partial<RefreshState>>(PATHS.plannedRefresh, {}); } catch { /* first run */ }
  const state: RefreshState = {
    ranAt: now.toISOString(), nextIndex: prev.nextIndex ?? 0, searched: 0, sailings: 0, legs: 0, removed: 0,
    shipsSwept: 0, priorityShips: 0, stoppedReason: null, eligible: 0, skipped: [], pagesByShip: { ...(prev.pagesByShip ?? {}) },
  };
  if (!cruiseApiEnabled() || budget <= 0 || !ships.length) { state.stoppedReason = "disabled"; return state; }
  if (!opts.force && !runIsDue(prev.ranAt, now)) {
    logger.info({ lastRanAt: prev.ranAt }, "planned-refresh: ran within the last 20 h — skipped");
    return { ...state, ranAt: prev.ranAt ?? state.ranAt, stoppedReason: "ran-recently" };
  }

  const codes = await shipCodes();
  const ordered = [...ships].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  const eligible = ordered.filter((s) => codes.has(norm(s.name)));
  state.eligible = eligible.length;
  state.skipped = ordered.filter((s) => !codes.has(norm(s.name))).map((s) => s.name);
  if (!eligible.length) { state.stoppedReason = "no-eligible-ships"; return state; }
  let left = budget;

  const fetcherFor = (ship: RefreshShip, from: string, to: string) => async (page: number): Promise<SweepPage<PlannedSailing> | null> => {
    if (left <= 0) return null;
    const sc = codes.get(norm(ship.name))!;
    left -= 1;
    state.searched += 1;
    const res = await searchCruises({
      cruiseLineCodes: [sc.line], shipCodes: [sc.code], roomTypeCategoryCodes: ["I"],
      earliestStartDate: from, latestStartDate: to, page, pageSize: CRUISE_API_PAGE_SIZE,
    });
    await pause(PACE_MS);
    return res;
  };

  const persist = async () => {
    try { await writeJson(PATHS.plannedRefresh, state); } catch (err) { logger.warn({ err }, "planned-refresh: state persist failed"); }
  };

  // 1. Priority: the sailing under way and the next few, for ships that matter today.
  const priority = eligible.filter((s) => s.priority === 0).slice(0, PRIORITY_SHIPS_MAX);
  for (const ship of priority) {
    if (left <= 0) break;
    const page = await fetcherFor(ship, window.from, window.to)(1);
    if (!page) { state.stoppedReason = "api"; break; }
    state.priorityShips += 1;
    state.sailings += await upsertSailings(page.sailings, ship);
    state.legs += await storeMissingLegs(page.sailings);
  }

  // 2. Sweep: whole ships, two years each, in turns.
  let idx = state.nextIndex < eligible.length ? state.nextIndex : 0;
  for (let visited = 0; visited < eligible.length && state.stoppedReason !== "api"; visited++) {
    const ship = eligible[idx]!;
    const hold = pagesToHold(state.pagesByShip[ship.name]);
    if (hold > left) { state.stoppedReason = state.stoppedReason ?? "daily-budget"; break; }
    // Read to the end; the fetcher itself stops when the day's budget runs out.
    const sweep = await sweepShip(fetcherFor(ship, window.from, window.to), Number.POSITIVE_INFINITY);
    if (sweep.pagesUsed > 0 && sweep.totalResults === null) { state.stoppedReason = "api"; break; }
    const seen = new Set(sweep.sailings.map((s) => s.ref));
    state.sailings += await upsertSailings(sweep.sailings, ship);
    // Only departures from tomorrow on: the API never lists a sailing already under way.
    state.removed += await removeStale(ship, seen, removableWindow(now.toISOString().slice(0, 10), window.to), sweep.complete);
    state.legs += await storeMissingLegs(sweep.sailings);
    state.pagesByShip[ship.name] = sweep.totalPages ?? sweep.pagesUsed;
    if (!sweep.complete) {
      // A page failed or the listing shifted while we read: keep the ship for next run.
      state.stoppedReason = "incomplete-sweep";
      break;
    }
    state.shipsSwept += 1;
    idx = (idx + 1) % eligible.length;
    state.nextIndex = idx;
    await persist();
  }

  state.nextIndex = idx;
  resetPlannedRouteCaches();
  await persist();
  logger.info({ ...state, skipped: state.skipped.length, pagesByShip: Object.keys(state.pagesByShip).length, window }, "planned-refresh: cruise api");
  return state;
}
