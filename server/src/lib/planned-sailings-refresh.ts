// planned-sailings-refresh.ts — keep planned_sailings current from the Cruise API, on a budget.
//
// Weekly, in priority order (watched > storm > seeded > requested > rest), one
// search per ship: its next sailings from today, one row per sailing, ten per
// page. Each new sailing is upserted by ref and its port pairs get a water
// route if none is stored. A cursor persists so the fleet is covered in turns;
// CRUISE_API_WEEKLY_SEARCHES bounds the spend (Basic plan: 50 a month).
import { getSupabase, readJson, writeJson, PATHS } from "./persistence";
import { logger } from "./logger";
import { searchCruises, shipCodes, cruiseApiEnabled, shipNameKeys } from "./cruise-api";
import { seaRoute } from "./sea-route";
import { resetPlannedRouteCaches } from "./planned-route-service";
import type { PlannedSailing } from "./planned-sailings";

export interface RefreshShip { name: string; mmsi: string; cruiseLine: string; priority: number }
interface State { ranAt: string; nextIndex: number; searched: number; sailings: number; legs: number; skipped: string[] }

export function weeklySearchBudget(): number {
  const n = Number(process.env["CRUISE_API_WEEKLY_SEARCHES"]);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}
function norm(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function addDays(date: Date, n: number): string { return new Date(date.getTime() + n * 86_400_000).toISOString().slice(0, 10); }

async function upsertSailings(rows: PlannedSailing[], byName: Map<string, RefreshShip>): Promise<number> {
  if (!rows.length) return 0;
  const supabase = getSupabase();
  const payload = rows.map((s) => {
    // The API may spell a ship with the line in front ("Virgin Brilliant Lady");
    // store it under the registry's name so the tracker finds her plan.
    const reg = shipNameKeys(s.shipName).map((k) => byName.get(k)).find(Boolean) ?? null;
    return {
      source: s.source, ref: s.ref, ship_name: reg?.name ?? s.shipName, mmsi: reg?.mmsi ?? null, operator: s.operator,
      start_date: s.startDate, end_date: s.endDate, from_code: s.fromCode, to_code: s.toCode,
      ports: s.ports.map((p) => ({ ...p, ordered: s.ordered })), updated_at: new Date().toISOString(),
    };
  });
  const { error } = await (supabase.from("planned_sailings") as ReturnType<typeof supabase.from>).upsert(payload, { onConflict: "ref" });
  if (error) { logger.warn({ err: error }, "planned-refresh: upsert failed"); return 0; }
  return payload.length;
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
  const or = [...pairs.keys()].map((k) => { const [a, b] = k.split(">"); return `and(from_slug.eq.${a},to_slug.eq.${b})`; }).join(",");
  const { data } = await supabase.from("port_routes").select("from_slug, to_slug").or(or);
  const have = new Set(((data ?? []) as { from_slug: string; to_slug: string }[]).map((r) => `${r.from_slug}>${r.to_slug}`));
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
 * One refresh run: spend up to `budget` searches on the next ships in priority
 * order. Ships whose line the API does not carry, or whose code is unknown,
 * are skipped without spending.
 */
export async function refreshPlannedSailings(ships: RefreshShip[], opts: { budget?: number; horizonDays?: number; now?: Date } = {}): Promise<State> {
  const now = opts.now ?? new Date();
  const budget = opts.budget ?? weeklySearchBudget();
  const horizon = opts.horizonDays ?? 120;
  // Reach back so the sailing already under way is in the window: a 14-night
  // cruise that left 10 days ago is still "current" (Adventure of the Seas on
  // 2026-09-11 had no plan because her sailing left the day before).
  const LOOKBACK_DAYS = 15;
  const state: State = { ranAt: now.toISOString(), nextIndex: 0, searched: 0, sailings: 0, legs: 0, skipped: [] };
  if (!cruiseApiEnabled() || budget <= 0 || !ships.length) return state;
  const codes = await shipCodes();
  const ordered = [...ships].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  const eligible = ordered.filter((s) => codes.has(norm(s.name)));
  state.skipped = ordered.filter((s) => !codes.has(norm(s.name))).map((s) => s.name);
  let prev: Partial<State> = {};
  try { prev = await readJson<Partial<State>>(PATHS.plannedRefresh, {}); } catch { /* first run */ }
  let idx = Number.isFinite(prev.nextIndex) && (prev.nextIndex ?? 0) < eligible.length ? (prev.nextIndex ?? 0) : 0;
  const byName = new Map(ships.map((s) => [norm(s.name), s]));
  const collected: PlannedSailing[] = [];
  for (let n = 0; n < budget && eligible.length; n++) {
    const ship = eligible[idx % eligible.length]!;
    const sc = codes.get(norm(ship.name))!;
    const res = await searchCruises({
      cruiseLineCodes: [sc.line], shipCodes: [sc.code], roomTypeCategoryCodes: ["I"],
      earliestStartDate: addDays(now, -LOOKBACK_DAYS), latestStartDate: addDays(now, horizon), pageSize: 10,
    });
    idx = (idx + 1) % eligible.length;
    if (res === null) break;                      // cap or error: stop, resume here next time
    state.searched += 1;
    collected.push(...res.sailings);
    await new Promise((r) => setTimeout(r, 1100));  // 1 request per second on the plan
  }
  state.nextIndex = idx;
  state.sailings = await upsertSailings(collected, byName);
  state.legs = await storeMissingLegs(collected);
  resetPlannedRouteCaches();
  try { await writeJson(PATHS.plannedRefresh, state); } catch (err) { logger.warn({ err }, "planned-refresh: state persist failed"); }
  logger.info({ ...state, skipped: state.skipped.length, eligible: eligible.length }, "planned-refresh: cruise api");
  return state;
}
