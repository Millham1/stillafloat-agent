// nhc-forecast-track.ts — a tropical system's forecast track from NHC's
// Forecast/Advisory text (TCM), so hurricanes pin ships by PATH the way the
// NWS marine events do (Mark, 2026-09-26: "that was always the intention, by
// path. otherwise we would be reporting ships that are nowhere close to the
// possible path"). CurrentStorms.json gives only the current position; the
// advisory it links to (`forecastAdvisory.url`) carries the centre, central
// pressure, max winds and one line per forecast point out to five days:
//
//   TROPICAL DEPRESSION FAY FORECAST/ADVISORY NUMBER  27
//   2100 UTC SAT SEP 26 2026
//   ...CENTER LOCATED NEAR 29.8N  43.9W AT 26/2100Z
//   ESTIMATED MINIMUM CENTRAL PRESSURE 1009 MB
//   MAX SUSTAINED WINDS  30 KT WITH GUSTS TO  40 KT.
//   FORECAST VALID 27/0600Z 29.6N  43.9W
//   ...
//   OUTLOOK VALID 30/1800Z 23.4N  51.3W...POST-TROP/REMNT LOW
//   OUTLOOK VALID 01/1800Z...DISSIPATED
//
// Pure parser first (tested with the 26 Sep 2026 Fay and Odalys advisories);
// the fetcher is at the bottom.

import { logger } from "./logger";
import { PATH_TROPICAL_NM, type PathPoint } from "./storm-sailings";

export interface AdvisoryPoint {
  /** ISO time the point is valid for. */
  validAt: string;
  lat: number;
  lon: number;
  /** "POST-TROP/REMNT LOW", "EXTRATROPICAL" … when the line carries one. */
  note: string | null;
  /** "forecast" (12–72 h) or "outlook" (96–120 h). */
  kind: "forecast" | "outlook";
}

export interface ForecastAdvisory {
  issuedAt: string | null;
  centerLat: number | null;
  centerLon: number | null;
  centerAt: string | null;
  pressureMb: number | null;
  maxWindKt: number | null;
  points: AdvisoryPoint[];
  /** The outlook ends in "...DISSIPATED". */
  dissipates: boolean;
}

const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const ISSUED_RE = /^(\d{4}) UTC [A-Z]{3} ([A-Z]{3}) (\d{1,2}) (\d{4})/m;
const CENTER_RE = /CENTER LOCATED NEAR\s+(\d{1,2}\.\d)N\s+(\d{1,3}\.\d)([EW])\s+AT\s+(\d{2})\/(\d{4})Z/;
const PRESSURE_RE = /MINIMUM CENTRAL PRESSURE\s+(\d{3,4}) MB/;
const WIND_RE = /MAX SUSTAINED WINDS\s+(\d{1,3}) KT/;
const POINT_RE = /^(FORECAST|OUTLOOK) VALID (\d{2})\/(\d{4})Z\s+(\d{1,2}\.\d)N\s+(\d{1,3}\.\d)([EW])(?:\.\.\.(.+))?$/;
const DISSIPATED_RE = /^OUTLOOK VALID \d{2}\/\d{4}Z\.\.\.DISSIPATED/m;

/**
 * "27/0600Z" → ISO, using the advisory's own issue month/year; a day number
 * below the issue day is next month (an advisory on the 30th forecasting the
 * 1st and 2nd).
 */
export function advisoryTime(day: number, hhmm: string, issued: Date): string {
  const hh = Number(hhmm.slice(0, 2));
  const mm = Number(hhmm.slice(2, 4));
  let year = issued.getUTCFullYear();
  let month = issued.getUTCMonth();
  if (day < issued.getUTCDate() - 7) { month += 1; if (month > 11) { month = 0; year += 1; } }
  return new Date(Date.UTC(year, month, day, hh, mm)).toISOString();
}

function lon(v: string, hemi: string): number { return hemi === "E" ? Number(v) : -Number(v); }

/** The <pre> block of NHC's .shtml page, or the text as given. */
export function advisoryText(html: string): string {
  const m = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  const raw = m ? m[1] ?? "" : html;
  return raw.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\r/g, "");
}

export function parseForecastAdvisory(text: string, now = new Date()): ForecastAdvisory | null {
  const t = advisoryText(text);
  const im = t.match(ISSUED_RE);
  let issued: Date = now;
  if (im) {
    const mon = MONTHS[im[2] ?? ""];
    if (mon != null) issued = new Date(Date.UTC(Number(im[4]), mon, Number(im[3]), Number((im[1] ?? "0000").slice(0, 2)), Number((im[1] ?? "0000").slice(2, 4))));
  }
  const cm = t.match(CENTER_RE);
  const pm = t.match(PRESSURE_RE);
  const wm = t.match(WIND_RE);
  const points: AdvisoryPoint[] = [];
  for (const line of t.split("\n")) {
    const m = line.trim().match(POINT_RE);
    if (!m) continue;
    points.push({
      kind: m[1] === "OUTLOOK" ? "outlook" : "forecast",
      validAt: advisoryTime(Number(m[2]), m[3] ?? "0000", issued),
      lat: Number(m[4]),
      lon: lon(m[5] ?? "0", m[6] ?? "W"),
      note: m[7] ? m[7].trim() : null,
    });
  }
  if (!cm && !points.length) return null;
  return {
    issuedAt: im ? issued.toISOString() : null,
    centerLat: cm ? Number(cm[1]) : null,
    centerLon: cm ? lon(cm[2] ?? "0", cm[3] ?? "W") : null,
    centerAt: cm ? advisoryTime(Number(cm[4]), cm[5] ?? "0000", issued) : null,
    pressureMb: pm ? Number(pm[1]) : null,
    maxWindKt: wm ? Number(wm[1]) : null,
    points,
    dissipates: DISSIPATED_RE.test(t),
  };
}

/**
 * The storm's path for pinning: the centre now plus every forecast point
 * within `horizonH` hours (default five days — the whole advisory). A point
 * marked dissipated/remnant still counts: a remnant low over a port is weather.
 */
export function advisoryPath(adv: ForecastAdvisory, horizonH = 120, now = new Date()): PathPoint[] {
  const out: PathPoint[] = [];
  if (adv.centerLat != null && adv.centerLon != null) {
    out.push({ kind: "low", lat: adv.centerLat, lon: adv.centerLon, label: adv.pressureMb ? `${adv.pressureMb} mb` : "centre", reachNm: PATH_TROPICAL_NM });
  }
  const limit = now.getTime() + horizonH * 3_600_000;
  for (const p of adv.points) {
    if (Date.parse(p.validAt) > limit) continue;
    out.push({ kind: "forecast", lat: p.lat, lon: p.lon, label: `forecast ${p.validAt.slice(5, 16).replace("T", " ")}Z${p.note ? ` (${p.note})` : ""}`, reachNm: PATH_TROPICAL_NM });
  }
  return out;
}

/**
 * The points that decide which GROUNDS a system threatens: the 12–72 h
 * forecast, and only while it is still a tropical cyclone. A day-4 "post-
 * tropical remnant low" a thousand miles from the Caribbean put TD Fay back
 * on the Eastern Caribbean's list on 2026-09-26; a remnant still drives
 * pinning through the path (weather over a port is weather) but never makes a
 * system a threat to a cruising ground.
 */
export function reachPoints(adv: ForecastAdvisory): Array<{ lat: number; lon: number }> {
  return adv.points
    .filter((p) => p.kind === "forecast" && !p.note)
    .map((p) => ({ lat: p.lat, lon: p.lon }));
}

// ── Fetcher ─────────────────────────────────────────────────────────────────

const USER_AGENT = "stillafloatcruising.com storm-alerts (mark@stillafloatcruising.com)";

export async function fetchForecastAdvisory(url: string): Promise<ForecastAdvisory | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) { logger.warn({ url, status: r.status }, "nhc-forecast: non-200"); return null; }
    const adv = parseForecastAdvisory(await r.text());
    if (!adv) logger.warn({ url }, "nhc-forecast: no centre or forecast points in the advisory");
    return adv;
  } catch (err) {
    logger.warn({ url, err }, "nhc-forecast: fetch failed");
    return null;
  }
}
