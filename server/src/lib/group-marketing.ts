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
}

/** What the contract cannot tell us. Short on purpose — Mark fills this in once per group. */
export const INTERVIEW: InterviewQuestion[] = [
  { key: "audience", type: "text", label: "Who is this group?", hint: "For example: members of the Post and their families, or Abuela's children, grandchildren and close friends." },
  { key: "occasion", type: "text", label: "What is the occasion?", hint: "A reunion, a milestone birthday, an annual trip. One line." },
  { key: "why_sailing", type: "long", label: "Why this ship and this sailing?", hint: "Your honest reasons, in your own words. This is the heart of the page." },
  { key: "who_fits", type: "long", label: "Who is this trip right for, and who should think twice?", hint: "Mobility, budget, first-timers, kids. The honest version builds trust." },
  { key: "mark_sailing", type: "yesno", label: "Are you sailing with the group?", fallback: false },
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

export function normalizeAnswers(raw: unknown): Record<string, string | boolean> {
  const src = (raw && typeof raw === "object" ? raw : {}) as Row;
  const out: Record<string, string | boolean> = {};
  for (const q of INTERVIEW) {
    const v = src[q.key];
    if (q.type === "yesno") out[q.key] = typeof v === "boolean" ? v : (q.fallback as boolean) ?? false;
    else if (q.type === "choice") out[q.key] = q.choices!.some((c) => c.value === v) ? (v as string) : ((q.fallback as string) ?? q.choices![0]!.value);
    else out[q.key] = typeof v === "string" ? v.trim().slice(0, 2000) : "";
  }
  return out;
}

/** The interview is ready to write from once the three core answers exist. */
export function missingAnswers(answers: Record<string, string | boolean>): string[] {
  return ["audience", "occasion", "why_sailing"].filter((k) => !answers[k]);
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
  amenities: string[];
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

  const home = (g.embark_port ?? "").split(",")[0]!.trim().toLowerCase();
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
    embarkPort: g.embark_port ?? null,
    ports,
    itinerary,
    amenities: (Array.isArray(g.amenities) ? g.amenities : []).filter((a: unknown): a is string => typeof a === "string" && !!a.trim()).map((a) => humanizeAmenity(a, lang)),
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
  for (const a of f.amenities) add(a);
  for (const t of f.travel) add(t.text);
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

/** Everything wrong with a piece of copy. Empty array = fit to show Mark. */
export function validateCopy(copy: unknown, facts: GroupFacts, answers: Record<string, string | boolean> = {}): CopyProblem[] {
  const problems: CopyProblem[] = [];
  const c = (copy && typeof copy === "object" ? copy : {}) as Row;
  // Numbers Mark himself wrote in the interview are his to state.
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
    for (const n of numbersIn(v)) {
      if (!allowed.has(n)) problems.push({ field: f.key, problem: `states a number that is not in the group file: ${n}` });
    }
    if (/[<>]/.test(v)) problems.push({ field: f.key, problem: "contains markup" });
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

export function systemPrompt(lang: Lang): string {
  return [
    `You write a group cruise invitation for ${BUSINESS.agentName} of ${BUSINESS.tradeName}, a travel advisor who talks like a seasoned cruiser and a trusted friend.`,
    lang === "es"
      ? "Write in natural Latin American Spanish (es-419), usted for a mixed-age group unless the notes say family, then tú. Do not translate English idioms word for word."
      : "Write in plain American English.",
    "Rules that are never broken:",
    "- Use only the facts given. Do not state any number, date, price, port, perk, deadline or ship feature that is not in the facts block. Prices, dates and the itinerary are shown on the page by the system; you do not need to repeat them, and when you do mention one it must match the facts exactly.",
    "- No hype and no sales pressure: no superlatives, no urgency, nothing called amazing, ultimate, unforgettable, luxury or paradise. Be specific instead.",
    "- Never promise or guarantee anything about prices, availability, weather, ports or the experience. Say what is planned and what is included.",
    "- Never say \"cheaper\"; say \"less expensive\". Never use the word \"actually\".",
    "- Do not speak against the cruise line or any other line.",
    "- The advisor's own words in the interview are the spine: keep his reasons and his honest caveats; tighten, do not embellish.",
    "- organizer_note: only the organizer's own line, lightly tidied, or null when none was given. Never invent a quote.",
    "- Plain text only. No markdown, no emoji, no hashtags, no exclamation marks in the headline.",
    "- email_body: two or three short paragraphs separated by blank lines, ending with the advisor's first name on its own line. It may refer to \"the link below\" for details; do not write a web address.",
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
  if (facts.amenities.length) lines.push(`Group perks: ${facts.amenities.join("; ")}`);
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
  lines.push(`Who the group is: ${answers["audience"] || "(not given)"}`);
  lines.push(`Occasion: ${answers["occasion"] || "(not given)"}`);
  lines.push(`Why this ship and sailing: ${answers["why_sailing"] || "(not given)"}`);
  lines.push(`Who it suits / who should think twice: ${answers["who_fits"] || "(not given)"}`);
  lines.push(`Advisor is sailing with the group: ${answers["mark_sailing"] ? "yes" : "no"}`);
  lines.push(`Organizer's line: ${answers["organizer_quote"] || "(none)"}`);
  lines.push(`Also planned: ${answers["extras"] || "(nothing extra)"}`);
  lines.push("</advisor_interview>");
  lines.push(`Tone: ${TONE[String(answers["tone"])] ?? TONE["warm-humor"]}`);
  lines.push("Write the invitation copy. The button asks the reader to tell the advisor they are interested; it does not take a payment.");
  return lines.join("\n");
}

/** Feedback for one retry when the first draft breaks a rule. */
export function retryNote(problems: CopyProblem[]): string {
  return "Your draft broke these rules. Fix exactly these and change nothing else:\n" +
    problems.slice(0, 12).map((p) => `- ${p.field}: ${p.problem}`).join("\n");
}
