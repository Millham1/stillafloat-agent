// group-marketing.ts — the marketing layer of a group file (migration 0045).
//
// The split that matters (Mark's standing rules: no fabrication, never hype,
// explain and never promise):
//   FACTS  — dates, ports, prices, deposits, deadlines, amenities, the Conga
//            Line score. Built here from the group file by code. Never written,
//            rounded or restated by a model, and never stored inside the copy.
//   WORDS  — headline, the why, who it suits, the invitation email. Written from
//            Mark's interview answers + the facts, in HIS register (one rising
//            sentence through his moments, his adjectives and exclamation marks,
//            a capitalised payoff), then checked by validateCopy: any number that
//            is not one of the file's own numbers, any promise or sales pressure,
//            "Join Mark" or amenity points fails the copy before Mark sees it.
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

/**
 * The call to action of a PRINTED piece (the poster), unless the group's interview chooses another line (`cta_line`). A QR code is for paper:
 * Mark 2026-10-19: "how does one use a QR code that is already showing on their phone or computer".
 */
export const DEFAULT_CTA: Record<Lang, string> = { en: "Use the QR code to book your spot!", es: "¡Use el código QR para reservar su lugar!" };

/**
 * The call to action of every DIGITAL piece (the info page's own line, the campaign emails, the Facebook texts, the journey emails): a tappable
 * link, never a QR code. In an email it is the button's words; in a Facebook text it is written with a colon and followed by the link.
 */
export const DIGITAL_CTA: Record<Lang, string> = { en: "Tap here to book your spot!", es: "¡Toque aquí para reservar su lugar!" };

export type CtaMedium = "print" | "digital";

/** What the contract cannot tell us. Short on purpose — Mark fills this in once per group. */
export const INTERVIEW: InterviewQuestion[] = [
  // Mark 2026-10-11: no group creative is drafted without HIS pitch, his picture and a piece he likes. The copy is
  // built around the pitch word for word (validateCopy / validateCampaign check every sentence is still there).
  { key: "pitch", type: "long", required: true, label: "Your pitch, as you would say it to them", hint: "What the trip is, who it is for, why come, what they get, what to do next. Your words — the copy is built around them and nothing is cut." },
  { key: "picture", type: "long", label: "What should the reader see?", hint: "The moment, not the ship. One or two sentences." },
  { key: "occasion_line", type: "text", label: "The occasion, in the group's own words", hint: "One line, as you want it read. It is used exactly as you write it: nothing is added." },
  { key: "reference", type: "text", label: "A piece you like", hint: "A link or a name, so the piece matches your taste." },
  { key: "audience", type: "text", required: true, label: "Who is this group?", hint: "For example: members of the Post and their families, or Abuela's children, grandchildren and close friends." },
  { key: "occasion", type: "text", required: true, label: "What is the occasion?", hint: "A reunion, a milestone birthday, an annual trip. One line." },
  { key: "why_sailing", type: "long", required: true, label: "Why this ship and this sailing?", hint: "Your honest reasons, in your own words. This is the heart of the page." },
  { key: "who_fits", type: "long", label: "Who is this trip right for, and who should think twice?", hint: "Mobility, budget, first-timers, kids. The honest version builds trust." },
  { key: "organizer_quote", type: "long", label: "A line from the organizer (optional)", hint: "Their words, as they said them. Leave blank if you have none." },
  { key: "extras", type: "long", label: "Anything else planned around the cruise? (optional)", hint: "A group dinner, a bus to the port, a hotel the night before." },
  // Mark 2026-10-19: the poster says "Use the QR code to book your spot!" and every digital piece (email, Facebook, the page) says "Tap here to book your spot!";
  // another line can be chosen per group here and is then used on every piece.
  { key: "cta_line", type: "text", label: "The call to action, as it should read (optional)", hint: `Left blank, the poster says "${DEFAULT_CTA.en}" and every digital piece (the page, the emails, the Facebook posts) says "${DIGITAL_CTA.en}" with a link, because a QR code is for paper. Type another line to use it on every piece instead.` },
  { key: "tone", type: "choice", label: "Tone", fallback: "warm-humor",
    choices: [
      { value: "warm-humor", label: "Warm, with a little humor (the usual)" },
      { value: "warm", label: "Warm and straightforward" },
      { value: "formal", label: "Respectful and formal" },
    ] },
  { key: "show_prices", type: "yesno", label: "Show prices on the page?", fallback: true },
  { key: "show_rating", type: "yesno", label: "Show the ship's Conga Line score and note?", fallback: true },
];

/** The call-to-action line for this group: the interview's `cta_line` as Mark typed it, else the default for the medium. `custom` is true when it is his own line. */
export function ctaLine(answers: Record<string, string | boolean>, lang: Lang, medium: CtaMedium): { text: string; custom: boolean } {
  const own = typeof answers["cta_line"] === "string" ? answers["cta_line"].trim() : "";
  return own ? { text: own, custom: true } : { text: (medium === "print" ? DEFAULT_CTA : DIGITAL_CTA)[lang], custom: false };
}

/** The same call written for a Facebook text: "Tap here to book your spot:" and then the link (Mark's own line is used as he typed it). */
export function ctaForFacebook(answers: Record<string, string | boolean>, lang: Lang): string {
  const c = ctaLine(answers, lang, "digital");
  return c.custom ? c.text : c.text.replace(/!$/, ":");
}

/** A QR code is for paper. True when a digital piece names one outside Mark's own pitch sentences and his own `cta_line`. */
export function mentionsQr(text: string, answers: Record<string, string | boolean>, lang: Lang): boolean {
  const pitch = typeof answers["pitch"] === "string" ? answers["pitch"].trim() : "";
  let ours = withoutPitch(pitch, text);
  const own = ctaLine(answers, lang, "digital");
  if (own.custom) ours = ours.split(own.text).join(" ");
  return /(?<![\p{L}\d])QR(?![\p{L}\d])/iu.test(ours);
}

/** The answers in which Mark may have named something planned for the group (an onboard credit, a dinner …). */
const PLANNED_FROM = ["pitch", "picture", "occasion_line", "why_sailing", "who_fits", "extras"] as const;

/**
 * What Mark's own interview answers say is PLANNED for the group beyond what the fare includes — today only an onboard
 * credit ("$25 onboard credit", "an onboard credit of $50 per cabin"), copied from his words and never composed. Empty when
 * his answers do not name one: the page never invents a perk (Mark 2026-10-19).
 */
export function plannedForGroup(answers: Record<string, string | boolean>): string[] {
  const money = String.raw`\$\s?\d[\d,]*(?:\.\d{1,2})?`;
  const unit = String.raw`(?:\s+(?:per|a|each)\s+(?:person|guest|cabin|passenger|traveler|traveller|adult))?`;
  const patterns = [
    new RegExp(String.raw`${money}${unit}\s+(?:of\s+)?(?:on-?board|shipboard)\s+(?:spending\s+)?credit`, "i"),
    new RegExp(String.raw`(?:on-?board|shipboard)\s+(?:spending\s+)?credit\s+(?:of|worth|up to|:)?\s*${money}${unit}`, "i"),
  ];
  const out: string[] = [];
  for (const k of PLANNED_FROM) {
    const v = answers[k];
    if (typeof v !== "string") continue;
    for (const re of patterns) {
      const m = re.exec(v);
      const hit = m?.[0].replace(/\s+/g, " ").replace(/[\s:]+$/, "").trim();
      if (hit && !out.some((x) => x.toLowerCase() === hit.toLowerCase())) out.push(hit);
    }
  }
  return out;
}

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

/**
 * What the public page may see. No ids, no organizer contact, no internal notes, and no cabin availability or per-category
 * prices: the page only asks "I'm interested", and Mark decides which cabin once he has spoken to them (Mark 2026-10-19:
 * "why would they see the available cabins before I know they are interested").
 */
export function publicFacts(f: GroupFacts, answers: Record<string, string | boolean>): Row {
  const showPrices = answers["show_prices"] !== false;
  return {
    lang: f.lang, business: f.business, groupName: f.groupName, line: f.line, ship: f.ship,
    sailDateText: f.sailDateText, returnDateText: f.returnDateText, nights: f.nights, embarkPort: f.embarkPort,
    travel: f.travel, perks: f.perks, planned: plannedForGroup(answers),
    ports: f.ports, itinerary: f.itinerary, amenities: f.amenities,
    fromPerPersonText: showPrices ? f.fromPerPersonText : null,
    bookByText: f.bookByText, finalPaymentText: f.finalPaymentText,
    rating: answers["show_rating"] !== false ? f.rating : null,
    markSailing: answers["mark_sailing"] === true,
  };
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
  // Mark 2026-10-19: the headline IS the walk-through sentence ("Imagine ... then ... sunrise…"), one rising sentence through his moments, so it is
  // long (220, was 90 for a four-word hook); the line under it is the capitalised payoff ("ALL ON THE SAME CRUISE!").
  { key: "headline", label: "Headline (the one rising sentence through the moments)", max: 220 },
  { key: "subhead", label: "Payoff line under the headline", max: 160 },
  // The three paragraphs that carry Mark's own words (the pitch runs on through all three, his extras and caveats land in
  // who_for) are 900 each: 600 refused a who_for with his air/hotel package and a theme-park day in it (716 characters,
  // Millham F/F 2027, 2026-10-19). The short display fields (button, headline, subject) and the channel texts stay as they were.
  { key: "intro", label: "Opening paragraph", max: 900, long: true },
  { key: "why_ship", label: "Why this ship and sailing", max: 900, long: true },
  { key: "who_for", label: "Who it suits (and who should think twice)", max: 900, long: true },
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
//
// The pitch is HIS, not ours (Mark 2026-10-11 pitch first, 2026-10-12 keep his words): his exclamation marks and
// his adjectives ("incredible", "amazing") go in exactly as he wrote them. The bans that remain (no "Join Mark",
// no "amenity points", no promises or sales pressure, no "actually", no "cheaper") are for the words WE write around it,
// so the validators take his sentences out of a field (`withoutPitch`) before they look for banned words.

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

/** One pitch sentence as a pattern that finds it in the copy exactly where `missingPitchSentences` accepts it as kept: the
 *  same words whatever the case, spacing, quote style or closing mark, whole words only. The closing mark in the copy is part of the
 *  match, so a "!" Mark wrote (or one the copy has in its place) is his and goes with the sentence. */
function sentencePattern(sentence: string): RegExp | null {
  const n = needle(sentence);
  if (n === "") return null;
  const body = [...n].map((ch) => (/\s/.test(ch) ? "\\s+" : ch === "'" ? "['‘’]" : ch === '"' ? '["“”]' : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])[.!?…"'‘’“”)\\]]*`, "giu");
}

/**
 * The text with Mark's pitch sentences taken out (each replaced by a space), the same way `missingPitchSentences` finds them.
 * What is left is the words WE wrote, which is all the bans ("Join Mark", amenity points, promises, "actually" ...) apply to.
 * No pitch = the text as it is.
 */
export function withoutPitch(pitch: string | null | undefined, text: string): string {
  let out = text;
  const sentences = pitchSentences(pitch).map((x) => ({ x, n: needle(x) })).filter((x) => x.n !== "").sort((a, b) => b.n.length - a.n.length);
  for (const { x } of sentences) { const re = sentencePattern(x); if (re) out = out.replace(re, " "); }
  return out;
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

/**
 * Marketing rules Mark has set that hold in every group piece and every language (2026-10-11 / 2026-10-12).
 * Mark 2026-10-19 ("it is not my voice or style"): the exclamation-mark ban is gone, because his register has exclamation marks
 * (the capitalised payoff, "amazing", "incredible"); the two that stay are the ones about people and perks.
 */
export const HOUSE_BANNED: Record<Lang, Array<{ re: RegExp; problem: string }>> = {
  en: [
    { re: /\bjoin mark\b/i, problem: 'uses "Join Mark" (Mark is the contact, never the hook)' },
    { re: /\bamenity points?\b/i, problem: "mentions amenity points (show what the fare includes)" },
  ],
  es: [
    { re: /(?<!\p{L})(?:join mark|[uú]nase a mark|[uú]nete a mark|sum[aá]te a mark|s[uú]mese a mark)(?!\p{L})/iu, problem: 'uses "Join Mark" (Mark is the contact, never the hook)' },
    { re: /\b(?:amenity points?|puntos? de (?:beneficios|amenidades))\b/i, problem: "mentions amenity points (show what the fare includes)" },
  ],
};

// Never promise, never pressure (brand voice + liability posture). Checked per language. Mark 2026-10-19: his adjectives are part of
// his register, so the energy adjectives (amazing, unforgettable, ultimate, breathtaking, world-class and their Spanish twins) are no longer
// banned; what stays is what promises, pressures or claims a product tier (guarantee, once in a lifetime, best price, hurry, selling fast,
// luxury, paradise) and the brand's own words ("actually", "cheaper").
const BANNED: Record<Lang, RegExp[]> = {
  en: [
    /\bactually\b/i, /\bcheap(er|est)?\b/i, /\bguarantee[ds]?\b/i, /\bonce[- ]in[- ]a[- ]lifetime\b/i,
    /\bescape to\b/i, /\byou won'?t believe\b/i, /\bparadise\b/i, /\bluxur(y|ious)\b/i,
    /\bbest (price|deal|rate)\b/i, /\blowest (price|rate|fare)\b/i, /\bhurry\b/i, /\bdon'?t miss( out)?\b/i, /\bact now\b/i,
    /\bboasts?\b/i, /\bperfect for\b/i, /\bwill sell out\b/i, /\bselling fast\b/i,
  ],
  es: [
    /\bgarantiz/i, /\b(m[aá]s )?barat[oa]s?\b/i, /\b[uú]nic[oa] en la vida\b/i, /\bpara[ií]so\b/i,
    /\blujo(s|so|sa)?\b/i, /\bmejor (precio|oferta|tarifa)\b/i, /\bprecio m[aá]s bajo\b/i, /\bap[uú]r(ate|ese|ense)\b/i,
    /\bno te lo pierdas\b/i, /\bno se lo pierda/i, /\bse agota/i, /\bperfect[oa] para\b/i,
  ],
};

// ── The moments Mark named ────────────────────────────────────────────────────
// Mark 2026-10-19 (Millham F/F 2027, MSC Seashore: Nassau, then two days at Ocean Cay with an evening beach party and a
// light show from the island's lighthouse): the copy "doesn't highlight the sunset to sunrise or properly identify the
// light show / beach party as an exciting activity". The writer had his words but no order: it opened on the port, hung the
// party on the end of a clause and spent the energy on a dry beat. These helpers read the moments out of his answers (what
// the reader should see, the pitch, why this sailing) so the prompt can say what to lead with, in what order, and so the
// walk-through line can be checked against it. Pure code: a lexicon of plain nouns, no model, no numbers.

interface Lex { term: string; re: string }
/** A term and the pattern that finds it (whole words, any case). A space in the pattern is any run of white space. */
const lex = (term: string, re: string = term): Lex => ({ term, re: re.replace(/ /g, "\\s+") });
const wordsOf = (l: Lex, flags = "iu") => new RegExp(`(?<![\\p{L}\\p{N}])(?:${l.re})(?![\\p{L}\\p{N}])`, flags);

/** Things people DO together. Compounds come before the bare noun so "beach party" is one event, not "party". */
const EVENT_LEX: Lex[] = [
  lex("beach party", "beach part(?:y|ies)"), lex("pool party", "pool part(?:y|ies)"), lex("dance party", "dance part(?:y|ies)"),
  lex("sail-away party", "sail[-\\s]?away part(?:y|ies)"), lex("cocktail party", "cocktail part(?:y|ies)"), lex("welcome party", "welcome part(?:y|ies)"),
  lex("light show", "light shows?"), lex("laser show", "laser shows?"), lex("drone show", "drone shows?"), lex("talent show", "talent shows?"), lex("magic show", "magic shows?"),
  lex("live music"), lex("silent disco"), lex("movie night", "movie nights?"),
  lex("party", "part(?:y|ies)"), lex("concert", "concerts?"), lex("bonfire", "bonfires?"), lex("fireworks", "fireworks?"), lex("luau", "luaus?"),
  lex("cookout", "cookouts?"), lex("barbecue", "barbecues?|bbqs?"), lex("feast", "feasts?"), lex("dinner", "dinners?"), lex("parade", "parades?"),
  lex("festival", "festivals?"), lex("tasting", "tastings?"), lex("karaoke"), lex("regatta", "regattas?"), lex("excursion", "excursions?"), lex("tour", "tours?"),
];
const SUNSET = lex("sunset", "sunsets?|sundown|dusk");
const SUNRISE = lex("sunrise", "sunrises?|sunup|daybreak|dawn");
/** Concrete things a person sees or does, which give the copy its energy without an adjective. */
const SCENE_LEX: Lex[] = [
  lex("lighthouse", "lighthouses?"), lex("hammock", "hammocks?"), lex("island breezes", "(?:(?:island|ocean|sea|warm) )?breezes?"),
  lex("walking the beach", "walk(?:s|ing)? (?:(?:on|along|down|the) )*(?:beach|sand)"), lex("sand"), lex("music"),
  lex("dancing", "danc(?:e|es|ing)"), lex("swimming", "swim(?:s|ming)?"), lex("snorkeling", "snorkel(?:s|l?ing)?"), lex("kayaking", "kayak(?:s|ing)?"),
];

interface Hit { term: string; text: string; start: number; end: number }
/** Every lexicon term in the text, in the order written; a span already taken (by a compound, or `taken`) is not found twice. */
function scan(text: string, lexicon: readonly Lex[], taken: ReadonlyArray<readonly [number, number]> = []): Hit[] {
  const hits: Hit[] = [];
  const clash = (s: number, e: number) => hits.some((h) => s < h.end && e > h.start) || taken.some(([a, b]) => s < b && e > a);
  for (const l of lexicon) {
    for (const m of text.matchAll(wordsOf(l, "giu"))) {
      const s = m.index ?? 0, e = s + m[0].length;
      if (!clash(s, e)) hits.push({ term: l.term, text: m[0].toLowerCase().replace(/\s+/g, " "), start: s, end: e });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}
const mentions = (text: string, l: Lex) => wordsOf(l).test(text);
const uniq = <T,>(xs: readonly T[]): T[] => [...new Set(xs)];

export interface LeadWith {
  /** The headline activity: the words that name it (at most three), in the order Mark gives them, and where he says it. */
  event: { terms: string[]; from: string[] } | null;
  /** Sunset and sunrise, when he names both: the arc from the first to the last light of the same place. */
  arc: { terms: ["sunset", "sunrise"]; from: string[] } | null;
  /** Ports of call he names: the ones in the picture, else the ones in the pitch and his reasons. */
  ports: { names: string[]; from: string[] } | null;
  /** Other concrete things in his words (other events, the lighthouse, the hammock, walking the beach). */
  scenes: string[];
}

/** The places an answer is read from, in the order the reader should meet them: the picture, the pitch sentence by sentence, then why this sailing. */
function momentUnits(answers: Record<string, string | boolean>): Array<{ src: string; text: string }> {
  const s = (k: string) => (typeof answers[k] === "string" ? (answers[k] as string).trim() : "");
  const out: Array<{ src: string; text: string }> = [];
  if (s("picture")) out.push({ src: "picture", text: s("picture") });
  pitchSentences(s("pitch")).forEach((text, i) => out.push({ src: `pitch sentence ${i + 1}`, text }));
  for (const text of pitchSentences(s("why_sailing"))) out.push({ src: "why_sailing", text });
  return out;
}

/** A port as it may be written: its name, and its first two words when the name runs long ("Ocean Cay MSC Marine Reserve" is "Ocean Cay"). */
function portNames(port: string): string[] {
  const w = port.trim().split(/\s+/);
  return uniq([port.trim(), ...(w.length >= 3 ? [w.slice(0, 2).join(" ")] : [])]).filter(Boolean);
}

/**
 * The moments to lead with, read from Mark's own answers (the picture, the pitch and why this sailing), in the order the copy uses them:
 * the headline activity, then the sunset-to-sunrise arc, then the port. Nothing is invented: every word here is one he wrote.
 */
export function leadWith(answers: Record<string, string | boolean>, facts: Pick<GroupFacts, "ports">): LeadWith {
  const units = momentUnits(answers);
  const eventSpans = units.map((u) => scan(u.text, EVENT_LEX));
  // The headline activity is the first event he names (the picture first), plus every event named alongside it: a sentence of
  // his that shares a term with it ("beach party" in the picture, "beach party and light show" in the pitch) is the same event.
  const named = units.map((u, i) => ({ src: u.src, terms: uniq(eventSpans[i]!.map((h) => h.term)) })).filter((e) => e.terms.length);
  let event: LeadWith["event"] = null;
  const otherEvents: string[] = [];
  if (named.length) {
    const head = new Set(named[0]!.terms);
    const from = new Set([named[0]!.src]);
    for (let grew = true; grew;) {
      grew = false;
      for (const e of named) {
        if (from.has(e.src) || !e.terms.some((t) => head.has(t))) continue;
        e.terms.forEach((t) => head.add(t)); from.add(e.src); grew = true;
      }
    }
    const terms = [...head];
    event = { terms: terms.slice(0, 3), from: units.map((u) => u.src).filter((src, i, all) => from.has(src) && all.indexOf(src) === i) };
    otherEvents.push(...terms.slice(3), ...uniq(named.flatMap((e) => e.terms)).filter((t) => !head.has(t)));
  }

  const has = (l: Lex) => units.filter((u) => mentions(u.text, l)).map((u) => u.src);
  const sunsetFrom = has(SUNSET), sunriseFrom = has(SUNRISE);
  const arc: LeadWith["arc"] = sunsetFrom.length && sunriseFrom.length ? { terms: ["sunset", "sunrise"], from: uniq([...sunsetFrom, ...sunriseFrom]) } : null;

  const portsIn = (text: string) => facts.ports.filter((p) => portNames(p).some((n) => hasPhrase(squash(text), squash(n))));
  let ports: LeadWith["ports"] = null;
  const pictureUnit = units.find((u) => u.src === "picture");
  const inPicture = pictureUnit ? portsIn(pictureUnit.text) : [];
  const portUnits = inPicture.length ? [pictureUnit!] : units;
  const names = facts.ports.filter((p) => portUnits.some((u) => portsIn(u.text).includes(p)));
  if (names.length) ports = { names, from: uniq(portUnits.filter((u) => portsIn(u.text).length).map((u) => u.src)) };

  const taken = units.map((_, i) => eventSpans[i]!.map((h) => [h.start, h.end] as const));
  const scenes = new Map<string, string>();
  units.forEach((u, i) => { for (const h of scan(u.text, SCENE_LEX, taken[i])) if (!scenes.has(h.term)) scenes.set(h.term, h.text); });
  if (!arc) { if (sunsetFrom.length) scenes.set("sunset", "sunset"); if (sunriseFrom.length) scenes.set("sunrise", "sunrise"); }
  return { event, arc, ports, scenes: [...otherEvents, ...scenes.values()].slice(0, 6) };
}

/** What the writer is told to lead with, as the lines of the `<lead_with>` block (the numbered list is the order to use). */
export function leadWithLines(lw: LeadWith): string[] {
  const src = (from: string[]) => (from.length ? ` (${from.join("; ")})` : "");
  const items: string[] = [];
  if (lw.event) items.push(`The headline activity, named as an event people do: ${lw.event.terms.join(", ")}${src(lw.event.from)}`);
  if (lw.arc) items.push(`The arc, sunset to sunrise in the one place: sunset, then sunrise${src(lw.arc.from)}`);
  if (lw.ports) items.push(`The port${lw.ports.names.length > 1 ? "s" : ""}: ${lw.ports.names.join(", ")}${src(lw.ports.from)}`);
  if (!items.length) {
    return ["Nothing in his answers names an event, a sunset-to-sunrise arc or a port of call. String the first image in \"The picture the reader should see\", then the next, in his order, into ONE rising sentence, then the payoff; if the picture is empty, build the sentence from the most physical moments in the pitch."];
  }
  return [
    "String these moments, in this order, into ONE rising sentence, then the payoff. They are the moments Mark gave you in the picture, the pitch and his reasons. The headline is that sentence, the payoff is the line under it, and the email and the posts open with the same sentence.",
    ...items.map((x, i) => `${i + 1}. ${x}`),
    ...(lw.scenes.length ? [`Scene details in his words (use them to make the moments physical): ${lw.scenes.join(", ")}`] : []),
  ];
}

export interface CopyProblem { field: string; problem: string }

export const QR_PROBLEM = "mentions a QR code (a digital piece carries a link to tap; the QR code is on the printed poster only)";

/** The one wording of a field that is over its limit, so the dashboard says what to do about it. */
export function tooLong(length: number, max: number): string {
  return `too long: ${length} of ${max} characters — shorten it, or ask Mark`;
}

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
    if (v.length > f.max) problems.push({ field: f.key, problem: tooLong(v.length, f.max) });
    // The house-voice bans are for our words: Mark's pitch sentences (his "!" and his "incredible") are taken out first.
    const ours = withoutPitch(pitch, v);
    for (const re of BANNED[facts.lang]) {
      const m = ours.match(re);
      if (m) problems.push({ field: f.key, problem: `uses "${m[0]}"` });
    }
    for (const h of HOUSE_BANNED[facts.lang]) if (h.re.test(ours)) problems.push({ field: f.key, problem: h.problem });
    if (mentionsQr(v, answers, facts.lang)) problems.push({ field: f.key, problem: QR_PROBLEM });
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

/**
 * What Mark should see but what does not stop him approving (a "note", where a problem blocks): the walk-through sentence (the
 * headline, with the payoff line under it) does not carry the moments his answers name. Mark 2026-10-19: the writer's line had the light show
 * but not the beach party, and the sunrise but not the sunset, so the event read as an aside. It is a nudge to read the line again,
 * never a rule the copy fails: only English is checked (Mark writes in English; the Spanish copy is a translation), and a field
 * that is missing is already a problem.
 */
export function copyNotes(copy: unknown, facts: Pick<GroupFacts, "lang" | "ports">, answers: Record<string, string | boolean> = {}): CopyProblem[] {
  if (facts.lang !== "en") return [];
  const c = (copy && typeof copy === "object" ? copy : {}) as Row;
  const str = (k: string) => (typeof c[k] === "string" ? (c[k] as string) : "");
  const line = [str("headline"), str("subhead")].filter((x) => x.trim()).join(" ");
  if (!str("headline").trim()) return [];
  const lw = leadWith(answers, facts);
  const notes: CopyProblem[] = [];
  if (lw.event) {
    const lacking = lw.event.terms.filter((t) => !mentions(line, EVENT_LEX.find((l) => l.term === t)!));
    if (lacking.length) notes.push({ field: "headline", problem: `the walk-through sentence does not mention the ${lacking.join(" / ")} the ${lw.event.from.some((f) => f.startsWith("pitch")) ? "pitch" : "picture"} names` });
  }
  if (lw.arc && !(mentions(line, SUNSET) && mentions(line, SUNRISE))) {
    const where = lw.arc.from.includes("why_sailing") ? "why-sailing answer" : lw.arc.from[0]!.startsWith("pitch") ? "pitch" : "picture";
    notes.push({ field: "headline", problem: `the walk-through sentence does not carry the sunset-to-sunrise arc the ${where} names (it needs both "sunset" and "sunrise")` });
  }
  return notes;
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
  "warm-humor": "Warm and enthusiastic, told to a friend, in Mark's own register: long rising sentences and his own adjectives. No humor of your own; a joke appears only where Mark wrote it.",
  warm: "Warm, plain and direct. Keep the one rising sentence and the payoff; no extra enthusiasm beyond Mark's own words. No jokes.",
  formal: "Respectful and formal, suited to an organization writing to its members. Keep the one rising sentence and the payoff; no jokes.",
};

/**
 * Mark's register for every group piece (Mark 2026-10-19, after he rejected the whole set the writer produced for his own group: "it is not my
 * voice or style, you have concatenated meaningful phrases so they have no impact"). It is HIS own: the pitch he wrote and his 10/12 markup of the
 * approved poster ("Imagine, watching a Caribbean sunset, dancing to an amazing light show on the beach, then walking the beach to the most
 * beautiful sunrise..... ALL ON THE SAME CRUISE!"): one rising sentence through the moments in his order that lands on a short capitalised payoff
 * with an exclamation mark, his adjectives and exclamation marks, no fragments, no dry beats. Shared by the page copy and the campaign so the two
 * cannot drift apart. The examples show the SHAPE; they are another group's moment.
 */
export const HOUSE_VOICE_RULES: string[] = [
  "- Mark's register (the model for every group piece is his own pitch and his own markup of the approved poster): the hook is ONE flowing sentence that starts \"Imagine…\" (or opens in an equally flowing way), walks the reader through the moments in <lead_with> in his order, one after another inside that same sentence with the energy rising as it goes, and lands on a short capitalised payoff that ends in an exclamation mark. Shape (another group's moments): \"Imagine, watching a Caribbean sunset, dancing to an amazing light show on the beach, then walking the beach to the most beautiful sunrise..... ALL ON THE SAME CRUISE!\" In Spanish write the same sentence in natural Latin American Spanish (\"¡TODO EN EL MISMO CRUCERO!\").",
  "- The payoff is a short capitalised line ending in an exclamation mark that says what the moments add up to, in his words (\"ALL ON THE SAME CRUISE!\" when they all happen on the one sailing). It comes last and stands on its own: on the page it is the subhead; in an email or a post it follows the sentence.",
  "- Never a chain of two-word sentences. No fragments, no lists of nouns with full stops (\"Beach party. Light show. Sunrise.\"), no short sentence tacked on for effect, no dry beat, no wink. Each moment keeps its meaning because it sits inside the one sentence with the moments around it; chopped into fragments it has no impact.",
  "- Warmth and energy are Mark's: his adjectives (\"amazing\", \"incredible\", \"most beautiful\") and his exclamation marks are part of the register and are allowed in the words we write, in every piece. Take them from his answers (the pitch, the picture, why this sailing) and reuse his own; the energy comes from his moments in his order and from his words, so never invent a superlative or an adjective he did not use. Humor only where he wrote it: the occasion line is used exactly as he wrote it in the interview, with nothing added; with no answer there is no occasion line.",
  "- Never \"Join Mark\" as the hook (his own \"Join us\" is fine). Mark appears as the contact only, never in first person in the words we write. No emojis.",
  "- Perks shown = what the fare includes, from the quote (drinks package, Wi-Fi, overnight at Ocean Cay...), never \"amenity points\".",
  "- The examples above show the shape only. Never copy their words or details into another group's piece; use this group's own picture, moments and facts.",
];

/**
 * The call to action of the DIGITAL pieces, as one rule, for both prompts (Mark 2026-10-19: a tappable link, never a QR code, on anything read on a
 * screen; the interview's `cta_line` chooses another line for a group). The link is the info sheet; the phone is the third contact. In an email the
 * line is the words of a button, with the plain link under it (the system draws both); in a Facebook text the line ends in a colon and the link follows.
 */
export function ctaRule(answers: Record<string, string | boolean>, lang: Lang, pieces: string): string {
  const cta = ctaLine(answers, lang, "digital");
  const words = lang === "es" && cta.custom ? `the line "${cta.text}", translated into natural Latin American Spanish` : `the exact words "${cta.text}"`;
  const facebook = cta.custom ? "" : ` (in a Facebook text the same words end in a colon, "${ctaForFacebook(answers, lang)}", and the link follows on the next line)`;
  return `- Call to action, ${pieces}: ${words}${facebook}, then the link, then the phone ${BUSINESS.phone} for people who would rather call or text. Readers are on a phone or a computer already, so they tap the link to see everything and say they are in. Never mention a QR code: a QR code is for the printed poster only. It closes the piece, before an email's sign-off.`;
}

/**
 * What to lead with (Mark 2026-10-19). The picture, the pitch and his reasons name the moments; `<lead_with>` in the user prompt
 * lists them in order. Shared by the page copy and the campaign so the two cannot drift apart. The brackets show the SHAPE only.
 */
export const LEAD_WITH_RULES: string[] = [
  "- What to lead with: <lead_with> in the user message lists the moments Mark himself named, in the order to use them. String these moments, in this order, into ONE rising sentence, then the payoff. His 'picture' answer and the concrete moments in his pitch and reasons are THE story: the headline activity first, named as an event people do (the evening beach party under the light show), then the sunset-to-sunrise arc in the one place, then the port. Never open on the ship, the schedule or a verb like 'browse'. Mark's pitch keeps its own order (it is copied word for word); this order is for the words we write around it. Spanish copy names the same moments in natural Spanish. The examples in these rules are another group's moments and show the shape only: use this group's moments from <lead_with>.",
  "- The headline IS that sentence and the subhead is its payoff. The sentence starts 'Imagine…', every moment is a phrase of the one sentence (never a sentence of its own), the energy rises to the last moment, and it fits in about 200 characters. The headline activity is named with the words Mark used (for example 'beach party', 'light show') and is the subject of its phrase, never a clause tucked after 'browse', 'watch' or 'enjoy'; when <lead_with> has the arc, the sentence carries both words 'sunset' and 'sunrise'; the port goes in as the place a moment happens ('shopping Nassau in the morning') and may sit wherever it reads most naturally. If the moments will not fit, keep the headline activity and the arc and put the rest in the intro or why_ship.",
  "- The payoff never undercuts the event: no 'allegedly', no 'supposedly', no joke about the schedule or about sleeping, no joke at the event's expense.",
  "- Energy comes from Mark's moments and his own words: concrete, present-tense things (the sand, the music, the lighthouse lighting the beach, walking back at sunrise) and the adjectives and exclamation marks he used ('amazing', 'incredible', 'most beautiful'), reused as he wrote them. Never an invented superlative, never a stack of adjectives he did not use. Use the scene details Mark gave in <lead_with>.",
  "- Where the 'picture' answer names images, why_ship and who_for echo them as scenes (what a person sees or does, in the present tense), in the same order. email_body and the social post (social_post, and the campaign's email 1 and Facebook announcement) open with the same 'Imagine…' sentence and its payoff.",
];

/** How a piece is built around Mark's pitch. `where` names the place that must carry it. */
export function pitchRules(where: string, spill: string, lang: Lang = "en"): string[] {
  return [
    lang === "es"
      ? `- Mark's pitch (in <advisor_interview>, written in English) is the spine and it is MARK'S, not yours: carry every sentence of it into ${where} in natural Latin American Spanish, sentence for sentence, in his order. Translate faithfully: cut nothing, add nothing, merge nothing, keep every number exactly. ${spill}`
      : `- Mark's pitch (in <advisor_interview>) is the spine and it is MARK'S, not yours: put every sentence of it into ${where}, word for word, in his order, and cut nothing. ${spill}`,
    lang === "es"
      ? "- Do not tighten, 'improve', brand-voice or reorder the pitch, even where it says 'I'. Add no number of your own."
      : "- Copy each pitch sentence character for character: his punctuation and his word choices stay exactly as he wrote them. If he wrote an exclamation mark, keep it; if he wrote 'incredible' or 'amazing', keep it. Do not paraphrase, swap a word for a synonym, tighten, translate into 'brand voice' or reorder the pitch, even where it says 'I' or 'Join us'. No change is allowed, not even a closing exclamation mark becoming a full stop. Add no number of your own.",
    ...(lang === "es" ? [] : ["- The rules about what we write (no 'Join Mark', no 'amenity points', no promises or pressure, no 'actually', no 'cheaper') are for the words WE write around the pitch. They never apply inside his sentences, and they never change a word of them."]),
    "- The 'picture' answer is what the reader should SEE (the moment, never the ship): it steers the moments you string into the sentence and the scene words around the pitch.",
    "- The 'occasion line' answer, in the group's own words, is used exactly as Mark wrote it: nothing added, no wink.",
    "- A 'piece Mark likes' is a taste reference only. You cannot open it: never guess what is in it and never copy it.",
  ];
}

/** The English prompts' reminder that the bans cover our words only; Mark's pitch sentences keep his own punctuation and words. */
export function pitchIsHis(lang: Lang): string {
  return lang === "es" ? "" : " Mark's pitch sentences are his own words and keep his punctuation and word choices (see the pitch rules below).";
}

export function systemPrompt(lang: Lang, answers: Record<string, string | boolean> = {}): string {
  return [
    `You write the public invitation for a group cruise, in the voice of ${BUSINESS.tradeName}, which for a group is Mark's own: a seasoned cruiser and trusted friend telling a group what the trip will be like. Tagline: "Cruise smarter, laugh more."`,
    lang === "es"
      ? "Write in natural Latin American Spanish (es-419), usted for a mixed-age group unless the notes say family, then tú. Do not translate English idioms word for word."
      : "Write in plain American English.",
    "Voice: Mark's register, not a copywriter's. Warm, enthusiastic and concrete, like a friend describing the trip out loud: long sentences that run and build from one moment to the next, his adjectives, his exclamation marks, nothing clipped. No dry irony, no stand-up timing, no fragments. Practical, specific, honest.",
    "Rules that are never broken:",
    "- The headline sells the EXPERIENCE (the moments in <lead_with>), never a person. The advisor is never named and never speaks in the first person; no 'join Mark', no 'I'll be sailing'. The brand speaks as 'we' or not at all.",
    "- Use only the facts given. Do not state any number, date, price, port, perk, deadline or ship feature that is not in the facts block. Prices, dates and the itinerary are shown on the page by the system; when you mention one it must match the facts exactly.",
    "- Perks are the guest's own: what the fare includes (the 'Included for every guest' facts). Never mention amenity points or anything the organizer receives.",
    "- Say that cabin upgrades are available (balcony and up, by request) in a natural line in the intro or who_for; it is a fact of every group.",
    ctaRule(answers, lang, "in the cta_blurb, the email_body and the social_post"),
    `- No sales pressure and no promises in the words we write: no urgency, no 'act now', no 'best price', nothing 'guaranteed'. The excitement comes from the moments and from Mark's own words and adjectives, which you may reuse; never invent a superlative he did not use.${pitchIsHis(lang)}`,
    "- Never promise or guarantee anything about prices, availability, weather, ports or the experience. Say what is planned and what is included.",
    "- Never say \"cheaper\"; say \"less expensive\". Never use the word \"actually\". No brochure words: boasts, offers, features, delivers.",
    "- Do not speak against the cruise line or any other line.",
    "- Apart from the pitch, the other interview answers feed the copy: keep the reasons and the honest caveats in Mark's words as far as you can; do not embellish. Rewrite any first-person line from the advisor in those answers into the brand's voice (never in the pitch).",
    "- organizer_note: only the organizer's own line, lightly tidied, or null when none was given. Never invent a quote.",
    `- Plain text only. No markdown, no emoji, no hashtags. Exclamation marks and the capitalised payoff are part of the register (below), in every piece.${pitchIsHis(lang)}`,
    "Mark's register (every piece), then how this page is laid out:",
    ...HOUSE_VOICE_RULES,
    ...LEAD_WITH_RULES,
    ...pitchRules("the intro", "If the pitch is too long for the intro, continue it in why_ship and then who_for, still in his order.", lang),
    "- Layout: headline = the one rising 'Imagine…' sentence built from <lead_with> (about 200 characters at most). subhead = the payoff alone, a short capitalised line ending in '!'. intro = Mark's pitch, verbatim, then the facts that matter in a sentence or two (the ship, the sailing, the ports, what the fare includes), every number from the facts block. why_ship and who_for echo the picture's images as scenes, in his words. social_post and email_body open with the same 'Imagine…' sentence and its payoff, then his pitch. cta_blurb = the occasion line exactly as he wrote it (when he gave one), then the call to action.",
    `- email_body: two or three short paragraphs separated by blank lines, ending with "${BUSINESS.tradeName}" on its own line. It may refer to "the link below" for details; do not write a web address.`,
  ].join("\n");
}

/** The last line of the page-copy prompt. The campaign prompt supplies its own. */
const COPY_CLOSING = "Write the invitation copy in Mark's register: the headline is ONE rising sentence through the <lead_with> moments in that order, the subhead is its capitalised payoff, and never a chain of two-word sentences. The button asks the reader to say they are interested; it does not take a payment. The QR code on printed pieces opens the same page.";

export function userPrompt(facts: GroupFacts, answers: Record<string, string | boolean>, closing: string = COPY_CLOSING): string {
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
  lines.push(`Phone (second contact, after the link): ${BUSINESS.phone}`);
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
    ? `Mark's pitch — his words, every sentence kept word for word, with his punctuation and word choices exactly as written:\n${pitchLines.map((x, i) => `${i + 1}. ${x}`).join("\n")}`
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
  lines.push("<lead_with>", ...leadWithLines(leadWith(answers, facts)), "</lead_with>");
  lines.push(`Tone: ${TONE[String(answers["tone"])] ?? TONE["warm-humor"]}`);
  if (closing) lines.push(closing);
  return lines.join("\n");
}

/** Feedback for one retry when the first draft breaks a rule. Notes (the gentle checks) ride along: they never cause a retry on their own. */
export function retryNote(problems: CopyProblem[], notes: CopyProblem[] = []): string {
  return "Your draft broke these rules. Fix exactly these and change nothing else:\n" +
    problems.slice(0, 12).map((p) => `- ${p.field}: ${p.problem}`).join("\n") +
    (problems.some((p) => p.problem.startsWith("Pitch sentence not kept")) ? "\nA pitch sentence is copied character for character as Mark wrote it, with his punctuation and his words; the rules about what we write never apply inside it." : "") +
    (notes.length ? "\nAnd fix these too (Mark wants them, though they do not block approval); string the moments in <lead_with> into the one rising sentence:\n" + notes.slice(0, 4).map((p) => `- ${p.field}: ${p.problem}`).join("\n") : "");
}
