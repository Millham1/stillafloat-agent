// nws-marine-source.ts — non-tropical storms from the National Weather Service
// (Mark, 2026-09-26: "architect the fix to pick up nor'easters, and Pacific
// storms large enough to warrant a diversion").
//
// WHY: the storm scanner read only NHC, which never carries a nor'easter. The
// 22–25 Sep 2026 nor'easter re-routed Vision of the Seas (Canada → Bahamas),
// cut Carnival Venezia's Bermuda call and sent Norwegian Escape home early, and
// the system produced no alert, no pins and no nudge.
//
// WHAT NWS PUBLISHES (all free, no key):
//   • api.weather.gov/alerts/active — marine warnings by zone, graded by WIND:
//     Gale 34–47 kt, Storm 48–63 kt, Hurricane Force 64 kt+. Stable ids,
//     onset/ends, zone codes. Pressure is not a trigger NWS uses.
//   • The Ocean Prediction Center High Seas Forecast (FZNT01/FZPN01, 4×/day)
//     names every warning-grade low with its position, central pressure and
//     movement: ".LOW 38N72W 986 MB DRIFTING N 05 KT". It also covers waters
//     with no NWS zones (Nova Scotia, the open Atlantic).
//   • WPC's coded surface bulletin lists every analysed low with pressure every
//     3 h ("LOWS 986 3872 …") — the pressure-only backstop.
//
// THE TRIGGER (Mark's decision 2026-09-26, after the warning timeline showed
// Gale Warnings 40 h before Royal Caribbean's announcement and Storm Warnings
// 16 h after it):
//   a low is an event when it sits in or within reach of a cruising ground AND
//     • the High Seas Forecast grades it Storm or Hurricane Force, or
//     • an NWS Storm / Hurricane Force warning covers waters in that ground, or
//     • an NWS Gale Warning covers those waters and lasts 24 h+ or the low is
//       ≤ 990 mb, or
//     • the low is ≤ 980 mb (no warning needed — a bomb cyclone forming).
//   A Gale Warning with no low behind it is weather, not a storm: ignored.
//
// IDENTITY: NWS gives a low no id. An event keeps the nhc_id of the prior NWS
// alert whose last position (or 24 h forecast position) is within reach;
// otherwise it is born as NWS-<basin>-<date>-<position>. Pure and tested.
//
// Pure functions first; the fetchers are at the bottom.

import { logger } from "./logger";
import { groundsForPoint, NAMED_STORM_MARGIN_DEG, type RegionKey } from "./storm-grounds";
import type { RawSystem } from "./storm-source";

// ── Types ───────────────────────────────────────────────────────────────────

/** 1 = Gale, 2 = Storm, 3 = Hurricane Force. */
export type WarningGrade = 1 | 2 | 3;

export interface MarineWarning {
  id: string;
  event: string;
  grade: WarningGrade;
  sender: string;
  areaDesc: string;
  onset: string | null;
  ends: string | null;
  zones: string[];
  zoneUrls: string[];
}

export interface LowPosition { lat: number; lon: number; pressureMb: number | null }

export interface HighSeasLow {
  basin: "atlantic" | "pacific";
  /** Grade of the warning block the low was listed under; 0 = none. */
  grade: WarningGrade | 0;
  lat: number;
  lon: number;
  pressureMb: number;
  movement: string | null;
  winds: string | null;
  seas: string | null;
  forecast24: LowPosition | null;
  forecast48: LowPosition | null;
  text: string;
}

export interface CodedLow { lat: number; lon: number; pressureMb: number }

export interface ZoneInfo { regions: RegionKey[]; lat: number; lon: number }

export interface PriorMarineAlert {
  nhc_id: string;
  status: string;
  last_updated: string;
  raw: {
    kind?: "low" | "region";
    lat?: number | null;
    lon?: number | null;
    forecast24?: LowPosition | null;
    regions?: string[];
  } | null;
}

export interface MarineBuildInput {
  warnings: MarineWarning[];
  lows: HighSeasLow[];
  codedLows: CodedLow[];
  /** zone URL → regions + centroid; a zone missing here is unknown (skipped). */
  zones: ReadonlyMap<string, ZoneInfo>;
  prior: PriorMarineAlert[];
  now: Date;
}

// ── Thresholds (Mark, 2026-09-26) ───────────────────────────────────────────

export const GALE_MIN_HOURS = 24;
export const GALE_LOW_MAX_MB = 990;
export const BOMB_LOW_MAX_MB = 980;
/** A warning zone this far from the low (or its 24 h position) is its weather. */
export const ATTACH_NM = 700;
/** Event grounds reach this far past a region box for a graded storm. */
export const EVENT_MARGIN_DEG = 5;
/** Continuity: a prior alert this close to today's position is the same storm. */
export const SAME_STORM_NM = 400;
export const SAME_STORM_FORECAST_NM = 300;
export const PRIOR_MAX_AGE_H = 48;

export const GRADE_LABEL: Record<WarningGrade, string> = {
  1: "Gale Warning",
  2: "Storm Warning",
  3: "Hurricane Force Wind Warning",
};

const EVENT_GRADE: Record<string, WarningGrade> = {
  "gale warning": 1,
  "storm warning": 2,
  "hurricane force wind warning": 3,
};

export const ALERTS_URL =
  "https://api.weather.gov/alerts/active?event=Gale%20Warning,Storm%20Warning,Hurricane%20Force%20Wind%20Warning";
export const HIGH_SEAS_FEEDS: Array<{ url: string; basin: HighSeasLow["basin"]; page: string }> = [
  { url: "https://tgftp.nws.noaa.gov/data/raw/fz/fznt01.kwbc.hsf.at1.txt", basin: "atlantic", page: "https://ocean.weather.gov/shtml/NFDHSFAT1.php" },
  { url: "https://tgftp.nws.noaa.gov/data/raw/fz/fznt02.knhc.hsf.at2.txt", basin: "atlantic", page: "https://www.nhc.noaa.gov/text/MIAHSFAT2.shtml" },
  { url: "https://tgftp.nws.noaa.gov/data/raw/fz/fzpn01.kwbc.hsf.ep1.txt", basin: "pacific", page: "https://ocean.weather.gov/shtml/NFDHSFEP1.php" },
  { url: "https://tgftp.nws.noaa.gov/data/raw/fz/fzpn03.knhc.hsf.ep2.txt", basin: "pacific", page: "https://www.nhc.noaa.gov/text/MIAHSFEP2.shtml" },
];
export const CODED_SURFACE_URL = "https://www.wpc.ncep.noaa.gov/discussions/codsus";
/** OPC surface analyses (the .png names redirect here; these are the stable files). */
export const SURFACE_CHART = {
  atlantic: "https://ocean.weather.gov/shtml/A_full_00hrsfc.gif",
  pacific: "https://ocean.weather.gov/shtml/P_full_00hrsfc.gif",
};
const USER_AGENT = "stillafloatcruising.com storm-alerts (mark@stillafloatcruising.com)";

// ── Geometry helpers ────────────────────────────────────────────────────────

export function nmBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Mean of every vertex — coarse, but our region boxes are hundreds of miles wide. */
export function geometryCentroid(geometry: unknown): { lat: number; lon: number } | null {
  const pts: Array<[number, number]> = [];
  const walk = (c: unknown): void => {
    if (!Array.isArray(c) || !c.length) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") { pts.push([c[0], c[1]]); return; }
    for (const x of c) walk(x);
  };
  walk((geometry as { coordinates?: unknown } | null)?.coordinates);
  if (!pts.length) return null;
  const lon = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return { lat, lon };
}

// ── Parsers (pure) ──────────────────────────────────────────────────────────

/** api.weather.gov/alerts/active features → warnings we grade. */
export function parseMarineAlerts(json: unknown): MarineWarning[] {
  const features = (json as { features?: unknown[] } | null)?.features;
  if (!Array.isArray(features)) return [];
  const out: MarineWarning[] = [];
  for (const f of features) {
    const p = (f as { properties?: Record<string, unknown> })?.properties ?? {};
    const event = String(p["event"] ?? "");
    const grade = EVENT_GRADE[event.toLowerCase()];
    if (!grade) continue;
    const geocode = (p["geocode"] as { UGC?: unknown } | undefined)?.UGC;
    const zoneUrls = Array.isArray(p["affectedZones"]) ? (p["affectedZones"] as unknown[]).map(String) : [];
    out.push({
      id: String(p["id"] ?? (f as { id?: string }).id ?? ""),
      event,
      grade,
      sender: String(p["senderName"] ?? ""),
      areaDesc: String(p["areaDesc"] ?? ""),
      onset: typeof p["onset"] === "string" ? p["onset"] : (typeof p["effective"] === "string" ? p["effective"] : null),
      ends: typeof p["ends"] === "string" ? p["ends"] : (typeof p["expires"] === "string" ? p["expires"] : null),
      zones: Array.isArray(geocode) ? geocode.map(String) : [],
      zoneUrls,
    });
  }
  return out;
}

const BLOCK_HEADER = /^\.\.\.(GALE WARNING|STORM WARNING|HURRICANE FORCE WIND WARNING|HURRICANE WARNING|TROPICAL STORM WARNING)\.\.\./;
// A section header is ".WARNINGS." / ".SYNOPSIS AND FORECAST." — letters only.
// ".48 HOUR FORECAST CONDITIONS DESCRIBED WITH GALE WARNING ABOVE." also ends
// in a period but starts with a digit: it belongs to the low above it.
const SECTION_HEADER = /^\.(?!\d)[A-Z][A-Z ]+\.$/;
const LOW_RE = /\.(?:COMPLEX |DEVELOPING |NEW )?LOW\b[^\n]*?\b(\d{1,2}(?:\.\d)?)N(\d{1,3}(?:\.\d)?)([EW])\s+(\d{3,4})\s*MB(?:\s+(MOVING|DRIFTING)\s+([NSEW]{1,3})\s+(\d{1,3})\s+KT|\s+(STATIONARY|QUASI-STATIONARY|NEARLY STATIONARY))?/;
const FORECAST_RE = (h: 24 | 48) => new RegExp(`\\.${h} HOUR FORECAST\\s+(?:COMPLEX |DEVELOPING )?LOW\\b[^\\n]*?\\b(\\d{1,2}(?:\\.\\d)?)N(\\d{1,3}(?:\\.\\d)?)([EW])\\s+(\\d{3,4})\\s*MB`);

function signedLon(v: string, hemi: string): number {
  const n = Number(v);
  return hemi === "E" ? n : -n;
}

/**
 * The lows named in a High Seas Forecast's WARNINGS blocks, with the block's
 * grade. Tropical blocks (hurricane / tropical storm warnings) are skipped —
 * NHC's own feed carries those. A block can hold several lows; each `.LOW`
 * sentence starts a new one, and forecast lines belong to the low above them.
 */
export function parseHighSeasLows(text: string, basin: HighSeasLow["basin"]): HighSeasLow[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: HighSeasLow[] = [];
  let grade: WarningGrade | 0 = 0;
  let inBlock = false;
  let buf: string[] = [];

  const flush = (): void => {
    if (!inBlock || !buf.length) { buf = []; return; }
    const block = buf.join("\n").trim();
    buf = [];
    // Split on sentence starts that begin a new low, keep each low's tail.
    const parts = block.split(/(?=\n\.(?:COMPLEX |DEVELOPING |NEW )?LOW\b)/);
    for (const part of parts) {
      const one = part.replace(/\n(?!\.)/g, " ");
      const m = one.match(LOW_RE);
      if (!m) continue;
      const lat = Number(m[1]);
      const lon = signedLon(m[2] ?? "0", m[3] ?? "W");
      const pressureMb = Number(m[4]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(pressureMb)) continue;
      const movement = m[5] && m[6] && m[7] ? `${m[6]} at ${Number(m[7])} kt` : (m[8] ? "stationary" : null);
      const winds = one.match(/WINDS\s+(\d{1,3})\s+TO\s+(\d{1,3})\s+KT/);
      const seas = one.match(/SEAS\s+(\d{1,2}(?:\.\d)?)\s+TO\s+(\d{1,2}(?:\.\d)?)\s+M/);
      const fc = (h: 24 | 48): LowPosition | null => {
        const f = one.match(FORECAST_RE(h));
        if (!f) return null;
        return { lat: Number(f[1]), lon: signedLon(f[2] ?? "0", f[3] ?? "W"), pressureMb: Number(f[4]) };
      };
      out.push({
        basin, grade, lat, lon, pressureMb, movement,
        winds: winds ? `${winds[1]}–${winds[2]} kt` : null,
        seas: seas ? `${seas[1]}–${seas[2]} m` : null,
        forecast24: fc(24), forecast48: fc(48),
        text: part.trim().slice(0, 1200),
      });
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const header = line.match(BLOCK_HEADER);
    if (header) {
      flush();
      const label = (header[1] ?? "").toLowerCase();
      if (label === "hurricane warning" || label === "tropical storm warning") { inBlock = false; grade = 0; continue; }
      grade = EVENT_GRADE[label] ?? 0;
      inBlock = grade > 0;
      continue;
    }
    if (SECTION_HEADER.test(line) || line === "$$") { flush(); inBlock = false; grade = 0; continue; }
    if (inBlock) buf.push(line);
  }
  flush();
  return out;
}

/** WPC coded surface bulletin: "LOWS 986 3872 1009 3044 …" → positions with pressure. */
export function parseCodedLows(text: string): CodedLow[] {
  const m = text.replace(/\r/g, "").match(/^LOWS\s+([\s\S]*?)(?=^\s*(?:HIGHS|STNRY|COLD|WARM|OCFNT|TROF|\$\$)|\n\n|$)/m);
  if (!m) return [];
  const tokens = (m[1] ?? "").split(/\s+/).filter(Boolean);
  const out: CodedLow[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const mb = Number(tokens[i]);
    const pos = tokens[i + 1] ?? "";
    if (!Number.isFinite(mb) || mb < 850 || mb > 1090) break;
    if (!/^\d{4,5}$/.test(pos)) break;
    const lat = Number(pos.slice(0, 2));
    const lon = -Number(pos.slice(2));
    out.push({ lat, lon, pressureMb: mb });
  }
  return out;
}

// ── Event building (pure) ───────────────────────────────────────────────────

function hoursBetween(a: string | null, b: string | null): number | null {
  const t1 = Date.parse(a ?? ""); const t2 = Date.parse(b ?? "");
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
  return (t2 - t1) / 3_600_000;
}

function uniq<T>(xs: readonly T[]): T[] { return [...new Set(xs)]; }

function groundsAround(p: { lat: number; lon: number } | null, marginDeg: number): RegionKey[] {
  return p ? groundsForPoint(p.lat, p.lon, marginDeg) : [];
}

export interface WarningWithRegions extends MarineWarning {
  regions: RegionKey[];
  centroids: Array<{ lat: number; lon: number }>;
  durationH: number | null;
}

export function withRegions(warnings: readonly MarineWarning[], zones: ReadonlyMap<string, ZoneInfo>): WarningWithRegions[] {
  return warnings.map((w) => {
    const infos = w.zoneUrls.map((u) => zones.get(u)).filter((z): z is ZoneInfo => Boolean(z));
    return {
      ...w,
      regions: uniq(infos.flatMap((z) => z.regions)),
      centroids: infos.map((z) => ({ lat: z.lat, lon: z.lon })),
      durationH: hoursBetween(w.onset, w.ends),
    };
  });
}

/** A gale that lasts, or blows around a deep low, counts; a brief gale does not. */
export function galeQualifies(w: { durationH: number | null }, lowPressureMb: number | null): boolean {
  if (w.durationH != null && w.durationH >= GALE_MIN_HOURS) return true;
  return lowPressureMb != null && lowPressureMb <= GALE_LOW_MAX_MB;
}

export function stormName(grounds: readonly string[], basin: HighSeasLow["basin"]): string {
  const has = (k: RegionKey) => grounds.includes(k);
  if (basin === "atlantic") {
    if (has("us_east_coast") || has("canada_new_england")) return "Nor'easter";
    if (has("gulf") && !has("bahamas") && !has("e_caribbean") && !has("w_caribbean")) return "Gulf storm";
    return "Atlantic storm";
  }
  if (has("alaska")) return "Gulf of Alaska storm";
  return "Pacific storm";
}

export function satelliteFor(grounds: readonly string[], basin: HighSeasLow["basin"]): string {
  const has = (k: RegionKey) => grounds.includes(k);
  if (has("alaska")) return "https://cdn.star.nesdis.noaa.gov/GOES18/ABI/SECTOR/ak/GEOCOLOR/latest.jpg";
  if (has("hawaii")) return "https://cdn.star.nesdis.noaa.gov/GOES18/ABI/SECTOR/hi/GEOCOLOR/latest.jpg";
  if (basin === "pacific") return "https://cdn.star.nesdis.noaa.gov/GOES18/ABI/SECTOR/eep/GEOCOLOR/latest.jpg";
  if (has("canada_new_england") || has("us_east_coast")) return "https://cdn.star.nesdis.noaa.gov/GOES19/ABI/SECTOR/ne/GEOCOLOR/latest.jpg";
  return "https://cdn.star.nesdis.noaa.gov/GOES19/ABI/SECTOR/taw/GEOCOLOR/latest.jpg";
}

function rawBasin(grounds: readonly string[], basin: HighSeasLow["basin"]): RawSystem["basin"] {
  if (basin === "atlantic") return "atlantic";
  return grounds.includes("hawaii") ? "central_pacific" : "eastern_pacific";
}

function dateStamp(d: Date): string { return d.toISOString().slice(0, 10).replace(/-/g, ""); }

function newId(basin: HighSeasLow["basin"], now: Date, tail: string, taken: Set<string>): string {
  const base = `NWS-${basin === "atlantic" ? "AT" : "PA"}-${dateStamp(now)}-${tail}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** Continuity with the prior scan's NWS alerts — see the header. */
export function matchPrior(
  ev: { lat: number | null; lon: number | null; grounds: string[]; kind: "low" | "region" },
  prior: readonly PriorMarineAlert[], now: Date, used: Set<string>,
): PriorMarineAlert | null {
  let best: { p: PriorMarineAlert; score: number } | null = null;
  for (const p of prior) {
    if (used.has(p.nhc_id) || !p.nhc_id.startsWith("NWS-")) continue;
    const ageH = (now.getTime() - Date.parse(p.last_updated)) / 3_600_000;
    if (!Number.isFinite(ageH) || ageH > PRIOR_MAX_AGE_H) continue;
    const raw = p.raw ?? {};
    let score: number | null = null;
    if (ev.kind === "low" && ev.lat != null && ev.lon != null && raw.lat != null && raw.lon != null) {
      const d = nmBetween(ev.lat, ev.lon, raw.lat, raw.lon);
      const f = raw.forecast24 ? nmBetween(ev.lat, ev.lon, raw.forecast24.lat, raw.forecast24.lon) : Infinity;
      if (d <= SAME_STORM_NM || f <= SAME_STORM_FORECAST_NM) score = Math.min(d, f);
    } else if (ev.kind === "region") {
      // Same region continues a region event; it also continues a low-based
      // alert whose low the High Seas text has stopped naming while the zone
      // warnings persist — otherwise the storm would fork into a second alert.
      const overlap = (raw.regions ?? []).some((r) => ev.grounds.includes(r));
      const nearPrior = raw.kind === "region" ||
        (ev.lat != null && ev.lon != null && raw.lat != null && raw.lon != null && nmBetween(ev.lat, ev.lon, raw.lat, raw.lon) <= ATTACH_NM);
      if (overlap && nearPrior) score = ageH;
    }
    if (score != null && (!best || score < best.score)) best = { p, score };
  }
  if (best) used.add(best.p.nhc_id);
  return best?.p ?? null;
}

interface MarineEvent {
  kind: "low" | "region";
  basin: HighSeasLow["basin"];
  grounds: RegionKey[];
  grade: WarningGrade;
  lat: number | null;
  lon: number | null;
  low: HighSeasLow | null;
  warnings: WarningWithRegions[];
  via: string[];
}

export interface PathPoint { kind: "low" | "f24" | "f48" | "zone"; lat: number; lon: number; label?: string }

/** The storm's track and the waters under warning, as points ships are measured against. */
export function pathPointsFor(ev: { lat: number | null; lon: number | null; low: HighSeasLow | null; warnings: readonly WarningWithRegions[] }): PathPoint[] {
  const out: PathPoint[] = [];
  if (ev.low) {
    out.push({ kind: "low", lat: ev.low.lat, lon: ev.low.lon, label: `${ev.low.pressureMb} mb` });
    if (ev.low.forecast24) out.push({ kind: "f24", lat: ev.low.forecast24.lat, lon: ev.low.forecast24.lon, label: "24 h forecast" });
    if (ev.low.forecast48) out.push({ kind: "f48", lat: ev.low.forecast48.lat, lon: ev.low.forecast48.lon, label: "48 h forecast" });
  } else if (ev.lat != null && ev.lon != null) {
    out.push({ kind: "low", lat: ev.lat, lon: ev.lon });
  }
  const seen = new Set<string>();
  for (const w of ev.warnings) {
    for (const c of w.centroids) {
      const key = `${c.lat.toFixed(1)},${c.lon.toFixed(1)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "zone", lat: c.lat, lon: c.lon, label: `${w.event}: ${w.areaDesc.split(";")[0]?.trim() ?? ""}`.slice(0, 120) });
    }
  }
  return out;
}

function summarizeWarnings(ws: readonly WarningWithRegions[]): string {
  const byEvent = new Map<string, Set<string>>();
  for (const w of ws) {
    const set = byEvent.get(w.event) ?? new Set<string>();
    set.add(w.sender.replace(/^NWS\s+/i, ""));
    byEvent.set(w.event, set);
  }
  return [...byEvent].map(([e, offices]) => `${e}: ${[...offices].join(", ")}`).join("; ");
}

/**
 * Turn the three feeds into RawSystems for the scan. See the header for the
 * rules. `zones` may be incomplete (a zone fetch that failed this scan): an
 * unknown zone contributes no region, so a warning is never invented for a
 * ground it cannot be placed in.
 */
export function buildMarineSystems(input: MarineBuildInput): { systems: RawSystem[]; ignoredGales: number } {
  const { now } = input;
  const warnings = withRegions(input.warnings, input.zones);
  const usedWarnings = new Set<string>();
  const events: MarineEvent[] = [];

  for (const low of input.lows) {
    const reach = uniq([
      ...groundsAround(low, NAMED_STORM_MARGIN_DEG),
      ...groundsAround(low.forecast24, NAMED_STORM_MARGIN_DEG),
      ...groundsAround(low.forecast48, NAMED_STORM_MARGIN_DEG),
    ]);
    if (!reach.length) continue;

    const attached = warnings.filter((w) => {
      if (usedWarnings.has(w.id)) return false;
      if (!w.regions.some((r) => reach.includes(r))) return false;
      return w.centroids.some((c) =>
        nmBetween(c.lat, c.lon, low.lat, low.lon) <= ATTACH_NM ||
        (low.forecast24 ? nmBetween(c.lat, c.lon, low.forecast24.lat, low.forecast24.lon) <= ATTACH_NM : false));
    });
    const qualifying = attached.filter((w) => w.grade >= 2 || galeQualifies(w, low.pressureMb));
    const via: string[] = [];
    if (low.grade >= 2) via.push(`High Seas Forecast: ${GRADE_LABEL[low.grade as WarningGrade]}`);
    if (low.pressureMb <= BOMB_LOW_MAX_MB) via.push(`central pressure ${low.pressureMb} mb`);
    if (qualifying.length) via.push(summarizeWarnings(qualifying));
    if (!via.length) continue;

    const graded = low.grade >= 2 || low.pressureMb <= BOMB_LOW_MAX_MB;
    const grounds = uniq([
      ...qualifying.flatMap((w) => w.regions).filter((r) => reach.includes(r)),
      ...(graded ? [...groundsAround(low, EVENT_MARGIN_DEG), ...groundsAround(low.forecast24, EVENT_MARGIN_DEG)] : []),
    ]);
    if (!grounds.length) continue;

    for (const w of attached) usedWarnings.add(w.id);
    const grade = Math.max(low.grade, low.pressureMb <= BOMB_LOW_MAX_MB ? 2 : 0, ...qualifying.map((w) => w.grade)) as WarningGrade;
    events.push({ kind: "low", basin: low.basin, grounds, grade, lat: low.lat, lon: low.lon, low, warnings: attached, via });
  }

  // Storm-grade warnings with no low in the High Seas text: one event per region.
  let ignoredGales = 0;
  const byRegion = new Map<RegionKey, WarningWithRegions[]>();
  for (const w of warnings) {
    if (usedWarnings.has(w.id) || !w.regions.length) continue;
    if (w.grade < 2) { ignoredGales++; continue; }
    for (const r of w.regions) byRegion.set(r, [...(byRegion.get(r) ?? []), w]);
  }
  for (const [region, ws] of byRegion) {
    const pts = ws.flatMap((w) => w.centroids);
    const lat = pts.length ? pts.reduce((s, p) => s + p.lat, 0) / pts.length : null;
    const lon = pts.length ? pts.reduce((s, p) => s + p.lon, 0) / pts.length : null;
    const basin: HighSeasLow["basin"] = region === "alaska" || region === "hawaii" || region === "mexican_riviera" ? "pacific" : "atlantic";
    events.push({
      kind: "region", basin, grounds: [region],
      grade: Math.max(...ws.map((w) => w.grade)) as WarningGrade,
      lat, lon, low: null, warnings: ws, via: [summarizeWarnings(ws)],
    });
  }

  // The pressure backstop from WPC: a bomb low inside a ground that neither
  // feed above has caught yet (the High Seas text lags the 3-hourly analysis).
  for (const c of input.codedLows) {
    if (c.pressureMb > BOMB_LOW_MAX_MB) continue;
    const grounds = groundsAround(c, EVENT_MARGIN_DEG);
    if (!grounds.length) continue;
    const dup = events.some((e) => e.lat != null && e.lon != null && nmBetween(e.lat, e.lon, c.lat, c.lon) <= SAME_STORM_NM);
    if (dup) continue;
    events.push({
      kind: "low", basin: c.lon < -100 ? "pacific" : "atlantic", grounds, grade: 2,
      lat: c.lat, lon: c.lon, low: null, warnings: [], via: [`WPC surface analysis: ${c.pressureMb} mb`],
    });
  }

  // Identity + RawSystem shape.
  const usedPrior = new Set<string>();
  const taken = new Set<string>();
  const systems: RawSystem[] = [];
  for (const ev of events) {
    const prior = matchPrior(ev, input.prior, now, usedPrior);
    const tail = ev.kind === "low" && ev.lat != null && ev.lon != null
      ? `${Math.round(ev.lat)}N${Math.abs(Math.round(ev.lon))}W`
      : ev.grounds[0] ?? "region";
    const nhcId = prior?.nhc_id ?? newId(ev.basin, now, tail, taken);
    taken.add(nhcId);
    const pressure = ev.low?.pressureMb ?? (ev.via[0]?.match(/(\d{3,4}) mb/)?.[1] ? Number(ev.via[0].match(/(\d{3,4}) mb/)?.[1]) : null);
    const intensity = [pressure != null ? `${pressure} mb` : null, ev.low?.winds ? `winds ${ev.low.winds}` : null]
      .filter(Boolean).join(", ") || null;
    const chart = SURFACE_CHART[ev.basin];
    const text = [
      ev.low?.text ?? "",
      ev.warnings.length ? `NWS marine warnings in effect — ${summarizeWarnings(ev.warnings)}. Areas: ${uniq(ev.warnings.map((w) => w.areaDesc)).join("; ").slice(0, 600)}` : "",
    ].filter(Boolean).join("\n\n").slice(0, 2000);
    systems.push({
      nhcId,
      basin: rawBasin(ev.grounds, ev.basin),
      name: stormName(ev.grounds, ev.basin),
      classification: GRADE_LABEL[ev.grade],
      lat: ev.lat, lon: ev.lon,
      intensity,
      movement: ev.low?.movement ?? null,
      formationChance: null,
      advisoryUrl: HIGH_SEAS_FEEDS.find((f) => f.basin === ev.basin)?.page ?? null,
      coneUrl: chart,
      satelliteUrl: satelliteFor(ev.grounds, ev.basin),
      outlookText: text,
      source: "nws_marine",
      grounds: ev.grounds,
      pressureMb: pressure,
      raw: {
        source: "nws_marine",
        kind: ev.kind,
        lat: ev.lat, lon: ev.lon,
        pressureMb: pressure,
        grade: ev.grade,
        forecast24: ev.low?.forecast24 ?? null,
        forecast48: ev.low?.forecast48 ?? null,
        // THE PATH (Mark, 2026-09-26: "we only ping a ship if the itinerary
        // says it's in the path of the storm"). Ships are pinned by distance
        // to these points, never by the region box — a nor'easter off New
        // Jersey must not sweep in every Florida turnaround just because
        // "U.S. East Coast" is one box from Miami to Sandy Hook.
        path: pathPointsFor(ev),
        movement: ev.low?.movement ?? null,
        winds: ev.low?.winds ?? null,
        seas: ev.low?.seas ?? null,
        regions: ev.grounds,
        via: ev.via,
        warnings: ev.warnings.map((w) => ({ id: w.id, event: w.event, sender: w.sender, areaDesc: w.areaDesc, onset: w.onset, ends: w.ends, zones: w.zones })),
      },
    });
  }
  return { systems, ignoredGales };
}

// ── Fetchers ────────────────────────────────────────────────────────────────

async function fetchText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json, application/json, text/plain, */*" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) { logger.warn({ url, status: r.status }, "nws-marine: non-200"); return null; }
    return await r.text();
  } catch (err) {
    logger.warn({ url, err }, "nws-marine: fetch failed");
    return null;
  }
}

/** Zone → regions, cached for the process lifetime (zone shapes do not move). */
const zoneCache = new Map<string, ZoneInfo | null>();

export async function resolveZones(zoneUrls: readonly string[]): Promise<Map<string, ZoneInfo>> {
  const out = new Map<string, ZoneInfo>();
  const todo = uniq(zoneUrls).filter((u) => /^https:\/\/api\.weather\.gov\/zones\//.test(u));
  const missing = todo.filter((u) => !zoneCache.has(u));
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < missing.length) {
      const u = missing[i++];
      if (!u) continue;
      const txt = await fetchText(u);
      if (!txt) continue; // unknown this scan; retried next time
      try {
        const g = JSON.parse(txt) as { geometry?: unknown };
        const c = geometryCentroid(g.geometry);
        zoneCache.set(u, c ? { regions: groundsForPoint(c.lat, c.lon, 1), lat: c.lat, lon: c.lon } : null);
      } catch { zoneCache.set(u, null); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  for (const u of todo) { const z = zoneCache.get(u); if (z) out.set(u, z); }
  return out;
}

/**
 * Everything the scan needs from NWS. `ok` is false when a feed the death-watch
 * depends on failed, so an absent storm is never mistaken for a dead one.
 */
export async function fetchMarineSystems(prior: readonly PriorMarineAlert[]): Promise<{ systems: RawSystem[]; ok: boolean }> {
  const [alertsTxt, coded, ...hsf] = await Promise.all([
    fetchText(ALERTS_URL),
    fetchText(CODED_SURFACE_URL),
    ...HIGH_SEAS_FEEDS.map((f) => fetchText(f.url)),
  ]);
  let warnings: MarineWarning[] = [];
  let alertsOk = false;
  if (alertsTxt) {
    try { warnings = parseMarineAlerts(JSON.parse(alertsTxt)); alertsOk = true; }
    catch (err) { logger.warn({ err }, "nws-marine: alerts JSON unreadable"); }
  }
  const lows: HighSeasLow[] = [];
  let hsfOk = 0;
  hsf.forEach((txt, idx) => {
    const feed = HIGH_SEAS_FEEDS[idx];
    if (!txt || !feed) return;
    hsfOk++;
    lows.push(...parseHighSeasLows(txt, feed.basin));
  });
  const codedLows = coded ? parseCodedLows(coded) : [];
  const zones = await resolveZones(warnings.flatMap((w) => w.zoneUrls));
  const built = buildMarineSystems({ warnings, lows, codedLows, zones, prior: [...prior], now: new Date() });
  logger.info({
    warnings: warnings.length, lows: lows.length, codedLows: codedLows.length, zonesKnown: zones.size,
    events: built.systems.length, ignoredGales: built.ignoredGales, alertsOk, hsfFeeds: hsfOk,
  }, "nws-marine: scan");
  return { systems: built.systems, ok: alertsOk && hsfOk === HIGH_SEAS_FEEDS.length };
}
