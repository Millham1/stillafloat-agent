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
/** The API root (…/v1) the key is bound to; endpoint families hang off it. */
export function shipfinderRoot(): string {
  const base = (process.env["SHIPFINDER_API_BASE"] ?? SHIPFINDER_DEFAULT_BASE).replace(/^["']+|["']+$/g, "").replace(/\/+$/, "");
  return base.replace(/\/AIS$/, "");
}
export function shipfinderEndpoint(path: string): string {
  return `${shipfinderRoot()}/${path.replace(/^\/+/, "")}`;
}
export function shipfinderUrl(): string {
  return shipfinderEndpoint("AIS/VesselPositionSingle");
}
/** Starter keys carry 10 History Track calls; keep two for a by-hand check. */
export const DEFAULT_SHIPFINDER_TRACK_CAP = 8;
export function shipfinderTrackCap(): number {
  const n = Number(process.env["SHIPFINDER_TRACK_CAP"]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SHIPFINDER_TRACK_CAP;
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


// ── Vessels Nearby / Multi (unmetered on Starter): a list of the same records ──

export interface NearbyVessel { mmsi: string; name: string; fix: SatelliteFix }

/** Every usable vessel record in a list response (VesselsNearby, VesselPositionMulti). */
export function parseShipfinderList(body: unknown): NearbyVessel[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  if (Number(b["status"]) !== 0 || !Array.isArray(b["data"])) return [];
  const out: NearbyVessel[] = [];
  for (const row of b["data"] as unknown[]) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const fix = parseShipfinder({ status: 0, data: r });
    const mmsi = String(r["mmsi"] ?? "").trim();
    if (!fix || !/^\d{9}$/.test(mmsi)) continue;
    out.push({ mmsi, name: typeof r["ship_name"] === "string" ? r["ship_name"].trim() : "", fix });
  }
  return out;
}

// ── Vessel Search (unmetered): who is this MMSI / name ────────────────────────

export interface SearchHit { mmsi: string; imo: string | null; name: string; matchType: number | null; lastTime: string | null }

export function parseShipfinderSearch(body: unknown): SearchHit[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  if (Number(b["status"]) !== 0 || !Array.isArray(b["data"])) return [];
  const out: SearchHit[] = [];
  for (const row of b["data"] as unknown[]) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const mmsi = String(r["mmsi"] ?? "").trim();
    if (!/^\d{9}$/.test(mmsi)) continue;
    const imoN = Number(r["imo"]);
    const t = Number(r["last_time"]);
    out.push({
      mmsi,
      imo: Number.isFinite(imoN) && imoN > 0 ? String(imoN) : null,
      name: typeof r["ship_name"] === "string" ? r["ship_name"].trim() : "",
      matchType: Number.isFinite(Number(r["match_type"])) ? Number(r["match_type"]) : null,
      lastTime: Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : null,
    });
  }
  return out;
}

/** AIS names are upper-case, 20 characters, sometimes abbreviated: compare loosely. */
export function normalizeShipName(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
export function shipNamesMatch(a: string, b: string): boolean {
  const x = normalizeShipName(a), y = normalizeShipName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // AIS truncates at 20 characters ("MARGARITAVILLE AT SE"): a prefix of at least 12 counts.
  const shorter = x.length <= y.length ? x : y, longer = x.length <= y.length ? y : x;
  return shorter.length >= 12 && longer.startsWith(shorter);
}

export interface RegistryEntry { name: string; mmsi: string; imo: string | null }
export interface RegistryVerdict {
  status: "ok" | "unknown" | "suspect" | "corrected";
  reportedName: string | null;   // what the MMSI answers to
  proposedMmsi: string | null;   // when a same-name/same-IMO hull was found under another MMSI
  proposedImo: string | null;    // IMO to fill in when ours is empty
  reason: string;
}

/**
 * Decide what a registry row is, from a search by its MMSI and (when needed) a
 * search by its name. Pure. A correction is only "corrected" (safe to apply)
 * when the IMO ties the two together or the name matches exactly with one
 * candidate; anything looser is a suspect for a human.
 */
export function verifyRegistryEntry(entry: RegistryEntry, byMmsi: SearchHit[], byName: SearchHit[]): RegistryVerdict {
  const hit = byMmsi.find((h) => h.mmsi === entry.mmsi) ?? null;
  if (hit && shipNamesMatch(hit.name, entry.name)) {
    return { status: "ok", reportedName: hit.name, proposedMmsi: null, proposedImo: !entry.imo && hit.imo ? hit.imo : null, reason: "MMSI answers to our name" };
  }
  // Our MMSI is silent or answers to another hull: look for our hull by name.
  const candidates = byName.filter((h) => shipNamesMatch(h.name, entry.name) && h.mmsi !== entry.mmsi);
  const byImo = entry.imo ? candidates.find((h) => h.imo === entry.imo) ?? null : null;
  if (byImo) {
    return { status: "corrected", reportedName: hit?.name ?? null, proposedMmsi: byImo.mmsi, proposedImo: null, reason: `IMO ${entry.imo} now broadcasts as MMSI ${byImo.mmsi}` };
  }
  if (!hit) {
    if (candidates.length === 1 && candidates[0]) {
      const c = candidates[0];
      return { status: "corrected", reportedName: null, proposedMmsi: c.mmsi, proposedImo: c.imo, reason: "our MMSI is unknown to the provider; one hull of that name exists" };
    }
    return { status: "unknown", reportedName: null, proposedMmsi: null, proposedImo: null, reason: candidates.length ? `${candidates.length} hulls of that name; none tied by IMO` : "MMSI unknown to the provider and no hull of that name" };
  }
  return {
    status: "suspect",
    reportedName: hit.name,
    proposedMmsi: candidates.length === 1 && candidates[0] ? candidates[0].mmsi : null,
    proposedImo: null,
    reason: `MMSI ${entry.mmsi} answers to "${hit.name}"${candidates.length === 1 ? "; one hull of our name found" : ""}`,
  };
}

// ── Vessel History Track (metered: 10 on Starter) ─────────────────────────────

export interface TrackSample { lat: number; lon: number; at: string; speedKn: number | null; source: "satellite" | "terrestrial" | "unknown" }

/** Track points oldest first; bad rows dropped. */
export function parseShipfinderTrack(body: unknown): TrackSample[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  if (Number(b["status"]) !== 0 || !Array.isArray(b["data"])) return [];
  const out: TrackSample[] = [];
  for (const row of b["data"] as unknown[]) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const lat = Number(r["lat"]), lon = Number(r["lng"] ?? r["lon"]), t = Number(r["utc"] ?? r["last_time"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0) || !Number.isFinite(t) || t <= 0) continue;
    const sog = Number(r["sog"]);
    out.push({
      lat, lon, at: new Date(t * 1000).toISOString(),
      speedKn: Number.isFinite(sog) && sog >= 0 && sog < 102.3 ? sog : null,
      source: Number(r["data_source"]) === 1 ? "satellite" : Number(r["data_source"]) === 0 ? "terrestrial" : "unknown",
    });
  }
  return out.sort((a, b2) => Date.parse(a.at) - Date.parse(b2.at));
}

/** Return codes that mean "stop asking for now" (Service Return Code table + the live 38 seen 2026-09-11). */
export const SHIPFINDER_THROTTLE_CODES = new Set([12, 22, 23, 29, 38]);
export interface SearchResult { status: number | null; msg: string; hits: SearchHit[] }
export function parseShipfinderSearchResult(body: unknown): SearchResult {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const st = Number(b["status"]);
  return { status: Number.isFinite(st) ? st : null, msg: typeof b["msg"] === "string" ? b["msg"] : "", hits: parseShipfinderSearch(body) };
}
export function isThrottle(status: number | null): boolean {
  return status !== null && SHIPFINDER_THROTTLE_CODES.has(status);
}
