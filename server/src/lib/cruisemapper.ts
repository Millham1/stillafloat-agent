/**
 * cruisemapper.ts — pure parsers for CruiseMapper ship pages and cruise.json.
 *
 * No network and no database here on purpose: every rule below is exercised by
 * cruisemapper.test.ts against real captured markup, because a parser that is
 * only ever proven against the live site is proven against nothing repeatable.
 *
 * Two facts about this source drive the whole design:
 *
 *  1. The SHIP PAGE schedule rows carry the year ("2026 Sep 20"); the per-sailing
 *     port tables do NOT ("23 Sep 07:00 - 17:00"). The year has to be carried in
 *     from the schedule row and rolled forward when the month wraps.
 *  2. Each port cell links to CruiseMapper's OWN port page,
 *     /ports/<slug>-port-<id>. That slug is clean; the visible text is not
 *     ("Nassau, Bahamas, New Providence Island"). Prefer the slug.
 */

import { matchDestination } from "./ports";
import { WORLD_PORT_SLUGS } from "./world-ports";

export const CRUISEMAPPER_BASE = "https://www.cruisemapper.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0 Safari/537.36";

const MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

/**
 * Rows CruiseMapper lists in the port table that are not places a ship calls.
 * Measured against the 2026-09-23 fleet pull, out of 28,032 rows: 536 "land
 * tour, train/bus travel", 418 "sea cruising", 220 "flight", plus 91
 * "coastal cruising", 36 "river cruising" and 27 "fjord cruising" — hence the
 * trailing-"cruising" rule rather than a list that keeps growing. They would
 * each fail the port matcher and vanish silently; naming them keeps the
 * per-sailing port count honest instead of quietly short.
 */
const NON_PORT = /^(land tour|at sea|transit\b|flight\b)|cruising\s*$/i;

export interface ScheduleRow {
  cruiseId: string;
  start: string;            // YYYY-MM-DD
  nights: number | null;
  summary: string;          // "12 nights, round-trip from Civitavecchia-Rome, Italy"
  fromPort: string | null;
}

export interface PortCall {
  date: string | null;      // YYYY-MM-DD
  times: string;            // "07:00 - 17:00" or "18:30"
  name: string;             // display text, cleaned
  portSlug: string | null;  // CruiseMapper's own slug — the reliable one
  portId: string | null;
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip the decoration CruiseMapper wraps around the first and last call. */
export function cleanPortName(raw: string): string {
  return text(raw)
    .replace(/^(Departing\s+from|Arriving\s+in)\s+/i, "")
    .replace(/\s*hotels\s*$/i, "")
    .replace(/^[\s,]+|[\s,]+$/g, "");
}

export function isNonPort(name: string): boolean {
  return NON_PORT.test(name.trim());
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Forward schedule of a ship page, in listed order. Rows without a real date are skipped. */
export function parseSchedule(html: string): ScheduleRow[] {
  const out: ScheduleRow[] = [];
  const seen = new Set<string>();
  const rowRe = /<tr[^>]*data-row="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  for (let m = rowRe.exec(html); m; m = rowRe.exec(html)) {
    const [, cruiseId, body] = m;
    if (!cruiseId || seen.has(cruiseId)) continue;
    const cells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1] ?? ""));
    if (cells.length < 2) continue;
    const d = /^(\d{4})\s+([A-Za-z]{3})\s+(\d{1,2})/.exec(cells[0] ?? "");
    const month = d ? MONTHS[d[2] ?? ""] : undefined;
    if (!d || !month) continue;
    seen.add(cruiseId);
    const nights = /^(\d+)\s+night/.exec(cells[1] ?? "");
    out.push({
      cruiseId,
      start: iso(Number(d[1]), month, Number(d[3])),
      nights: nights ? Number(nights[1]) : null,
      summary: cells[1] ?? "",
      fromPort: cells[2] || null,
    });
  }
  return out;
}

/**
 * Ports of one sailing, in call order.
 *
 * `startIso` supplies the year the table omits. A month number lower than the
 * previous row means the sailing crossed New Year (30 Dec -> 02 Jan), so the
 * year advances — without this a Christmas cruise lands eleven months in the past.
 */
export function parsePortTable(html: string, startIso: string): PortCall[] {
  let year = Number(startIso.slice(0, 4));
  let prevMonth = 0;
  const out: PortCall[] = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const body = row[1] ?? "";
    const cells = [...body.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1] ?? "");
    if (cells.length < 2) continue;
    const when = text(cells[0] ?? "");
    if (!when || /^date\b/i.test(when)) continue;
    const cell = cells.slice(1).find((c) => cleanPortName(c)) ?? "";
    const name = cleanPortName(cell);
    if (!name) continue;

    const d = /^(\d{1,2})\s+([A-Za-z]{3})\s*(.*)$/.exec(when);
    const month = d ? MONTHS[d[2] ?? ""] : undefined;
    if (month) {
      if (prevMonth && month < prevMonth) year += 1;
      prevMonth = month;
    }
    const link = /\/ports\/([a-z0-9-]+?)-port-(\d+)/i.exec(cell);
    out.push({
      date: d && month ? iso(year, month, Number(d[1])) : null,
      times: d ? (d[3] ?? "").trim() : when,
      name,
      portSlug: link ? (link[1] ?? null) : null,
      portId: link ? (link[2] ?? null) : null,
    });
  }
  return out;
}

/**
 * The MMSI and IMO the page prints for itself.
 *
 * This is the only trustworthy identity on a CruiseMapper page: the slug in the
 * URL is ignored by their router, so /ships/anything-551 serves ship 551 and a
 * wrong id fails silently with a 200. Callers compare this against the registry
 * before trusting the itinerary.
 *
 * Note the MMSI here can be STALE — CruiseMapper still prints Carnival Legend's
 * old Maltese 229857000 while she transmits Bahamian 311001094 — so IMO, which
 * never changes, is the one to prefer.
 */
export function pageIdentity(html: string): { mmsi: string | null; imo: string | null } {
  const mmsi = /MMSI\s*(\d{9})/.exec(html);
  const imo = /imo=(\d{7})/.exec(html);
  return { mmsi: mmsi ? (mmsi[1] ?? null) : null, imo: imo ? (imo[1] ?? null) : null };
}

/**
 * Resolve one call to a stable port key.
 *
 * Curated ports first, via matchDestination() — the one matcher the rest of the
 * system uses, so an itinerary and an AIS destination always agree about Nassau.
 * Anything it does not know falls back to CruiseMapper's own catalogue, which
 * covers the other 776 ports the fleet visits. Without that, a Mediterranean
 * sailing stored two ports out of seven.
 *
 * ⛔ The fallback is deliberately NOT wired into matchDestination itself.
 * ship-tracker reads every AIS destination through that function, and widening
 * it would change position tracking — which is working and is not what this
 * change is for. The extra vocabulary stays on the itinerary side only.
 *
 * No coordinates: the key is all that is compared. Port-call detection keeps
 * using the measured berths in ports.ts.
 */
export function resolvePort(call: PortCall) {
  const curated = matchDestination(call.name)
    ?? (call.portSlug ? matchDestination(call.portSlug.replace(/-/g, " ")) : null);
  return {
    name: call.name,
    slug: curated?.slug ?? WORLD_PORT_SLUGS.get(call.name) ?? call.portSlug ?? null,
    date: call.date,
    ordered: true,        // unlike the Widgety archive, these ARE in call order
  };
}

/**
 * Fetch a CruiseMapper page or JSON endpoint.
 *
 * cruise.json answers 403 to a bare request — it wants the session cookie the
 * ship page sets, plus that page as Referer. Node's fetch keeps no cookie jar,
 * so the caller carries the header through by hand: fetch the ship page first,
 * then pass its `cookie` to the JSON call.
 */
export async function fetchCruiseMapper(
  url: string,
  opts: { referer?: string; cookie?: string; xhr?: boolean } = {},
): Promise<{ body: string; cookie: string }> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (opts.referer) headers["Referer"] = opts.referer;
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  if (opts.xhr) {
    headers["X-Requested-With"] = "XMLHttpRequest";
    headers["Accept"] = "application/json, text/javascript, */*; q=0.01";
  }
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return { body: await res.text(), cookie: setCookie.map((c) => c.split(";")[0]).join("; ") };
}
