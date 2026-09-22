// live-ais-core.ts — Live-AIS (live-ais.com) adapter, pure parts. No I/O.
//
// THIRD on-demand provider beside Datadocked and ShipFinder. Mark bought
// pay-as-you-go credits 2026-09-21 ("i just bought credits on live-ais for the
// test"); $0.02/credit, credits never expire, so the cap below is a spend
// ceiling, not a subscription allowance.
//
// WHY IT EARNS ITS PLACE: the free terrestrial feed cannot hear a ship at the
// Bahamas and western-Caribbean islands. Over 16 days of continuous tracking
// the fleet logged 0 calls at Nassau, Cozumel, Great Stirrup Cay, CocoCay,
// Grand Turk, Costa Maya and Roatán while catching every Miami / Port
// Canaveral turnaround — which is what made the storm detector report
// scheduled island stops as diversions. Live-AIS DOES see those calls: a
// track/3 on Norwegian Getaway (2026-09-21) put her 0.7 km off Great Stirrup
// Cay at 0.0 kn for seven and a half hours.
//
// WHERE POSITION LIVES. Probed against the live API 2026-09-21, not read off
// the docs: GET /vessel/{mmsi} carries NO lat/lon — underway or moored, with
// ?include=position and ?fields= ignored — and neither does the batch POST.
// Position comes from the two endpoints that do carry it:
//   • /vessels/bbox  — every vessel in a box, CLEAN NUMERIC lat/lon/sog/cog,
//     5 credits per 50 returned, 0 credits when nothing matches.
//   • /vessel/{mmsi}/track/{days} — the same, as history, 1 credit per day.
// Bbox is the cheap one for our shape of problem: a storm pins many ships in
// one region, and one 5-credit box refreshed 18 vessels on 2026-09-21
// (0.28 credits a ship) — including GRANDE CARIBE stopped 0.09 km off Great
// Stirrup Cay and STAR OF THE SEAS at CocoCay, both ports the free feed has
// never once logged a call at. Per-ship track is the fallback for a ship
// outside any box we are already buying.
//
// Docs (dashboard.live-ais.com, read 2026-09-21). Auth: Authorization: Bearer.
// Base https://api.live-ais.com. "Credits are debited only for valid MMSIs;
// incomplete responses are refunded EOD."
//   GET /api/v1/vessel/{mmsi}              1 credit   — static + dynamic, NO lat/lon
//   GET /api/v1/vessel/{mmsi}/track/{days} 1/day, ≤15 — lat/lon points
//   GET /api/v1/vessel/{mmsi}/ports        5 credits  — (1 when no schedule)
//   GET /api/v1/usage/monthly              free
//   GET /api/v1/rate-limit                 free
//   GET /api/v1/health                     free, no auth
// An MMSI slot also accepts a 7-digit IMO, which survives reflagging — see
// the MSC Seaside / Navigator reflag note in lib/ship-tracker.ts.
import type { PositionFix } from "./position-provider";

export const LIVE_AIS_BASE = "https://api.live-ais.com/api/v1";

/** Pay-as-you-go: the cap is dollars, not an allowance. 2,500 credits ≈ $50. */
export const DEFAULT_LIVE_AIS_CAP = 2000;
/** A track may not be asked for more days than this (provider max is 15). */
export const MAX_TRACK_DAYS = 15;
/** Enough to cover a 3-4 night loop and its turnaround without overbuying. */
export const DEFAULT_TRACK_DAYS = 3;

export function liveAisKey(): string {
  return (process.env["LIVEAIS_API_KEY"] ?? "").replace(/^["']+|["']+$/g, "").trim();
}
export function liveAisEnabled(): boolean {
  return Boolean(liveAisKey()) && process.env["LIVE_AIS"] !== "off";
}
export function liveAisCap(): number {
  const n = Number(process.env["LIVEAIS_MONTHLY_CAP"]);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LIVE_AIS_CAP;
}
export function trackDays(): number {
  const n = Number(process.env["LIVEAIS_TRACK_DAYS"]);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_TRACK_DAYS;
  return Math.min(Math.floor(n), MAX_TRACK_DAYS);
}

// ── Credit balance + the low-credit alarm ─────────────────────────────────────
//
// Mark, 2026-09-21: "we need a listener to alert me when credits drop below 50."
// There is NO balance endpoint — /account, /credits, /balance and eight other
// spellings all 404 (probed 2026-09-21), and /usage/monthly reports only the
// CURRENT month's consumption, which resets. So the balance is computed:
//
//     remaining = purchased − (consumed in months already closed + this month)
//
// `purchased` is what he actually bought (dashboard "API CREDITS REMAINING",
// 2,500 on 2026-09-21) and is re-stamped whenever he tops up. Closed months
// are banked into our own state as each new month starts, because the
// provider will not tell us about them again. Credits never expire, so this
// is a running-down balance, not a monthly allowance.

export const DEFAULT_LOW_CREDIT_THRESHOLD = 50;

export function creditsPurchased(): number | null {
  const n = Number(process.env["LIVEAIS_CREDITS_PURCHASED"]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
export function lowCreditThreshold(): number {
  const n = Number(process.env["LIVEAIS_LOW_CREDIT_THRESHOLD"]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOW_CREDIT_THRESHOLD;
}

export interface CreditState {
  /** Credits consumed in months that have CLOSED. */
  bankedUsed: number;
  /** The month `lastMonthUsed` refers to, e.g. "2026-09". */
  lastMonth: string | null;
  /** The newest figure the provider reported for `lastMonth`. */
  lastMonthUsed: number;
  /** The balance we last warned at, so one crossing sends one alert. */
  warnedAt: number | null;
}

export interface CreditStatus {
  purchased: number | null;
  used: number;
  remaining: number | null;
  threshold: number;
  low: boolean;
}

export function blankCreditState(): CreditState {
  return { bankedUsed: 0, lastMonth: null, lastMonthUsed: 0, warnedAt: null };
}

export function monthKeyOf(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/**
 * Fold a /usage/monthly reading into the running total. That endpoint is free
 * and authoritative — our own ledger drifts, because the provider refunds
 * incomplete responses at end of day rather than inline — but it reports only
 * the CURRENT month, so a closed month's figure is banked the moment the month
 * rolls over. Miss that and every new month silently forgives the last one.
 */
export function foldMonthlyUsage(state: CreditState, month: string, monthUsed: number): CreditState {
  const used = Math.max(0, monthUsed);
  if (state.lastMonth === null) return { ...state, lastMonth: month, lastMonthUsed: used };
  if (state.lastMonth === month) return { ...state, lastMonthUsed: used };
  if (month < state.lastMonth) return state;                     // a stale/out-of-order report
  return { ...state, bankedUsed: state.bankedUsed + state.lastMonthUsed, lastMonth: month, lastMonthUsed: used };
}

export function creditStatus(state: CreditState): CreditStatus {
  const purchased = creditsPurchased();
  const used = state.bankedUsed + state.lastMonthUsed;
  const threshold = lowCreditThreshold();
  const remaining = purchased === null ? null : purchased - used;
  return { purchased, used, remaining, threshold, low: remaining !== null && remaining < threshold };
}

/**
 * Should this reading raise an alarm? One alert per crossing: re-alert only if
 * the balance has fallen another threshold's worth since the last warning, or
 * if a top-up lifted it back above the line (which clears the latch).
 */
export function creditAlarm(
  status: CreditStatus, warnedAt: number | null,
): { alert: boolean; clear: boolean; warnAt: number | null } {
  if (status.remaining === null) return { alert: false, clear: false, warnAt: warnedAt };
  if (!status.low) return { alert: false, clear: warnedAt !== null, warnAt: null };
  if (warnedAt === null) return { alert: true, clear: false, warnAt: status.remaining };
  // Already warned. Only speak again after another threshold's worth is gone.
  if (warnedAt - status.remaining >= status.threshold) return { alert: true, clear: false, warnAt: status.remaining };
  return { alert: false, clear: false, warnAt: warnedAt };
}

/** What one call will cost, so the cap can be checked BEFORE spending it. */
export type LiveAisCall = "vessel" | "track" | "ports" | "bbox";
export function creditCost(call: LiveAisCall, units = 1): number {
  if (call === "track") return Math.min(Math.max(Math.floor(units), 1), MAX_TRACK_DAYS);
  if (call === "ports") return 5;   // 1 when the vessel has no schedule; assume the worst
  // bbox bills ceil(returned / 50) * 5 and charges NOTHING when nothing matches
  // (measured: 18 returned = 5 credits, 0 returned = 0). `units` is the limit
  // asked for, so this is the worst case until the response says otherwise.
  if (call === "bbox") return Math.ceil(Math.max(Math.floor(units), 1) / BBOX_PER_CHARGE) * BBOX_CHARGE;
  return 1;
}
export const BBOX_PER_CHARGE = 50;
export const BBOX_CHARGE = 5;
/** The provider caps a page at 500 however large a limit is asked for. */
export const BBOX_MAX_LIMIT = 500;

export function liveAisUrl(path: string): string {
  return `${LIVE_AIS_BASE}/${path.replace(/^\/+/, "")}`;
}

// ── Field coercion ────────────────────────────────────────────────────────────
// The docs show clean values (cog: 74, sog: 18, eta ISO). The LIVE API returns
// display strings — cog "115°", draught "8.5 m", width "54 m", sog "" while
// moored (2026-09-21). Everything numeric goes through here.

export function num(v: unknown, max: number): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 && v < max ? v : null;
  if (typeof v !== "string") return null;
  const m = /-?\d+(?:\.\d+)?/.exec(v);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n >= 0 && n < max ? n : null;
}

/**
 * `source` is undocumented and answered "saagar" on 2026-09-21 — a provider
 * internal, not a lineage. Only an explicit sat/terr wins; anything else is
 * "unknown" so the WMS pill never claims a satellite heard her when we cannot
 * tell.
 */
export function mapSource(v: unknown): PositionFix["source"] {
  const s = String(v ?? "").toLowerCase();
  if (s.includes("sat")) return "satellite";
  if (s.includes("terr")) return "terrestrial";
  return "unknown";
}

/** "2026-09-18 15:34:14" (UTC, no zone marker) → ISO. */
export function parseStamp(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) {
    const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0)));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  // The loose fallback must see a 4-digit year. Without that guard
  // Date.parse("Sep 22, 10:15") succeeds and reads the 10 as the YEAR — it
  // returned 2001-09-22 in local time, silently 25 years off, and swallowed
  // the year-less ETA branch below.
  if (!/\d{4}/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * ETA arrives as "Sep 22, 10:15" — no year and no zone. Resolve against `now`,
 * choosing the nearest year so a late-December ETA read on 1 January does not
 * land eleven months in the past. null when absent.
 */
export function parseEta(v: unknown, now = new Date()): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const iso = parseStamp(v);
  if (iso) return iso;
  const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const m = /^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{1,2}):(\d{2})/.exec(v.trim());
  if (!m) return null;
  const mo = MONTHS[m[1]!.toLowerCase()];
  if (mo === undefined) return null;
  const y = now.getUTCFullYear();
  const cands = [y - 1, y, y + 1].map((yy) => Date.UTC(yy, mo, +m[2]!, +m[3]!, +m[4]!));
  const best = cands.reduce((a, b) => (Math.abs(b - now.getTime()) < Math.abs(a - now.getTime()) ? b : a));
  return new Date(best).toISOString();
}

/**
 * last_port is prose: "Miami, United States (USA) ATA: Sep 21". Keep the port
 * name for our own LOCODE/name matching and the arrival date as written — it
 * carries no year, so it is NOT turned into a timestamp here.
 */
export interface LastPort { name: string; ataText: string | null }
export function parseLastPort(v: unknown): LastPort | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  const ata = /ATA:\s*(.+)$/i.exec(s);
  const name = s.replace(/\s*ATA:.*$/i, "").replace(/\s*\([^)]*\)\s*$/, "").split(",")[0]!.trim();
  return name ? { name, ataText: ata ? ata[1]!.trim() : null } : null;
}

// ── Vessel record (1 credit, NO position) ─────────────────────────────────────

export interface VesselRecord {
  mmsi: string;
  name: string | null;
  imo: string | null;
  at: string | null;
  destination: string | null;
  etaUtc: string | null;
  navStatus: string | null;
  lastPort: LastPort | null;
  /** True when `at` is the ship's own report time, false when it is the query time. */
  reportedAtKnown: boolean;
  speedKn: number | null;
  courseDeg: number | null;
  /** Moored / at anchor per the provider's own nav status. */
  stopped: boolean;
}

const STOPPED = /moor|anchor|berth|not under command|aground/i;

export function parseVessel(body: unknown): VesselRecord | null {
  if (!body || typeof body !== "object") return null;
  const r = body as Record<string, unknown>;
  const mmsi = String(r["mmsi"] ?? "").trim();
  if (!/^\d{9}$/.test(mmsi)) return null;
  const nav = typeof r["nav_status"] === "string" ? r["nav_status"].trim() : (typeof r["status"] === "string" ? r["status"].trim() : null);
  const imoN = String(r["imo"] ?? "").trim();
  return {
    mmsi,
    name: typeof r["vessel_name"] === "string" && r["vessel_name"].trim() ? r["vessel_name"].trim() : null,
    imo: /^\d{7}$/.test(imoN) ? imoN : null,
    // `timestamp` is the moment the API answered, NOT the moment she reported —
    // MSC Meraviglia came back with timestamp 15:40:45 and last_reported_at
    // 15:37:00 on 2026-09-22. Reading `timestamp` as the fix time makes every
    // lookup look seconds fresh and silently defeats the staleness gate that
    // decides whether to spend at all. Some responses omit last_reported_at
    // (Norwegian Getaway's did), so fall back — but never prefer timestamp.
    at: parseStamp(r["last_reported_at"]) ?? parseStamp(r["timestamp"]),
    /** True when the provider told us when she actually reported. */
    reportedAtKnown: Boolean(parseStamp(r["last_reported_at"])),
    destination: typeof r["destination"] === "string" && r["destination"].trim() ? r["destination"].trim() : null,
    etaUtc: parseEta(r["eta"]),
    navStatus: nav,
    lastPort: parseLastPort(r["last_port"]),
    speedKn: num(r["sog"], 102.3),
    courseDeg: num(r["cog"], 360),
    stopped: Boolean(nav && STOPPED.test(nav)),
  };
}

// ── Track (1 credit per day) ──────────────────────────────────────────────────

export interface TrackPoint {
  lat: number;
  lon: number;
  at: string;
  speedKn: number | null;
  courseDeg: number | null;
  headingDeg: number | null;
  destination: string | null;
}

/**
 * Track points, oldest first, with CONSECUTIVE REPEATS OF THE SAME FIX DROPPED.
 * The provider pads gaps with the last known position: Norwegian Getaway's
 * 2026-09-19 track carried four points at 10:08, 11:16, 12:40 and 14:39 with
 * identical lat/lon AND sog 9.6 — she was alongside Nassau, not steaming at
 * 9.6 kn for four and a half hours. Left in, those repeats read as "under way"
 * and hide the port call; worse, a stale fix would date-stamp as fresh.
 */
export function parseTrack(body: unknown): TrackPoint[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  const rows = b["points"];
  if (!Array.isArray(rows)) return [];
  const out: TrackPoint[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const lat = Number(r["lat"]);
    const lon = Number(r["lon"] ?? r["lng"]);
    const at = parseStamp(r["timestamp"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if ((lat === 0 && lon === 0) || !at) continue;
    const dest = typeof r["destination"] === "string" && r["destination"].trim() ? r["destination"].trim() : null;
    out.push({
      lat, lon, at,
      speedKn: num(r["sog"], 102.3),
      courseDeg: num(r["cog"], 360),
      headingDeg: num(r["heading"], 360),
      destination: dest,
    });
  }
  out.sort((a, b2) => Date.parse(a.at) - Date.parse(b2.at));
  return dedupeRepeats(out);
}

/**
 * Drop a repeated fix ONLY when it claims the ship is under way.
 *
 * A frozen position at 9.6 kn is a contradiction — she cannot be making way
 * and not moving — so it is the provider repeating its last fix. A frozen
 * position at 0.0 kn is not: she is moored, and every one of those samples is
 * real evidence of how long she stayed. Collapsing those too would erase the
 * duration of the port call and make a seven-hour island day look instant,
 * which is the opposite of what this adapter is for.
 */
export function dedupeRepeats(points: TrackPoint[]): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    const frozen = prev && prev.lat === p.lat && prev.lon === p.lon && prev.speedKn === p.speedKn;
    const claimsUnderway = p.speedKn !== null && p.speedKn > CALL_MAX_KN;
    if (frozen && claimsUnderway) continue;
    out.push(p);
  }
  return out;
}

/** The newest track point as a fix, so a track can stand in for a position lookup. */
export function fixFromTrack(points: TrackPoint[], sourceField: unknown = null): PositionFix | null {
  const last = points[points.length - 1];
  if (!last) return null;
  return {
    lat: last.lat,
    lon: last.lon,
    courseDeg: last.courseDeg,
    speedKn: last.speedKn,
    headingDeg: last.headingDeg,
    at: last.at,
    source: mapSource(sourceField),
    destination: last.destination,
    etaUtc: null,
  };
}

// ── Bounding box (5 credits per 50 returned) ──────────────────────────────────

export interface BboxVessel {
  mmsi: string;
  name: string | null;
  aisType: string | null;
  fix: PositionFix;
}

/** AIS ship-type 6x is passenger. The provider's own `vessel_type=Passenger`
 *  filter returned 0 matches on a box holding six cruise ships (2026-09-21),
 *  so we filter on the type code ourselves rather than trust the parameter. */
export function isPassengerType(t: unknown): boolean {
  return /^6\d?$/.test(String(t ?? "").trim());
}

/**
 * A box answer also contains "SAT PING" pseudo-rows — unresolved satellite
 * detections carrying `mmsi: "satping_76077bb6"` and sitting on top of a real
 * ship (one was 30 m from STAR OF THE SEAS). They are not vessels and must
 * never reach registry matching, so anything without a 9-digit MMSI is dropped.
 */
export function parseBbox(body: unknown): BboxVessel[] {
  if (!body || typeof body !== "object") return [];
  const rows = (body as Record<string, unknown>)["results"];
  if (!Array.isArray(rows)) return [];
  const out: BboxVessel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const mmsi = String(r["mmsi"] ?? "").trim();
    if (!/^\d{9}$/.test(mmsi)) continue;           // drops satping_* and blanks
    const lat = Number(r["lat"]), lon = Number(r["lon"] ?? r["lng"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if ((lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const dest = typeof r["destination"] === "string" && r["destination"].trim() ? r["destination"].trim() : null;
    out.push({
      mmsi,
      name: typeof r["name"] === "string" && r["name"].trim() ? r["name"].trim() : null,
      aisType: typeof r["type"] === "string" || typeof r["type"] === "number" ? String(r["type"]) : null,
      fix: {
        lat, lon,
        courseDeg: num(r["cog"], 360),
        speedKn: num(r["sog"], 102.3),
        headingDeg: num(r["heading"], 360),
        // A box carries no per-vessel timestamp: it is the live picture, so the
        // caller stamps it with the moment of the request rather than inventing one.
        at: "",
        source: "unknown",
        destination: dest,
        etaUtc: null,
      },
    });
  }
  return out;
}

/** Credits the provider says it actually charged, which is 0 for an empty box. */
export function bboxCreditsCharged(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const s = (body as Record<string, unknown>)["summary"];
  if (!s || typeof s !== "object") return null;
  const n = Number((s as Record<string, unknown>)["credits_used"]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export interface Box { minLat: number; maxLat: number; minLon: number; maxLon: number }

/** The smallest box covering these points, padded so a ship that has moved
 *  since her last known fix is still inside it. */
export function boxAround(points: { lat: number; lon: number }[], padDeg = 0.5): Box | null {
  if (!points.length) return null;
  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
  return {
    minLat: Math.max(-90, Math.min(...lats) - padDeg),
    maxLat: Math.min(90, Math.max(...lats) + padDeg),
    minLon: Math.max(-180, Math.min(...lons) - padDeg),
    maxLon: Math.min(180, Math.max(...lons) + padDeg),
  };
}

/** Degrees-squared, only to compare boxes — a box past this is not worth buying. */
export function boxArea(b: Box): number {
  return Math.abs(b.maxLat - b.minLat) * Math.abs(b.maxLon - b.minLon);
}

// ── Port calls derived from a track ───────────────────────────────────────────

/**
 * How close a track point must be to a port to count as being AT it.
 *
 * Deliberately wider than the live feed's PORT_RADIUS_KM (4 km, ship-tracker.ts).
 * Two reasons, both measured on 2026-09-21: the provider reports every 1-2
 * hours rather than continuously, so the closest sample may be taken before
 * the ship is alongside; and several of our port centroids sit on the town,
 * not the cruise berth — Getaway's nearest Nassau sample was 6.4 km from ours.
 */
export const CALL_RADIUS_KM = 8;
/** At or under this speed the ship is stopped, not passing. */
export const CALL_MAX_KN = 1.0;
/** A gap longer than this can hide a whole call, so absence proves nothing. */
export const BLIND_GAP_HOURS = 6;

export interface DerivedCall { slug: string; arrivedAt: string; departedAt: string | null; closestKm: number }
export interface PortPoint { slug: string; lat: number; lon: number }

export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Port calls a track actually evidences: consecutive stopped points inside
 * CALL_RADIUS_KM of the same port. Returns only what was SEEN — a port missing
 * from the result is not proof she skipped it (see trackGaps).
 */
export function callsFromTrack(points: TrackPoint[], ports: PortPoint[], radiusKm = CALL_RADIUS_KM): DerivedCall[] {
  const calls: DerivedCall[] = [];
  let open: DerivedCall | null = null;
  for (const p of points) {
    let near: { slug: string; km: number } | null = null;
    for (const port of ports) {
      const km = distanceKm(p.lat, p.lon, port.lat, port.lon);
      if (km <= radiusKm && (!near || km < near.km)) near = { slug: port.slug, km };
    }
    const stopped = p.speedKn !== null && p.speedKn <= CALL_MAX_KN;
    if (near && stopped) {
      if (open && open.slug === near.slug) {
        open.departedAt = p.at;
        open.closestKm = Math.min(open.closestKm, near.km);
      } else {
        if (open) calls.push(open);
        open = { slug: near.slug, arrivedAt: p.at, departedAt: null, closestKm: near.km };
      }
    } else if (open) {
      open.departedAt = open.departedAt ?? p.at;
      calls.push(open);
      open = null;
    }
  }
  if (open) calls.push(open);
  return calls;
}

/** Windows the provider did not cover. A call inside one of these is unprovable. */
export function trackGaps(points: TrackPoint[], maxHours = BLIND_GAP_HOURS): { from: string; to: string; hours: number }[] {
  const gaps: { from: string; to: string; hours: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!, b = points[i + 1]!;
    const h = (Date.parse(b.at) - Date.parse(a.at)) / 3_600_000;
    if (h > maxHours) gaps.push({ from: a.at, to: b.at, hours: Math.round(h * 10) / 10 });
  }
  return gaps;
}

/**
 * Did she call at `slug` during the window? "unknown" — never "no" — when the
 * track has a blind gap inside it. The storm detector must not turn silence
 * into a headline; that is the bug this whole provider exists to stop.
 */
export function calledAt(
  points: TrackPoint[], ports: PortPoint[], slug: string, fromIso: string, toIso: string,
): "yes" | "no" | "unknown" {
  const from = Date.parse(fromIso), to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "unknown";
  const within = points.filter((p) => { const t = Date.parse(p.at); return t >= from && t <= to; });
  if (!within.length) return "unknown";
  if (callsFromTrack(within, ports).some((c) => c.slug === slug)) return "yes";
  if (trackGaps(within).length) return "unknown";
  // The window is covered and she was never stopped there.
  const first = within[0]!, last = within[within.length - 1]!;
  if (Date.parse(first.at) - from > BLIND_GAP_HOURS * 3_600_000) return "unknown";
  if (to - Date.parse(last.at) > BLIND_GAP_HOURS * 3_600_000) return "unknown";
  return "no";
}

// ── Port schedule (5 credits) ─────────────────────────────────────────────────

export interface ScheduledPort { port: string; locode: string | null; start: string | null; end: string | null }

export function parsePorts(body: unknown): ScheduledPort[] {
  if (!body || typeof body !== "object") return [];
  const rows = (body as Record<string, unknown>)["ports"];
  if (!Array.isArray(rows)) return [];
  const out: ScheduledPort[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const port = typeof r["port"] === "string" ? r["port"].trim() : "";
    if (!port) continue;
    const lo = typeof r["locode"] === "string" ? r["locode"].replace(/\s+/g, "").toUpperCase() : "";
    out.push({
      port,
      locode: /^[A-Z]{5}$/.test(lo) ? lo : null,
      start: parseStamp(r["start_date"]),
      end: parseStamp(r["end_date"]),
    });
  }
  return out;
}
