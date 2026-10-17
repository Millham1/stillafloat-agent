// group-journey-facts.ts — what the journey knows about one traveler, read from the group file and nothing else.
//
// PURE: no I/O. Everything here takes rows already read from the file (groups, group_cabins, group_travelers,
// group_payments, group_travel, group_checklist, group_signatures, group_messages) and returns plain values.
//
// THE RULE (Mark 2026-10-03, again 2026-10-16): every number, date, price, port and ship fact in a client email
// comes from the group file. A helper here returns null / [] when the file does not hold the value, and the section
// that needed it is left out — it is never printed blank and never guessed.

import { BUSINESS } from "./group-secure";
import { DOC_SPECS, packetFor } from "./group-documents";
import { displayName, formatDate, portDisplayName } from "./group-marketing";
import { resolvePortName } from "./port-resolve";
import { WEATHER_DESC } from "./weather-forecast";
import { WEATHER_DESC_ES, strings, type Lang, type MissingItem } from "./group-journey-strings";

export type Row = Record<string, any>;

// ── What the engine reads ─────────────────────────────────────────────────────

export interface JourneyInput {
  group: Row;
  cabins: Row[];
  travelers: Row[];
  payments: Row[];
  travel: Row[];
  checklist: Row[];
  /** group_signatures: traveler_id, doc_key, signer_role, signed_at (never the answers). */
  signatures: Row[];
  /** group_messages: template, traveler_id, dedupe_key, status, sent_at, meta. */
  messages: Row[];
}

export interface ForecastDay { day: string; high: number; low: number; code: number }
/** Forecasts by place key (the port's slug). `shiftDays` re-dates a real forecast onto a sailing that is still far off (previews only). */
export interface WeatherBundle { places: Record<string, ForecastDay[]>; shiftDays: number; sample: boolean }
export interface VideoPick { id: string; title: string; url: string; views: number | null; inEnglish: boolean }
export interface StormNote { name: string | null; classification: string | null; headline: string | null }

/** Data that comes from outside the file (the ship tables, the forecast, the channel scan) and is only fetched when a section needs it. */
export interface Extras {
  rating?: Row | null;
  shipInfo?: Row | null;
  storm?: StormNote | null;
  weather?: WeatherBundle | null;
  videos?: ScanVideo[];
  /** Change notices (group-level group_messages rows) for the cruise page. */
  notices?: Row[];
}

export interface Ctx {
  input: JourneyInput;
  group: Row;
  traveler: Row;
  cabin: Row | null;
  mates: Row[];
  lang: Lang;
  now: Date;
  /** YYYY-MM-DD in the business's time zone. */
  today: string;
  daysToSail: number | null;
  site: string;
  hubUrl: string;
  formsUrl: string;
  extras: Extras;
  videoSources: string[];
}

export interface SectionItem { text: string; url?: string }
export interface ChecklistEntry { id: string; title: string; detail: string | null; url: string | null; due: string | null; done: boolean }
export interface Section {
  key: string;
  title: string;
  lines: string[];
  items?: SectionItem[];
  table?: { head: string[]; rows: string[][] };
  links?: Array<{ label: string; url: string }>;
  /** Cruise page only. */
  checklist?: ChecklistEntry[];
  form?: "details";
  tone?: "notice";
}

// ── Dates ─────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const YMD = /^(\d{4})-(\d{2})-(\d{2})/;

export function ymd(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = YMD.exec(v);
  if (!m) return null;
  const d = new Date(`${m[0]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== m[0] ? null : m[0];
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The calendar date in the business's time zone (the daily tick and the countdown both mean "today there"). */
export function localToday(now: Date, tz = "America/New_York"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export const fmtDate = (iso: unknown, lang: Lang): string => formatDate(ymd(iso), lang) ?? "";

/** "Sat, Mar 5" / "sáb, 5 mar" */
export function fmtShortDay(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(strings(lang).locale, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${iso}T12:00:00Z`));
}

/** "14:30" → "2:30 PM" (English) / "14:30" (Spanish). "" when it is not a time. */
export function fmtTime(t: unknown, lang: Lang): string {
  const m = typeof t === "string" ? /^(\d{1,2}):(\d{2})/.exec(t.trim()) : null;
  if (!m) return "";
  const h = Number(m[1]);
  const min = m[2]!;
  if (h > 23 || Number(min) > 59) return "";
  if (lang === "es") return `${String(h).padStart(2, "0")}:${min}`;
  return `${h % 12 === 0 ? 12 : h % 12}:${min} ${h >= 12 ? "PM" : "AM"}`;
}

export function fmtMoney(n: unknown): string {
  const v = Number(n);
  if (n === null || n === undefined || n === "" || !Number.isFinite(v) || v <= 0) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }).format(v);
}

// ── Text that came from the file ─────────────────────────────────────────────

/** A line of Mark's or a contract's text, made safe to print: one line, no template tokens, bounded. */
export function plain(v: unknown, max = 300): string {
  return String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export const safeUrl = (u: unknown): string | null => (typeof u === "string" && /^https?:\/\/[^\s<>"]+$/i.test(u.trim()) ? u.trim() : null);

export const firstName = (t: Row | null | undefined): string => plain(t?.first_name, 60);
const fullName = (t: Row | null | undefined): string => [t?.first_name, t?.last_name].map((x) => plain(x, 60)).filter(Boolean).join(" ");
export const personName = fullName;

// ── Who is on the journey ─────────────────────────────────────────────────────

/** A cabin the journey writes to: booked, or carrying a booking number, and not given back. */
export function cabinIsBooked(c: Row | null | undefined): boolean {
  if (!c) return false;
  if (c.status === "released" || c.status === "cancelled") return false;
  return c.status === "booked" || !!plain(c.booking_number);
}

export function emailOf(t: Row | null | undefined): string | null {
  const e = plain(t?.email, 200).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}

export const langOf = (t: Row | null | undefined): Lang => (t?.lang === "es" ? "es" : "en");

export function cabinOf(input: JourneyInput, t: Row): Row | null {
  return t.cabin_id ? input.cabins.find((c) => c.id === t.cabin_id) ?? null : null;
}

export function matesOf(input: JourneyInput, t: Row): Row[] {
  return t.cabin_id ? input.travelers.filter((x) => x.cabin_id === t.cabin_id && x.id !== t.id) : [];
}

// ── Payments ──────────────────────────────────────────────────────────────────

const PAY_ORDER: Record<string, number> = { deposit: 0, final: 1, other: 2 };

/** The payment rows of the traveler's cabin, deposit first, then by date. */
export function cabinPayments(input: JourneyInput, cabin: Row | null): Row[] {
  if (!cabin) return [];
  return input.payments
    .filter((p) => p.cabin_id === cabin.id)
    .sort((a, b) => (PAY_ORDER[a.kind] ?? 9) - (PAY_ORDER[b.kind] ?? 9) || String(a.due_date ?? "9999").localeCompare(String(b.due_date ?? "9999")));
}

/** Who is told about a cabin's payment: its lead with an email, else the first traveler with one. */
export function payee(input: JourneyInput, cabin: Row): Row | null {
  const here = input.travelers.filter((t) => t.cabin_id === cabin.id && emailOf(t));
  return here.find((t) => t.is_lead) ?? here[0] ?? null;
}

// ── Paperwork ─────────────────────────────────────────────────────────────────

export interface PaperworkState { required: string[]; signed: string[]; pending: string[]; signedRows: Row[]; title(key: string): string }

export function paperworkState(input: JourneyInput, traveler: Row, cabin: Row | null): PaperworkState {
  const required = packetFor({ group: input.group, cabin, traveler });
  const mine = input.signatures.filter((s) => s.traveler_id === traveler.id);
  const signedKeys = new Set(mine.map((s) => s.doc_key));
  const signed = required.filter((k) => signedKeys.has(k));
  return {
    required, signed, pending: required.filter((k) => !signedKeys.has(k)),
    signedRows: required.filter((k) => signedKeys.has(k)).map((k) => mine.find((s) => s.doc_key === k)!),
    title: (key) => DOC_SPECS[key]?.title ?? key,
  };
}

// ── What the traveler has told us, and what the file holds ───────────────────

export const journeyAnswers = (t: Row | null | undefined): Row => {
  const j = t?.form_data?.journey;
  return j && typeof j === "object" && !Array.isArray(j) ? j : {};
};

/** The flight / hotel / transfer rows that belong to this traveler or this cabin. The group's own offer (no traveler, no cabin) is not a booking. */
export function travelRows(input: JourneyInput, traveler: Row, cabin: Row | null): Row[] {
  return input.travel.filter((r) => r.traveler_id === traveler.id || (!r.traveler_id && cabin && r.cabin_id === cabin.id));
}

export interface TravelState { flightIn: boolean; flightOut: boolean; rows: Row[]; told: Row }

export function travelState(input: JourneyInput, traveler: Row, cabin: Row | null): TravelState {
  const rows = travelRows(input, traveler, cabin);
  const told = journeyAnswers(traveler);
  const own = told["getting_there"] === "driving" || told["getting_there"] === "other";
  return {
    rows, told,
    flightIn: own || rows.some((r) => r.kind === "flight" && r.direction !== "post") || !!plain(told["flight_in_flight"]),
    flightOut: own || rows.some((r) => r.kind === "flight" && r.direction === "post") || !!plain(told["flight_out_flight"]),
  };
}

/** What a traveler still owes us. Hotels and transfers are never "missing": not everyone has them. */
export function missingItems(input: JourneyInput, traveler: Row, cabin: Row | null): MissingItem[] {
  const out: MissingItem[] = [];
  const pw = paperworkState(input, traveler, cabin);
  if (pw.pending.length) out.push({ key: "paperwork", n: pw.pending.length });
  const tv = travelState(input, traveler, cabin);
  if (!tv.flightIn) out.push({ key: "travel-in" });
  if (!tv.flightOut) out.push({ key: "travel-out" });
  if (!plain(traveler.emergency_name) || !plain(traveler.emergency_phone)) out.push({ key: "emergency" });
  return out;
}

// ── Checklist ─────────────────────────────────────────────────────────────────

/** The client-facing rows that apply to this traveler: the group's own, and their cabin's. */
export function clientChecklist(input: JourneyInput, traveler: Row, cabin: Row | null): Row[] {
  return input.checklist
    .filter((r) => r.audience === "client" && (!r.cabin_id || (cabin && r.cabin_id === cabin.id)))
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.due_date ?? "9999").localeCompare(String(b.due_date ?? "9999")) || String(a.id).localeCompare(String(b.id)));
}

/** Done for this traveler: ticked by them, or marked done on their cabin's row. */
export function checklistDone(row: Row, traveler: Row): boolean {
  const own = (journeyAnswers(traveler)["checklist_done"] ?? {}) as Row;
  return !!own[row.id] || (!!row.cabin_id && !!row.done_at);
}

export function checklistEntry(row: Row, traveler: Row): ChecklistEntry {
  return {
    id: String(row.id), title: plain(row.title, 200), detail: plain(row.detail, 400) || null,
    url: safeUrl(row.link_url), due: ymd(row.due_date), done: checklistDone(row, traveler),
  };
}

// ── The cruise line's dates (groups.terms.deadlines) ─────────────────────────

export interface TermDeadline { date: string; text: string; daysBefore: number }

export function termsDeadlines(group: Row): TermDeadline[] {
  const list = Array.isArray(group.terms?.deadlines) ? group.terms.deadlines : [];
  const out: TermDeadline[] = [];
  for (const d of list) {
    const date = ymd(d?.date);
    const text = plain(d?.text, 280).replace(/^…\s*/, "");
    if (!date || !text) continue;
    out.push({ date, text, daysBefore: Number(d?.days_before) || 0 });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ── The forecast ──────────────────────────────────────────────────────────────

export interface WeatherStop { date: string; place: string; key: string; slug: string; name: string; lat: number; lon: number }

const SEA_DAY = /^(at sea|sea day|en el mar|d[ií]a de mar|navegaci[oó]n|cruising|scenic cruising)/i;

/** Every stop of the sailing that has a calendar date and a position we can look up: the embark port on sail day, then the itinerary. */
export function sailingStops(group: Row): Array<{ date: string; place: string; resolved: { slug: string; name: string; lat: number; lon: number } }> {
  const sail = ymd(group.sail_date);
  const raw: Array<{ date: string | null; port: string }> = [];
  if (sail && plain(group.embark_port)) raw.push({ date: sail, port: plain(group.embark_port) });
  for (const s of Array.isArray(group.itinerary) ? group.itinerary : []) {
    const port = plain(s?.port, 120);
    if (!port || SEA_DAY.test(port)) continue;
    const date = ymd(s?.date) ?? (sail && Number.isInteger(s?.day) && s.day >= 1 ? addDays(sail, s.day - 1) : null);
    raw.push({ date, port });
  }
  const out: Array<{ date: string; place: string; resolved: { slug: string; name: string; lat: number; lon: number } }> = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r.date) continue;
    const place = portDisplayName(r.port) ?? r.port;
    const resolved = resolvePortName(place) ?? resolvePortName(r.port);
    if (!resolved) continue;
    const k = `${r.date}|${resolved.slug}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ date: r.date, place: place.split(",")[0]!.trim(), resolved });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** The stops whose forecast the horizon covers (Open-Meteo gives today plus nine days). */
export function stopsInHorizon(group: Row, today: string, horizonDays = 10): WeatherStop[] {
  return sailingStops(group)
    .filter((s) => { const d = dayDiff(today, s.date); return d >= 0 && d < horizonDays; })
    .map((s) => ({ date: s.date, place: s.place, key: s.resolved.slug, slug: s.resolved.slug, name: s.resolved.name, lat: s.resolved.lat, lon: s.resolved.lon }));
}

export const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

export const skyText = (code: number, lang: Lang): string => (lang === "es" ? WEATHER_DESC_ES : WEATHER_DESC)[code] ?? (lang === "es" ? "parcialmente nublado" : "partly cloudy");

export interface WeatherTable { rows: string[][]; rain: boolean; hot: boolean; cool: boolean; sample: boolean }

/** The forecast table for the stops inside the horizon. null when the file or the forecast gives nothing to show. */
export function weatherTable(ctx: Ctx): WeatherTable | null {
  const w = ctx.extras.weather;
  if (!w) return null;
  const rows: string[][] = [];
  let rain = false, hot = false, cool = false;
  for (const stop of stopsInHorizon(ctx.group, ctx.today)) {
    const realDay = addDays(stop.date, -w.shiftDays);
    const day = w.places[stop.key]?.find((d) => d.day === realDay);
    if (!day) continue;
    rows.push([fmtShortDay(stop.date, ctx.lang), stop.place, strings(ctx.lang).s.weatherTemp({ high: day.high, low: day.low }), skyText(day.code, ctx.lang)]);
    if (RAIN_CODES.has(day.code)) rain = true;
    if (day.high >= 85) hot = true;
    if (day.low <= 55) cool = true;
  }
  return rows.length ? { rows, rain, hot, cool, sample: w.sample } : null;
}

// ── Mark's videos (his own channel only, for now) ────────────────────────────

export interface ScanVideo { id: string; title: string; published?: string; views?: number; isShort?: boolean; url?: string }

export type VideoTopic = "insurance" | "cabin" | "seaday" | "packing" | "embark";

const TOPICS: Record<VideoTopic, { en: RegExp; es: RegExp }> = {
  insurance: { en: /insurance/i, es: /seguro/i },
  cabin: { en: /\bcabins?\b|stateroom/i, es: /cabina|camarote/i },
  seaday: { en: /sea days?/i, es: /d[ií]as? (?:de|en el) mar/i },
  packing: { en: /\bpack(?:ing)?\b|what to wear|wardrobe/i, es: /empac|maleta|equipaje|qu[eé] (?:llevar|ponerse)/i },
  embark: { en: /embark|boarding|first[- ](?:time )?cruise|muster/i, es: /embarque|abordar|primer crucero|simulacro/i },
};

/** The channel's Spanish uploads carry accents or inverted marks in the title (routes/youtube.ts uses the same test). */
export const isSpanishTitle = (t: string): boolean => /[¡¿áéíóúüñ]/i.test(t);

/**
 * Up to `max` videos about `topic` from the channel scan. Spanish travelers get the Spanish uploads; if none match, the
 * English ones, marked as such. Only Mark's own channel exists today: `sources` is the setting that will let other
 * channels in later, and anything but "own" is ignored until a second source is built.
 * TODO(group-journey): selected other channels (videoSources: ["own", "<channel id>"]) — Mark's 2026-10-16 ruling is own channel only for now.
 */
export function pickVideos(scan: readonly ScanVideo[] | undefined, topic: VideoTopic, lang: Lang, sources: readonly string[] = ["own"], max = 2): VideoPick[] {
  if (!scan?.length || !sources.includes("own")) return [];
  const rank = (a: ScanVideo, b: ScanVideo) => Number(!!a.isShort) - Number(!!b.isShort) || (b.views ?? 0) - (a.views ?? 0) || String(b.published ?? "").localeCompare(String(a.published ?? ""));
  const usable = scan.filter((v) => v && typeof v.id === "string" && /^[\w-]{11}$/.test(v.id) && typeof v.title === "string" && v.title.trim());
  const pick = (spanish: boolean, re: RegExp) => usable.filter((v) => isSpanishTitle(v.title) === spanish && re.test(v.title)).sort(rank);
  let chosen: ScanVideo[]; let inEnglish = false;
  if (lang === "es") {
    chosen = pick(true, TOPICS[topic].es);
    if (!chosen.length) { chosen = pick(false, TOPICS[topic].en); inEnglish = chosen.length > 0; }
  } else chosen = pick(false, TOPICS[topic].en);
  return chosen.slice(0, max).map((v) => ({ id: v.id, title: plain(v.title, 140), url: `https://www.youtube.com/watch?v=${v.id}`, views: typeof v.views === "number" ? v.views : null, inEnglish }));
}

// ── Cruise-page link details (what the hub form accepts) ─────────────────────

export const HUB_SITE = (env: Record<string, string | undefined> = process.env): string => (env["PUBLIC_URL"] || BUSINESS.site).replace(/\/$/, "");

export function ctxFor(input: JourneyInput, travelerId: string, o: {
  now: Date; tz?: string; site?: string; token?: string; extras?: Extras; lang?: Lang; videoSources?: string[];
}): Ctx | null {
  const traveler = input.travelers.find((t) => t.id === travelerId);
  if (!traveler) return null;
  const cabin = cabinOf(input, traveler);
  const today = localToday(o.now, o.tz);
  const sail = ymd(input.group.sail_date);
  const site = (o.site ?? HUB_SITE()).replace(/\/$/, "");
  const token = o.token ?? "";
  return {
    input, group: input.group, traveler, cabin, mates: matesOf(input, traveler),
    lang: o.lang ?? langOf(traveler), now: o.now, today, daysToSail: sail ? dayDiff(today, sail) : null,
    site, hubUrl: `${site}/my-cruise.html?t=${token}`, formsUrl: `${site}/forms.html?t=${token}`,
    extras: o.extras ?? {}, videoSources: o.videoSources ?? ["own"],
  };
}

export { displayName, portDisplayName };
