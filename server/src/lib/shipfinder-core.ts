// shipfinder-core.ts — ShipFinder (Elane) vessel-position API, pure parts.
//
// Second on-demand position provider beside Datadocked (Mark, 2026-09-11:
// "have you considered ship finder API?"). Console keys (open.shipfinder.com)
// work against the NEW API at api.elaneglobal.com — the legacy
// api.shipfinder.com/apicall endpoints answer "Key Not Found" for them
// (found the hard way, 2026-09-11). Starter key = 14-day trial, 50 Vessel
// Position calls; Custom keys are quoted.
//
// Docs (docs.shipfinder.com, 1.1.1 Single Vessel Position, read 2026-09-11):
//   GET https://api.elaneglobal.com/v1/AIS/VesselPositionSingle?key=<key>&mmsi=<mmsi>
//   { status: 0, msg: "", data: { mmsi, imo, ship_name, data_source, dest, destcode,
//     eta, navistat, lat, lng, sog, cog, hdg, rot, last_time } }
//   lat/lng decimal degrees (WGS84); sog knots; cog/hdg degrees (hdg 511 = invalid);
//   last_time unix seconds; eta unix seconds in the example, "YYYY-MM-DD HH:MM:SS"
//   UTC per the field table; data_source 0 = terrestrial/shipborne, 1 = satellite.
//   status 0 = success; anything else carries msg ("Key Not Found" = 9).
import type { SatelliteFix } from "./satellite-ais-core";

/**
 * Console-issued (Starter) keys are served from the console's own host; the same
 * paths on api.elaneglobal.com answer "Key Not Found" for them (2026-09-11).
 * SHIPFINDER_API_BASE overrides for a Custom key bound elsewhere.
 */
export const SHIPFINDER_DEFAULT_BASE = "https://open.shipfinder.com/v1/AIS";
export function shipfinderUrl(): string {
  const base = (process.env["SHIPFINDER_API_BASE"] ?? SHIPFINDER_DEFAULT_BASE).replace(/^["']+|["']+$/g, "").replace(/\/+$/, "");
  return `${base}/VesselPositionSingle`;
}
/** @deprecated use shipfinderUrl(); kept for the tests' host check */
export const SHIPFINDER_URL = `${SHIPFINDER_DEFAULT_BASE}/VesselPositionSingle`;
/** Starter keys carry 50 position calls; keep a few for a by-hand check. */
export const DEFAULT_SHIPFINDER_CAP = 45;

export function shipfinderEnabled(): boolean {
  return Boolean(process.env["SHIPFINDER_API_KEY"]);
}
export function shipfinderCap(): number {
  const n = Number(process.env["SHIPFINDER_CALL_CAP"]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SHIPFINDER_CAP;
}

/** ETA as unix seconds or "YYYY-MM-DD HH:MM:SS" (UTC) → ISO; null when absent or unparseable. */
export function parseShipfinderEta(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v * 1000).toISOString();
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d{9,10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (m) {
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
  }
  return null;
}

/** Map a VesselPositionSingle body to a fix, or null when it carries no usable position. */
export function parseShipfinder(body: unknown): SatelliteFix | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (Number(b["status"]) !== 0) return null;
  const d = b["data"];
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const r = d as Record<string, unknown>;
  const lat = Number(r["lat"]);
  const lon = Number(r["lng"] ?? r["lon"]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const t = Number(r["last_time"]);
  if (!Number.isFinite(t) || t <= 0) return null;
  const num = (v: unknown, max: number): number | null => {
    const n = Number(v); return Number.isFinite(n) && n >= 0 && n < max ? n : null;
  };
  const dest = typeof r["dest"] === "string" ? r["dest"].trim() : "";
  const destcode = typeof r["destcode"] === "string" ? r["destcode"].trim() : "";
  return {
    lat, lon,
    courseDeg: num(r["cog"], 360),
    speedKn: num(r["sog"], 102.3),
    headingDeg: num(r["hdg"], 360), // 511 = invalid
    at: new Date(t * 1000).toISOString(),
    source: Number(r["data_source"]) === 1 ? "satellite" : Number(r["data_source"]) === 0 ? "terrestrial" : "unknown",
    // The port code ("CNTZO", "USPCV") decodes through our LOCODE table; the name is the fallback.
    destination: destcode || dest || null,
    etaUtc: parseShipfinderEta(r["eta"]),
  };
}
