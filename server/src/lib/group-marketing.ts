// group-marketing.ts — the marketing layer of a group file (migration 0045).
//
// The split that matters (Mark's standing rules: no fabrication, never hype,
// explain and never promise):
//   FACTS  — dates, ports, prices, deposits, deadlines, amenities, the Conga
//            Line score. Built here from the group file by code. Never written,
//            rounded or restated by a model, and never stored inside the copy.
//   WORDS  — headline, the why, who it suits, the invitation email. Written from
//            Mark's interview answers + the facts, then checked by validateCopy:
//            any number that is not one of the file's own numbers, any hype
//            phrase, any promise, fails the copy before Mark ever sees it.
// The public page shows facts from the file and words from the approved copy,
// so a price change on the file changes the page and can never contradict it.
//
// Everything in this file is pure (no I/O) and unit-tested.

import { BUSINESS } from "./group-secure";

export type Lang = "en" | "es";
type Row = Record<string, any>;

// ── Interview ─────────────────────────────────────────────────────────────────

export interface InterviewQuestion {
  key: string;
  label: string;
  hint?: string;
  type: "text" | "long" | "yesno" | "choice";
  choices?: Array<{ value: string; label: string }>;
  fallback?: string | boolean;
  /** The copy is not written until this is answered (the dashboard marks it and the write routes refuse without it). */
  required?: boolean;
}

/** What the contract cannot tell us. Short on purpose — Mark fills this in once per group. */
export const INTERVIEW: InterviewQuestion[] = [
  // Mark 2026-10-11: no group creative is drafted without HIS pitch, his picture and a piece he likes. The copy is
  // built around the pitch word for word (validateCopy / validateCampaign check every sentence is still there).
  { key: "pitch", type: "long", required: true, label: "Your pitch, as you would say it to them", hint: "What the trip is, who it is for, why come, what they get, what to do next. Your words — the copy is built around them and nothing is cut." },
  { key: "picture", type: "long", label: "What should the reader see?", hint: "The moment, not the ship. One or two sentences." },
  { key: "occasion_line", type: "text", label: "The occasion, in the group's own words", hint: "One line. We add the wink." },
  { key: "reference", type: "text", label: "A piece you like", hint: "A link or a name, so the piece matches your taste." },
  { key: "audience", type: "text", required: true, label: "Who is this group?", hint: "For example: members of the Post and their families, or Abuela's children, grandchildren and close friends." },
  { key: "occasion", type: "text", required: true, label: "What is the occasion?", hint: "A reunion, a milestone birthday, an annual trip. One line." },
  { key: "why_sailing", type: "long", required: true, label: "Why this ship and this sailing?", hint: "Your honest reasons, in your own words. This is the heart of the page." },
  { key: "who_fits", type: "long", label: "Who is this trip right for, and who should think twice?", hint: "Mobility, budget, first-timers, kids. The honest version builds trust." },
  { key: "organizer_quote", type: "long", label: "A line from the organizer (optional)", hint: "Their words, as they said them. Leave blank if you have none." },
  { key: "extras", type: "long", label: "Anything else planned around the cruise? (optional)", hint: "A group dinner, a bus to the port, a hotel the night before." },
  { key: "tone", type: "choice", label: "Tone", fallback: "warm-humor",
    choices: [
      { value: "warm-humor", label: "Warm, with a little humor (the usual)" },
      { value: "warm", label: "Warm and straightforward" },
      { value: "formal", label: "Respectful and formal" },
    ] },
  { key: "show_prices", type: "yesno", label: "Show prices on the page?", fallback: true },
  { key: "show_rating", type: "yesno", label: "Show the ship's Conga Line score and note?", fallback: true },
];

/** The longest answer kept. The pitch is never cut to fit: the answers route refuses a longer one. */
export const ANSWER_MAX = 2000;

export function normalizeAnswers(raw: unknown): Record<string, string | boolean> {
  const src = (raw && typeof raw === "object" ? raw : {}) as Row;
  const out: Record<string, string | boolean> = {};
  for (const q of INTERVIEW) {
    const v = src[q.key];
    if (q.type === "yesno") out[q.key] = typeof v === "boolean" ? v : (q.fallback as boolean) ?? false;
    else if (q.type === "choice") out[q.key] = q.choices!.some((c) => c.value === v) ? (v as string) : ((q.fallback as string) ?? q.choices![0]!.value);
    else out[q.key] = typeof v === "string" ? v.trim().slice(0, ANSWER_MAX) : "";
  }
  return out;
}

/** The interview is ready to write from once every required answer exists (the pitch first). */
export function missingAnswers(answers: Record<string, string | boolean>): string[] {
  return INTERVIEW.filter((q) => q.required && !answers[q.key]).map((q) => q.key);
}

/** What the write routes say when Mark's pitch is empty: nothing is drafted without it. */
export const PITCH_FIRST = "Write Mark's pitch first (interview question 1) — the copy is built around it.";

/** null when the pitch exists; otherwise the plain message the write routes refuse with. */
export function pitchGate(answers: Record<string, string | boolean>): string | null {
  return typeof answers["pitch"] === "string" && answers["pitch"].trim() ? null : PITCH_FIRST;
}

// ── Names ─────────────────────────────────────────────────────────────────────

const KEEP_UPPER = new Set(["MSC", "NCL", "RCI", "USA", "US", "UK", "II", "III", "IV"]);
const SMALL_WORDS = new Set(["OF", "THE", "AND", "DE", "DEL", "LA", "AT"]);

/** Contracts print names in capitals ("MSC SEASIDE"). Show them the way people write them. */
export function displayName(name: string | null | undefined): string {
  const s = (name ?? "").trim();
  if (!s) return "";
  if (s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s;
  return s
    .split(/(\s+|-)/)
    .map((w, i) => {
      if (/^\s+$|^-$/.test(w) || KEEP_UPPER.has(w)) return w;
      if (i > 0 && SMALL_WORDS.has(w)) return w.toLowerCase();
      return w.charAt(0) + w.slice(1).toLowerCase();
    })
    .join("");
}

/** Candidate cabin_ships.slug for a ship name; the caller checks it exists. */
export function shipSlugCandidate(name: string | null | undefined): string {
  return displayName(name)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function newShareCode(random: (n: number) => Uint8Array): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes (0/o, 1/l/i)
  return Array.from(random(10), (b) => alphabet[b % alphabet.length]).join("");
}

// ── Facts ─────────────────────────────────────────────────────────────────────

const LOCALE: Record<Lang, string> = { en: "en-US", es: "es-419" };

export function formatDate(iso: string | null | undefined, lang: Lang, withWeekday = false): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const d = new Date(iso.slice(0, 10) + "T12:00:00Z");
  return new Intl.DateTimeFormat(LOCALE[lang], {
    timeZone: "UTC", year: "numeric", month: "long", day: "numeric", ...(withWeekday ? { weekday: "long" } : {}),
  }).format(d);
}

export function formatMoney(n: number | null | undefined): string | null {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return null;
  const v = Number(n);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }).format(v);
}

function formatTime(t: string | null | undefined, lang: Lang): string | null {
  const m = typeof t === "string" ? t.match(/^(\d{1,2}):(\d{2})/) : null;
  if (!m) return null;
  const h = +m[1]!, min = m[2]!;
  if (lang === "es") return `${String(h).padStart(2, "0")}:${min}`;
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 === 0 ? 12 : h % 12}:${min} ${ampm}`;
}

export interface CabinOffer {
  category: string;
  code: string | null;
  perPerson: number | null;        // cabin total / 2
  perPersonText: string | null;
  depositPerPerson: number | null;
  depositPerPersonText: string | null;
  available: number;               // held or offered, i.e. not yet booked
  total: number;
}

export interface ItineraryLine {
  day: number | null;
  dateText: string | null;
  port: string;
  timesText: string | null;
  seaDay: boolean;
}

export interface GroupFacts {
  lang: Lang;
  business: { legalName: string; tradeName: string; agentName: string; email: string; site: string; host: string };
  groupName: string;
  organizerName: string | null;
  line: string;
  ship: string;
  shipSlug: string | null;
  sailDate: string | null;
  sailDateText: string | null;
  returnDateText: string | null;
  nights: number | null;
  embarkPort: string | null;
  ports: string[];                 // distinct ports of call, in order, excluding sea days and the home port
  itinerary: ItineraryLine[];
  /** The ORGANIZER's side (amenity points …): dashboard only, never public. */
  amenities: string[];
  /** The GUEST's perks printed on the quote (drinks package, Wi-Fi …): the page, the poster, every piece. */
  perks: string[];
  cabins: CabinOffer[];
  cabinsAvailable: number;
  cabinsTotal: number;
  fromPerPersonText: string | null;
  depositDueText: string | null;
  finalPaymentText: string | null;
  bookByText: string | null;       // the earlier of deposit deadline and recall date
  rating: { score: number; scoreText: string; comment: string | null; saltyTake: string | null } | null;
  /** Air, hotel before the cruise, transfers — the group's offer (Mark 2026-10-10). */
  travel: TravelLine[];
  /** Every number the copy is allowed to mention. */
  allowedNumbers: string[];
}

export interface TravelLine { kind: "flight" | "hotel" | "transfer"; text: string; included: boolean; priceText: string | null }

/** Plain lines for the group's air / hotel / transfer offer, from group_travel rows with no traveler or cabin. */
export function travelLines(rows: readonly Row[], lang: Lang): TravelLine[] {
  const es = lang === "es";
  const out: TravelLine[] = [];
  for (const r of rows) {
    if (r.traveler_id || r.cabin_id) continue;
    const kind = r.kind as TravelLine["kind"];
    if (!["flight", "hotel", "transfer"].includes(kind)) continue;
    const price = typeof r.price_per_person === "number" ? r.price_per_person : (typeof r.price_per_person === "string" && r.price_per_person !== "" ? Number(r.price_per_person) : null);
    const priceText = price !== null && Number.isFinite(price) ? formatMoney(price) : null;
    const included = r.included === true;
    const tail = included ? (es ? "incluido en el precio del crucero" : "included in the cruise price") : priceText ? (es ? `${priceText} por persona` : `${priceText} per person`) : (es ? "disponible, precio a confirmar" : "available, price on request");
    let text: string;
    if (kind === "flight") text = (es ? "Vuelos" : "Airfare") + (r.from_place ? ` ${es ? "desde" : "from"} ${r.from_place}` : "") + (r.provider ? ` (${r.provider})` : "") + `: ${tail}`;
    else if (kind === "hotel") text = (es ? "Hotel la noche anterior" : "Hotel the night before") + (r.from_place ? ` ${es ? "en" : "in"} ${r.from_place}` : "") + (r.provider ? ` (${r.provider}${r.reference ? `, ${r.reference}` : ""})` : r.reference ? ` (${r.reference})` : "") + `: ${tail}`;
    else text = (es ? "Traslado" : "Transfer") + (r.from_place && r.to_place ? ` ${r.from_place} → ${r.to_place}` : "") + (r.provider ? ` (${r.provider})` : "") + `: ${tail}`;
    out.push({ kind, text, included, priceText });
  }
  return out;
}

const SEA_DAY = /^(at sea|sea day|en el mar|d[ií]a de mar|navegaci[oó]n)/i;
const LIVE = new Set(["held", "offered", "booked"]);

/**
 * A cruise line's quote lists group perks in its own shorthand — MSC prints "3 AMENITY POINTS", meaning
 * the group earns points the organizer spends on perks (onboard credit, a party, photos) before final
 * payment. A client reading the group page needs that in plain words (Mark 2026-10-07: the raw line
 * on the page "needs wording"). Anything already in plain words passes through untouched.
 */
export function humanizeAmenity(raw: string, lang: Lang): string {
  const m = /^\s*(\d+)\s+amenity\s+points?\s*$/i.exec(raw);
  if (!m) return raw.trim();
  const n = Number(m[1]);
  return lang === "es"
    ? `${n} ${n === 1 ? "punto" : "puntos"} de beneficios de la naviera: ventajas para el grupo (como crédito a bordo) que Mark elige antes del pago final`
    : `${n} amenity ${n === 1 ? "point" : "points"} from the cruise line: group perks (such as onboard credit) that Mark picks for the group before final payment`;
}

/** Cruise-line quotes name the home port by its code; the page says the city. Unknown codes pass through. */
const PORT_CODES: Record<string, string> = {
  MIA: "Miami, Florida", FLL: "Fort Lauderdale, Florida", PCV: "Port Canaveral, Florida", PCN: "Port Canaveral, Florida", CAN: "Port Canaveral, Florida",
  GAL: "Galveston, Texas", TPA: "Tampa, Florida", NYC: "New York", NY: "New York", BOS: "Boston, Massachusetts", BAL: "Baltimore, Maryland",
  NOL: "New Orleans, Louisiana", MSY: "New Orleans, Louisiana", LAX: "Los Angeles, California", SEA: "Seattle, Washington", SJU: "San Juan, Puerto Rico",
  SFO: "San Francisco, California", SAN: "San Diego, California", JAX: "Jacksonville, Florida", CHS: "Charleston, South Carolina", MOB: "Mobile, Alabama",
};
export function portDisplayName(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  return PORT_CODES[s.toUpperCase()] ?? s;
}

export function buildFacts(
  file: { group: Row; cabins: Row[]; travel?: Row[] },
  rating: Row | null,
  lang: Lang,
): GroupFacts {
  const travel = travelLines(file.travel ?? [], lang);
  const g = file.group;
  const ship = displayName(g.ship_name);
  const line = displayName(g.cruise_line);

  const itinerary: ItineraryLine[] = (Array.isArray(g.itinerary) ? g.itinerary : []).map((s: Row) => {
    const port = String(s.port ?? "").trim();
    const arrive = formatTime(s.arrive, lang);
    const depart = formatTime(s.depart, lang);
    const times = arrive && depart ? `${arrive} – ${depart}`
      : arrive ? (lang === "es" ? `llegada ${arrive}` : `arrive ${arrive}`)
      : depart ? (lang === "es" ? `salida ${depart}` : `depart ${depart}`) : null;
    return { day: Number.isInteger(s.day) ? s.day : null, dateText: formatDate(s.date, lang), port, timesText: times, seaDay: SEA_DAY.test(port) };
  }).filter((s: ItineraryLine) => s.port);

  // A quote often prints the home port as a code ("MIA"); the page and poster say the city, and the
  // city is not a port of call (2026-10-10: the poster read "FROM MIA" and listed Miami as a port).
  const embarkPort = portDisplayName(g.embark_port);
  const home = (embarkPort ?? "").split(",")[0]!.trim().toLowerCase();
  const ports: string[] = [];
  for (const s of itinerary) {
    const short = s.port.split(",")[0]!.trim();
    if (s.seaDay || !short || short.toLowerCase() === home) continue;
    if (!ports.includes(short)) ports.push(short);
  }

  // One offer per (category, code, price): what a traveler can still choose.
  const byKey = new Map<string, CabinOffer>();
  for (const c of file.cabins) {
    if (!LIVE.has(c.status) || !c.category) continue;
    const total = c.price_total != null ? Number(c.price_total) : null;
    const dep = c.deposit_amount != null ? Number(c.deposit_amount) : null;
    const key = `${c.category}|${c.category_code ?? ""}|${total ?? ""}`;
    const o = byKey.get(key) ?? {
      category: displayName(c.category), code: c.category_code ?? null,
      perPerson: total !== null && total > 0 ? Math.round((total / 2) * 100) / 100 : null, perPersonText: null,
      depositPerPerson: dep !== null && dep > 0 ? Math.round((dep / 2) * 100) / 100 : null, depositPerPersonText: null,
      available: 0, total: 0,
    };
    o.total++;
    if (c.status !== "booked") o.available++;
    byKey.set(key, o);
  }
  const cabins = [...byKey.values()]
    .map((o) => ({ ...o, perPersonText: formatMoney(o.perPerson), depositPerPersonText: formatMoney(o.depositPerPerson) }))
    .sort((a, b) => (a.perPerson ?? Infinity) - (b.perPerson ?? Infinity));
  const live = file.cabins.filter((c) => LIVE.has(c.status));
  const priced = cabins.map((c) => c.perPerson).filter((x): x is number => x !== null);

  const bookBy = [g.deposit_due, g.recall_date].filter((d): d is string => typeof d === "string" && d.length >= 10).sort()[0] ?? null;

  const r = rating && rating.status === "published" && typeof rating.rating === "number"
    ? {
        score: rating.rating as number,
        scoreText: (rating.rating as number).toFixed(1),
        comment: (lang === "es" ? rating.comment_es : rating.comment) ?? rating.comment ?? null,
        saltyTake: (lang === "es" ? rating.salty_mark_take_es : rating.salty_mark_take) ?? rating.salty_mark_take ?? null,
      }
    : null;

  const facts: GroupFacts = {
    lang,
    business: { legalName: BUSINESS.legalName, tradeName: BUSINESS.tradeName, agentName: BUSINESS.agentName, email: BUSINESS.email, site: BUSINESS.site, host: BUSINESS.host },
    groupName: g.name,
    organizerName: g.organizer_name ?? null,
    line, ship,
    shipSlug: g.ship_slug ?? null,
    sailDate: g.sail_date ?? null,
    sailDateText: formatDate(g.sail_date, lang),
    returnDateText: formatDate(g.return_date, lang),
    nights: Number.isInteger(g.nights) ? g.nights : null,
    embarkPort,
    ports,
    itinerary,
    amenities: (Array.isArray(g.amenities) ? g.amenities : []).filter((a: unknown): a is string => typeof a === "string" && !!a.trim()).map((a) => humanizeAmenity(a, lang)),
    perks: (Array.isArray(g.inclusions) ? g.inclusions : []).filter((a: unknown): a is string => typeof a === "string" && !!a.trim()).map((a) => a.trim()),
    cabins,
    cabinsAvailable: live.filter((c) => c.status !== "booked").length,
    cabinsTotal: live.length,
    fromPerPersonText: priced.length ? formatMoney(Math.min(...priced)) : null,
    depositDueText: formatDate(g.deposit_due, lang),
    finalPaymentText: formatDate(g.final_payment_due, lang),
    bookByText: formatDate(bookBy, lang),
    rating: r,
    travel,
    allowedNumbers: [],
  };
  facts.allowedNumbers = collectNumbers(facts, g);
  return facts;
}

/** Digit runs in a string, with thousands separators and decimals folded ("$1,249.00" → "1249"). */
export function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const raw = m[0].replace(/,/g, "");
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(String(n));
  }
  return out;
}

function collectNumbers(f: GroupFacts, g: Row): string[] {
  const pool: string[] = [];
  const add = (v: unknown) => { if (v !== null && v !== undefined && v !== "") pool.push(...numbersIn(String(v))); };
  add(f.nights);
  if (f.nights !== null) add(f.nights + 1); // "a five-day cruise" on a four-night sailing
  add(f.sailDateText); add(f.returnDateText); add(f.depositDueText); add(f.finalPaymentText); add(f.bookByText);
  add(g.sail_date); add(g.return_date);
  for (const s of f.itinerary) { add(s.day); add(s.dateText); add(s.timesText); add(s.port); }
  for (const a of f.perks) add(a);
  for (const t of f.travel) add(t.text);
  add(BUSINESS.phone);
  for (const c of f.cabins) { add(c.perPersonText); add(c.depositPerPersonText); add(c.available); add(c.total); add(c.code); }
  add(f.cabinsAvailable); add(f.cabinsTotal); add(f.fromPerPersonText);
  add(f.ports.length);
  if (f.rating) { add(f.rating.scoreText); add("5"); }
  add(f.groupName); add(f.ship);
  return [...new Set(pool)];
}

// ── Copy ──────────────────────────────────────────────────────────────────────

export interface GroupCopy {
  headline: string;
  subhead: string;
  intro: string;
  why_ship: string;
  who_for: string;
  organizer_note: string | null;
  cta_label: string;
  cta_blurb: string;
  email_subject: string;
  email_body: string;
  social_post: string;
}

export const COPY_FIELDS: Array<{ key: keyof GroupCopy; label: string; max: number; long?: boolean; optional?: boolean }> = [
  { key: "headline", label: "Headline", max: 90 },
  { key: "subhead", label: "Line under the headline", max: 160 },
  { key: "intro", label: "Opening paragraph", max: 700, long: true },
  { key: "why_ship", label: "Why this ship and sailing", max: 700, long: true },
  { key: "who_for", label: "Who it suits (and who should think twice)", max: 600, long: true },
  { key: "organizer_note", label: "Organizer's line", max: 400, long: true, optional: true },
  { key: "cta_label", label: "Button text", max: 40 },
  { key: "cta_blurb", label: "Line beside the button", max: 220 },
  { key: "email_subject", label: "Invitation email subject", max: 90 },
  { key: "email_body", label: "Invitation email body", max: 1400, long: true },
  { key: "social_post", label: "Post for the group's own Facebook or chat", max: 500, long: true },
];

export const COPY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(COPY_FIELDS.map((f) => [f.key, f.optional ? { type: ["string", "null"] } : { type: "string" }])),
  required: COPY_FIELDS.map((f) => f.key),
};

// ── Mark's pitch ──────────────────────────────────────────────────────────────
// The copy is built around the pitch Mark wrote, sentence for sentence. These helpers are how the validators
// prove it: every sentence of the pitch must appear in the copy word for word (case, spacing and the full stop
// or exclamation mark at the end may differ, nothing else).

const ABBREVIATION = /\b(?:Mr|Mrs|Ms|Dr|St|Mt|Ft|Sr|Jr|vs|Inc|U\.S|a\.m|p\.m)\.$/i;

/** The pitch as its sentences, as Mark wrote them (trimmed). Line breaks end a sentence too. */
export function pitchSentences(pitch: string | null | undefined): string[] {
  const out: string[] = [];
  for (const line of String(pitch ?? "").split(/\n+/)) {
    let buf = "";
    for (const piece of line.split(/(?<=[.!?…]["')\]”’]*)\s+/).map((x) => x.trim()).filter(Boolean)) {
      buf = buf ? `${buf} ${piece}` : piece;
      if (!ABBREVIATION.test(buf)) { out.push(buf); buf = ""; }
    }
    if (buf) out.push(buf);
  }
  return out;
}

/** Straight quotes, one space between words, lower case. */
function squash(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
}
/** A sentence as it is looked for: squashed, with whatever closes it (. ! ? … quotes, brackets) dropped. */
function needle(sentence: string): string {
  return squash(sentence).replace(/[\s.!?…"')\]]+$/, "");
}

/** `needle` is in `hay` as whole words: "us" is not found inside "usher". */
function hasPhrase(hay: string, n: string): boolean {
  const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
  for (let at = hay.indexOf(n); at !== -1; at = hay.indexOf(n, at + 1)) {
    if (!isWord(hay[at - 1]) && !isWord(hay[at + n.length])) return true;
  }
  return false;
}

/** The pitch sentences that are NOT in the text word for word, as Mark wrote them. */
export function missingPitchSentences(pitch: string | null | undefined, text: string | null | undefined): string[] {
  const hay = squash(String(text ?? ""));
  return pitchSentences(pitch).filter((sent) => { const n = needle(sent); return n !== "" && !hasPhrase(hay, n); });
}

/** The fraction (0 to 1) of the pitch's sentences found word for word in the text. No pitch = 1. */
export function pitchCoverage(pitch: string | null | undefined, text: string | null | undefined): number {
  const all = pitchSentences(pitch).filter((sent) => needle(sent) !== "");
  if (!all.length) return 1;
  return (all.length - missingPitchSentences(pitch, text).length) / all.length;
}

/** The answers' text apart from the pitch: the numbers in it are Mark's to state without a second source. */
function otherAnswersText(answers: Record<string, string | boolean>): string {
  return Object.entries(answers).filter(([k, v]) => k !== "pitch" && typeof v === "string").map(([, v]) => v).join(" ");
}

/**
 * Mark's pitch is fact-checked like everything else: a number in it must be in the group file (or in another
 * of his answers, or in `extra`). The copy may repeat the pitch's numbers because they are reported here.
 */
export function pitchNumberProblems(answers: Record<string, string | boolean>, facts: GroupFacts, extra: readonly string[] = []): CopyProblem[] {
  const pitch = typeof answers["pitch"] === "string" ? answers["pitch"] : "";
  const known = new Set([...facts.allowedNumbers, ...numbersIn(otherAnswersText(answers)), ...extra]);
  return [...new Set(numbersIn(pitch))].filter((n) => !known.has(n))
    .map((n) => ({ field: "pitch", problem: `Mark's pitch states a number that is not in the group file: ${n}` }));
}

/** Marketing rules Mark has set that hold in every piece and every language (2026-10-11 / 2026-10-12). */
export const HOUSE_BANNED: Record<Lang, Array<{ re: RegExp; problem: string }>> = {
  en: [
    { re: /!/, problem: "has an exclamation mark" },
    { re: /\bjoin mark\b/i, problem: 'uses "Join Mark" (Mark is the contact, never the hook)' },
    { re: /\bamenity points?\b/i, problem: "mentions amenity points (show what the fare includes)" },
  ],
  es: [
    { re: /!/, problem: "has an exclamation mark" },
    { re: /(?<!\p{L})(?:join mark|[uú]nase a mark|[uú]nete a mark|sum[aá]te a mark|s[uú]mese a mark)(?!\p{L})/iu, problem: 'uses "Join Mark" (Mark is the contact, never the hook)' },
    { re: /\b(?:amenity points?|puntos? de (?:beneficios|amenidades))\b/i, problem: "mentions amenity points (show what the fare includes)" },
  ],
};

// Never hype, never promise (brand voice + liability posture). Checked per language.
const BANNED: Record<Lang, RegExp[]> = {
  en: [
    /\bactually\b/i, /\bcheap(er|est)?\b/i, /\bguarantee[ds]?\b/i, /\bonce[- ]in[- ]a[- ]lifetime\b/i, /\bultimate\b/i,
    /\bamazing\b/i, /\bunforgettable\b/i, /\bescape to\b/i, /\byou won'?t believe\b/i, /\bparadise\b/i, /\bluxur(y|ious)\b/i,
    /\bbest (price|deal|rate)\b/i, /\blowest (price|rate|fare)\b/i, /\bhurry\b/i, /\bdon'?t miss( out)?\b/i, /\bact now\b/i,
    /\bboasts?\b/i, /\bperfect for\b/i, /\bwill sell out\b/i, /\bselling fast\b/i, /\bworld[- ]class\b/i, /\bbreathtaking\b/i,
  ],
  es: [
    /\bgarantiz/i, /\b(m[aá]s )?barat[oa]s?\b/i, /\b[uú]nic[oa] en la vida\b/i, /\binolvidable/i, /\bincre[ií]ble/i, /\bpara[ií]so\b/i,
    /\blujo(s|so|sa)?\b/i, /\bmejor (precio|oferta|tarifa)\b/i, /\bprecio m[aá]s bajo\b/i, /\bap[uú]r(ate|ese|ense)\b/i,
    /\bno te lo pierdas\b/i, /\bno se lo pierda/i, /\bse agota/i, /\bde clase mundial\b/i, /\bimpresionante/i, /\bperfect[oa] para\b/i,
  ],
};

export interface CopyProblem { field: string; problem: string }

/** The part of the page copy that carries the pitch: the intro, then the paragraphs after it. */
const PITCH_FIELDS: Array<keyof GroupCopy> = ["intro", "why_ship", "who_for"];

/** Everything wrong with a piece of copy. Empty array = fit to show Mark. */
export function validateCopy(copy: unknown, facts: GroupFacts, answers: Record<string, string | boolean> = {}): CopyProblem[] {
  const problems: CopyProblem[] = [];
  const c = (copy && typeof copy === "object" ? copy : {}) as Row;
  const pitch = typeof answers["pitch"] === "string" ? answers["pitch"].trim() : "";
  // Numbers Mark himself wrote in the interview are his to state; the pitch's own numbers are checked by pitchNumberProblems.
  const allowed = new Set([...facts.allowedNumbers, ...numbersIn(Object.values(answers).filter((v) => typeof v === "string").join(" "))]);
  for (const f of COPY_FIELDS) {
    const v = c[f.key];
    if (v === null || v === undefined || v === "") {
      if (!f.optional) problems.push({ field: f.key, problem: "missing" });
      continue;
    }
    if (typeof v !== "string") { problems.push({ field: f.key, problem: "not text" }); continue; }
    if (v.length > f.max) problems.push({ field: f.key, problem: `too long (${v.length} of ${f.max} characters)` });
    for (const re of BANNED[facts.lang]) {
      const m = v.match(re);
      if (m) problems.push({ field: f.key, problem: `uses "${m[0]}"` });
    }
    for (const h of HOUSE_BANNED[facts.lang]) if (h.re.test(v)) problems.push({ field: f.key, problem: h.problem });
    for (const n of numbersIn(v)) {
      if (!allowed.has(n)) problems.push({ field: f.key, problem: `states a number that is not in the group file: ${n}` });
    }
    if (/[<>]/.test(v)) problems.push({ field: f.key, problem: "contains markup" });
  }
  // Built around the pitch: every sentence of it is in the opening copy, word for word. Mark writes in English,
  // so only the English copy can be checked sentence by sentence; the Spanish copy is told to translate it whole.
  if (pitch) {
    if (facts.lang === "en") {
      const body = PITCH_FIELDS.map((k) => (typeof c[k] === "string" ? (c[k] as string) : "")).join("\n");
      for (const sent of missingPitchSentences(pitch, body)) problems.push({ field: "intro", problem: `Pitch sentence not kept: '${sent}'` });
    }
    problems.push(...pitchNumberProblems(answers, facts));
  }
  return problems;
}

export function tidyCopy(raw: unknown): GroupCopy {
  const c = (raw && typeof raw === "object" ? raw : {}) as Row;
  const out: Row = {};
  for (const f of COPY_FIELDS) {
    const v = c[f.key];
    out[f.key] = typeof v === "string" && v.trim() ? v.trim().replace(/[ \t]+\n/g, "\n") : f.optional ? null : "";
  }
  return out as GroupCopy;
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const TONE: Record<string, string> = {
  "warm-humor": "Warm, told to a friend, with one or two light, dry touches of humor aimed at situations and never at the traveler.",
  warm: "Warm, plain and direct. No jokes.",
  formal: "Respectful and formal, suited to an organization writing to its members. No jokes.",
};

/**
 * The approved house voice for every group piece (Mark 2026-10-12, from the approved poster). Shared by the page
 * copy and the campaign so the two cannot drift apart. The examples show the SHAPE; they are another group's moment.
 */
export const HOUSE_VOICE_RULES: string[] = [
  '- Hook = the experience in 4–6 words, full stops, no exclamation marks. Example: "Sunset. Light show. Sunrise. Same beach. Same cruise."',
  '- One sentence that walks the reader through the moment, ending on a dry beat. Example: "Watch a Caribbean sunset, dance under a lighthouse light show, then walk that same beach at sunrise. The only hard decision all week is when to sleep."',
  '- One line for the occasion in the group\'s own words, plus a wink. Example: "Four nights of camaraderie and relaxation. Shoes optional."',
  '- Never "Join Mark" as the hook. Mark appears as the contact only, never in first person. No hype words, no superlatives, no emojis, no exclamation marks.',
  '- Perks shown = what the fare includes, from the quote (drinks package, Wi-Fi, overnight at Ocean Cay...), never "amenity points".',
  `- Primary CTA in every piece: "Scan the QR to join the fun" (exact words), then the link, then the phone ${BUSINESS.phone}.`,
  "- The examples above show the shape only. Never copy their words or details into another group's piece; use this group's own picture and facts.",
];

/** How a piece is built around Mark's pitch. `where` names the place that must carry it. */
export function pitchRules(where: string, spill: string, lang: Lang = "en"): string[] {
  return [
    lang === "es"
      ? `- Mark's pitch (in <advisor_interview>, written in English) is the spine and it is MARK'S, not yours: carry every sentence of it into ${where} in natural Latin American Spanish, sentence for sentence, in his order. Translate faithfully: cut nothing, add nothing, merge nothing, keep every number exactly. ${spill}`
      : `- Mark's pitch (in <advisor_interview>) is the spine and it is MARK'S, not yours: put every sentence of it into ${where}, word for word, in his order, and cut nothing. ${spill}`,
    lang === "es"
      ? "- Do not tighten, 'improve', brand-voice or reorder the pitch, even where it says 'I'. Add no number of your own."
      : "- Do not paraphrase, tighten, translate into 'brand voice' or reorder the pitch, even where it says 'I'. The only change allowed is a closing exclamation mark becoming a full stop. Add no number of your own.",
    "- The 'picture' answer is what the reader should SEE (the moment, never the ship): it steers the imagery and scene words you write around the pitch.",
    "- The 'occasion line' answer, in the group's own words, is the first half of the wink line; you add the dry wink.",
    "- A 'piece Mark likes' is a taste reference only. You cannot open it: never guess what is in it and never copy it.",
  ];
}

export function systemPrompt(lang: Lang): string {
  return [
    `You write the public invitation for a group cruise, in the voice of ${BUSINESS.tradeName}: a seasoned cruiser and trusted friend who tells the truth about cruising. Tagline: "Cruise smarter, laugh more."`,
    lang === "es"
      ? "Write in natural Latin American Spanish (es-419), usted for a mixed-age group unless the notes say family, then tú. Do not translate English idioms word for word."
      : "Write in plain American English.",
    "Voice: conversational expert. Dry, understated humor aimed at situations, documents and cruise habits — one or two touches per piece, never at the traveler, never cute. A flat statement, then a comparison out of proportion, delivered like it is nothing. Practical, specific, honest.",
    "Rules that are never broken:",
    "- The headline sells the EXPERIENCE (the overnight, the beach, the music, the short escape), never a person. The advisor is never named and never speaks in the first person; no 'join Mark', no 'I'll be sailing'. The brand speaks as 'we' or not at all.",
    "- Use only the facts given. Do not state any number, date, price, port, perk, deadline or ship feature that is not in the facts block. Prices, dates and the itinerary are shown on the page by the system; when you mention one it must match the facts exactly.",
    "- Perks are the guest's own: what the fare includes (the 'Included for every guest' facts). Never mention amenity points or anything the organizer receives.",
    "- Say that cabin upgrades are available (balcony and up, by request) in a natural line in the intro or who_for; it is a fact of every group.",
    "- The call to action is the QR code / the info sheet link: readers scan the QR or open the link to see everything and say they are in. The exact words 'Scan the QR to join the fun' appear in the cta_blurb, the email_body and the social_post, followed by the link, then the phone number for people who would rather call or text.",
    "- No hype and no sales pressure: no superlatives, no urgency, nothing called amazing, ultimate, unforgettable, luxury or paradise. Be specific instead.",
    "- Never promise or guarantee anything about prices, availability, weather, ports or the experience. Say what is planned and what is included.",
    "- Never say \"cheaper\"; say \"less expensive\". Never use the word \"actually\". No brochure words: boasts, offers, features, delivers.",
    "- Do not speak against the cruise line or any other line.",
    "- Apart from the pitch, the other interview answers feed the copy: keep the reasons and the honest caveats; tighten, do not embellish. Rewrite any first-person line from the advisor in those answers into the brand's voice (never in the pitch).",
    "- organizer_note: only the organizer's own line, lightly tidied, or null when none was given. Never invent a quote.",
    "- Plain text only. No markdown, no emoji, no hashtags, no exclamation marks anywhere.",
    "House voice (every piece), then how this page is laid out:",
    ...HOUSE_VOICE_RULES,
    ...pitchRules("the intro", "If the pitch is too long for the intro, continue it in why_ship and then who_for, still in his order.", lang),
    "- Layout: headline = the hook. subhead = the walk-through sentence ending on a dry beat. intro = Mark's pitch, verbatim. cta_blurb = the occasion line plus its wink, then 'Scan the QR to join the fun'.",
    `- email_body: two or three short paragraphs separated by blank lines, ending with "${BUSINESS.tradeName}" on its own line. It may refer to "the link below" for details; do not write a web address.`,
  ].join("\n");
}

export function userPrompt(facts: GroupFacts, answers: Record<string, string | boolean>): string {
  const lines: string[] = [];
  lines.push("<facts>");
  lines.push(`Group: ${facts.groupName}`);
  if (facts.organizerName) lines.push(`Organizer: ${facts.organizerName}`);
  lines.push(`Cruise line: ${facts.line}`);
  lines.push(`Ship: ${facts.ship}`);
  if (facts.sailDateText) lines.push(`Sails: ${facts.sailDateText}${facts.embarkPort ? ` from ${facts.embarkPort}` : ""}`);
  if (facts.returnDateText) lines.push(`Returns: ${facts.returnDateText}`);
  if (facts.nights !== null) lines.push(`Nights: ${facts.nights}`);
  if (facts.ports.length) lines.push(`Ports of call: ${facts.ports.join("; ")}`);
  if (facts.perks.length) lines.push(`Included for every guest: ${facts.perks.join("; ")}`);
  lines.push("Cabin upgrades: available by request (balcony and up).");
  lines.push(`Phone (second contact, after the QR / link): ${BUSINESS.phone}`);
  if (facts.travel.length) lines.push(`Getting there (air, hotel before, transfers): ${facts.travel.map((t) => t.text).join("; ")}`);
  if (answers["show_prices"] !== false) {
    for (const c of facts.cabins) if (c.perPersonText) lines.push(`Cabin: ${c.category} from ${c.perPersonText} per person, double occupancy${c.depositPerPersonText ? `, deposit ${c.depositPerPersonText} per person` : ""}`);
  }
  if (facts.bookByText) lines.push(`Reserve by: ${facts.bookByText}`);
  if (facts.finalPaymentText) lines.push(`Final payment: ${facts.finalPaymentText}`);
  if (facts.rating && answers["show_rating"] !== false) {
    lines.push(`Ship's cruiser score: ${facts.rating.scoreText} out of 5`);
    if (facts.rating.comment) lines.push(`What cruisers say: ${facts.rating.comment}`);
  }
  lines.push("</facts>");
  lines.push("<advisor_interview>");
  const pitchLines = pitchSentences(typeof answers["pitch"] === "string" ? answers["pitch"] : "");
  lines.push(pitchLines.length
    ? `Mark's pitch — his words, every sentence kept word for word:\n${pitchLines.map((x, i) => `${i + 1}. ${x}`).join("\n")}`
    : "Mark's pitch: (not given)");
  lines.push(`The picture the reader should see: ${answers["picture"] || "(not given)"}`);
  lines.push(`The occasion, in the group's own words: ${answers["occasion_line"] || "(not given)"}`);
  lines.push(`A piece Mark likes (taste only): ${answers["reference"] || "(none)"}`);
  lines.push(`Who the group is: ${answers["audience"] || "(not given)"}`);
  lines.push(`Occasion: ${answers["occasion"] || "(not given)"}`);
  lines.push(`Why this ship and sailing: ${answers["why_sailing"] || "(not given)"}`);
  lines.push(`Who it suits / who should think twice: ${answers["who_fits"] || "(not given)"}`);
  lines.push(`Organizer's line: ${answers["organizer_quote"] || "(none)"}`);
  lines.push(`Also planned: ${answers["extras"] || "(nothing extra)"}`);
  lines.push("</advisor_interview>");
  lines.push(`Tone: ${TONE[String(answers["tone"])] ?? TONE["warm-humor"]}`);
  lines.push("Write the invitation copy. The button asks the reader to say they are interested; it does not take a payment. The QR code on printed pieces opens the same page.");
  return lines.join("\n");
}

/** Feedback for one retry when the first draft breaks a rule. */
export function retryNote(problems: CopyProblem[]): string {
  return "Your draft broke these rules. Fix exactly these and change nothing else:\n" +
    problems.slice(0, 12).map((p) => `- ${p.field}: ${p.problem}`).join("\n");
}
