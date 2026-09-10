// satellite-ais-core.ts — the pure half of the satellite adapter (gate + parsing), no I/O.
// Tests import this; satellite-ais.ts adds the ledger persistence and the HTTP call.
//
// The free terrestrial feed loses a ship a few dozen miles offshore. Satellite
// AIS fills that, but it is billed per position, so it is never polled for the
// fleet. Mark, 2026-09-10: "we only need to ping the information if there is a
// request for an individual ship... a follow, storm impacts, itinerary changes."
//
// A lookup happens only when ALL of these hold:
//   - the adapter is configured (DATADOCKED_API_KEY) and not switched off;
//   - the ship is stale on the free feed (no fix for LOOKUP_AFTER_MIN);
//   - there is a live reason: someone viewing her, a subscriber watch, a storm
//     cone, a diversion check;
//   - this ship has not been looked up in the last PER_SHIP_MIN;
//   - the month's credit cap has not been reached (hard stop — the vidIQ
//     auto-refill lesson: no adapter may spend without a ceiling it enforces).
//
// Provider: Datadocked, GET /api/vessels_operations/get-vessel-location
// (x-api-key header, 1 credit per request, 100 req/min). The pure decision and
// parsing functions are unit-tested; the I/O is thin.


export type LookupReason = "view" | "watch" | "storm" | "diversion";

export const LOOKUP_AFTER_MIN = 20;
/** Someone on the page right now: at most one lookup per 30 min for that ship. */
export const VIEW_WINDOW_MIN = 30;
/** Standing needs (a watch, a storm cone, a diversion check): Mark, 2026-09-10 —
 *  "the position doesn't need to be updated more than every 3 hours". */
export const STANDING_WINDOW_MIN = 180;
export function perShipWindowMin(reason: LookupReason): number {
  return reason === "view" ? VIEW_WINDOW_MIN : STANDING_WINDOW_MIN;
}
export const DEFAULT_MONTHLY_CAP = 5000; // Deckhand tier is 6,000; leave headroom

export interface Ledger {
  month: string;                       // "2026-09"
  used: number;
  lastByMmsi: Record<string, string>;  // ISO time of the last lookup per ship
  lastError?: { at: string; status: number | string } | null;
}

export interface SatelliteFix {
  lat: number;
  lon: number;
  courseDeg: number | null;
  speedKn: number | null;
  headingDeg: number | null;
  at: string;               // ISO
  source: "satellite" | "terrestrial" | "unknown";
  /** Crew-typed destination text and ETA as the provider saw them (may decode a port we could not). */
  destination: string | null;
  etaUtc: string | null;
}

export function monthKey(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function monthlyCap(): number {
  const n = Number(process.env["DATADOCKED_MONTHLY_CAP"]);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MONTHLY_CAP;
}

export function satelliteEnabled(): boolean {
  return Boolean(process.env["DATADOCKED_API_KEY"]) && process.env["SATELLITE_AIS"] !== "off";
}

export function blankLedger(now = new Date()): Ledger {
  return { month: monthKey(now), used: 0, lastByMmsi: {}, lastError: null };
}

/** Pure gate: may we spend one credit on this ship right now? */
export function lookupDecision(
  args: { lastFixAt: string | null; ledger: Ledger; mmsi: string; cap: number; now: Date; reason: LookupReason },
): { ok: true } | { ok: false; why: "fresh" | "recent-lookup" | "cap" } {
  const { lastFixAt, ledger, mmsi, cap, now, reason } = args;
  const fixAge = lastFixAt ? (now.getTime() - Date.parse(lastFixAt)) / 60_000 : Infinity;
  if (fixAge < LOOKUP_AFTER_MIN) return { ok: false, why: "fresh" };
  const last = ledger.lastByMmsi[mmsi];
  if (last && (now.getTime() - Date.parse(last)) / 60_000 < perShipWindowMin(reason)) return { ok: false, why: "recent-lookup" };
  const used = ledger.month === monthKey(now) ? ledger.used : 0;
  if (used >= cap) return { ok: false, why: "cap" };
  return { ok: true };
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** Datadocked's "Jan 04, 2026 04:15 UTC" → ISO. null when unparseable. */
export function parsePositionReceived(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))? UTC$/.exec(s.trim());
  if (m) {
    const mo = MONTHS[m[1]!];
    if (mo === undefined) return null;
    return new Date(Date.UTC(+m[3]!, mo, +m[2]!, +m[4]!, +m[5]!, +(m[6] ?? 0))).toISOString();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Map a Datadocked response to a fix. The docs show `{ detail: {...} }`; the
 * live API (2026-09-10) returns the flat object — both are accepted. null when
 * it carries no usable position.
 */
export function parseDetail(body: unknown): SatelliteFix | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const inner = b["detail"];
  const d = (inner && typeof inner === "object" ? inner : b) as Record<string, unknown>;
  const lat = Number(d["latitude"]);
  const lon = Number(d["longitude"]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  const at = parsePositionReceived(d["positionReceived"]) ?? parsePositionReceived(d["updateTime"]);
  if (!at) return null;
  const num = (v: unknown, max: number): number | null => {
    const n = Number(v); return Number.isFinite(n) && n >= 0 && n < max ? n : null;
  };
  const src = String(d["dataSource"] ?? "").toLowerCase();
  return {
    lat, lon,
    courseDeg: num(d["course"], 360),
    speedKn: num(d["speed"], 102.3),
    headingDeg: num(d["heading"], 360),
    at,
    source: src.includes("sat") ? "satellite" : src.includes("terr") ? "terrestrial" : "unknown",
    destination: typeof d["destination"] === "string" && d["destination"].trim() && d["destination"] !== "None" ? d["destination"].trim() : null,
    etaUtc: parsePositionReceived(d["etaUtc"]),
  };
}

