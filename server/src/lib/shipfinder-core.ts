// shipfinder-core.ts — ShipFinder (Elane) vessel-position API, pure parts.
//
// Second on-demand position provider beside Datadocked (Mark, 2026-09-11:
// "have you considered ship finder API?"). Starter key = 14-day trial, 50
// Vessel Position calls; Custom keys are quoted. The response says whether a
// coastal receiver or a satellite heard the ship (From: 0 / 1).
//
// Docs (read 2026-09-11): GET https://api.shipfinder.com/apicall/GetSingleShip
//   ?v=2&k=<key>&enc=1&id=<mmsi>&idtype=0
// { status: 0, data: [{ mmsi, lat, lon, sog, cog, hdg, dest, eta, From, lasttime }] }
//   lat/lon in 1/1,000,000 degree; sog in millimetres per second; cog and hdg in
//   1/100 degree; eta "MM-DD HH:MM"; lasttime = unix seconds.
import type { SatelliteFix } from "./satellite-ais-core";

export const SHIPFINDER_URL = "https://api.shipfinder.com/apicall/GetSingleShip";
/** Starter keys carry 50 position calls; keep a few for a by-hand check. */
export const DEFAULT_SHIPFINDER_CAP = 45;

export function shipfinderEnabled(): boolean {
  return Boolean(process.env["SHIPFINDER_API_KEY"]);
}
export function shipfinderCap(): number {
  const n = Number(process.env["SHIPFINDER_CALL_CAP"]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SHIPFINDER_CAP;
}

const MM_PER_S_PER_KNOT = 514.444;

/** "MM-DD HH:MM" with no year → the nearest such date to `now`, as ISO. */
export function parseShipfinderEta(s: unknown, now = new Date()): string | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const [month, day, hour, minute] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let year = now.getUTCFullYear();
  if (Date.UTC(year, month - 1, day, hour, minute) < now.getTime() - 7 * 86_400_000) year += 1;
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Map a GetSingleShip / GetManyShip body to a fix, or null when it carries no usable position. */
export function parseShipfinder(body: unknown, now = new Date()): SatelliteFix | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (Number(b["status"]) !== 0) return null;
  const rows = Array.isArray(b["data"]) ? (b["data"] as Record<string, unknown>[]) : [];
  const d = rows[0];
  if (!d) return null;
  const lat = Number(d["lat"]) / 1_000_000;
  const lon = Number(d["lon"]) / 1_000_000;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const t = Number(d["lasttime"]);
  if (!Number.isFinite(t) || t <= 0) return null;
  const at = new Date(t * 1000).toISOString();
  const cog = Number(d["cog"]) / 100;
  const hdg = Number(d["hdg"]) / 100;
  const sogKn = Number(d["sog"]) / MM_PER_S_PER_KNOT;
  const dest = typeof d["dest"] === "string" ? d["dest"].trim() : "";
  return {
    lat, lon,
    courseDeg: Number.isFinite(cog) && cog >= 0 && cog < 360 ? Math.round(cog * 10) / 10 : null,
    speedKn: Number.isFinite(sogKn) && sogKn >= 0 && sogKn < 102.3 ? Math.round(sogKn * 10) / 10 : null,
    headingDeg: Number.isFinite(hdg) && hdg >= 0 && hdg < 360 ? Math.round(hdg) : null, // 511 = not available
    at,
    source: Number(d["From"]) === 1 ? "satellite" : Number(d["From"]) === 0 ? "terrestrial" : "unknown",
    destination: dest || null,
    etaUtc: parseShipfinderEta(d["eta"], now),
  };
}
