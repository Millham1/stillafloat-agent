// group-details.ts — what happens after "Count me in" on a group page (Mark 2026-10-23).
//
// "I want to give them the ability to just complete the forms rather than have me call them, so it becomes a choice giving them some control. I would
// need a page for them to complete the missing information. Auto fill what we have, then ask for DOB, have them run through the room concierge questions."
//
// Three approved designs sit behind this file (go-packets 5, 5a, 5b): the acknowledgement email, the choice that replaces the form on the group page, and
// the "Your details" page. This file holds every rule they need, as pure functions (no database, no mailer, no clock unless it is passed in), so each one
// is unit-tested in group-details.test.ts; routes/group-details.ts and routes/group-marketing.ts only wire them to Supabase and the mailer.
//
//   * pickCabin       the cabin we suggest from the four Room Concierge answers and the group's own cabin categories;
//   * validateDetails the names, birthdays and answers the page sends, refused in plain words (English and Spanish);
//   * ackEmail        the acknowledgement email (subject, html, text), in the approved words;
//   * detailsUrl / callUrl   the guest's private links.
//
// THE RULES (Mark 2026-10-23):
//   * the link is a credential: a random token whose sha256 alone is stored (group-secure.ts), good for 90 days;
//   * nothing here charges, books or signs anything: "Hold my cabin" is a request Mark confirms with the cruise line himself;
//   * what we say about a cabin is true of the group's own cabin categories, never a promise the file cannot back (see pickCabin).

import { BUSINESS } from "./group-secure";
import { buildFacts, cabinPrices, formatDate, formatMoney, normalizeAnswers, pageLook, type Lang } from "./group-marketing";

export type { Lang };

// ── The four Room Concierge answers (the same values as lib/concierge-interview.ts; details-page.test.ts holds the page to them) ──

export const ROOMS = ["inside", "oceanview", "balcony", "suite"] as const;
export const PRIORITIES = ["ocean", "quiet", "action", "space"] as const;
export const BUDGETS = ["lean", "middle", "treat", "sky"] as const;
export const MOTIONS = ["yes", "no"] as const;

export interface Concierge {
  room: (typeof ROOMS)[number];
  priority: (typeof PRIORITIES)[number];
  budget: (typeof BUDGETS)[number];
  motion: (typeof MOTIONS)[number];
}

/** One traveler as the guest typed them: the name as on the passport, and the birthday as yyyy-mm-dd. */
export interface Traveler { legal_name: string; dob: string }

/** A cabin category the group holds, with what it starts at per person (the same pair the group page shows under "Your cabin"). */
export interface Held { category: string; perPersonText: string | null }

/** Our pick: the category, where on the ship, and why, in a sentence or two. */
export interface Pick { category: string; where: string; why: string }

/** How long a details link works after it was made (days). */
export const DETAILS_TOKEN_DAYS = 90;
/** Most people on one reply (the group page's own "how many" goes to 12). */
export const MAX_TRAVELERS = 12;

/** Whether a link made at `issuedAt` still works at `now`. A missing or unreadable time never works. */
export function detailsTokenFresh(issuedAt: unknown, now: Date): boolean {
  if (typeof issuedAt !== "string" && !(issuedAt instanceof Date)) return false;
  const t = new Date(issuedAt as string).getTime();
  if (!Number.isFinite(t)) return false;
  const age = now.getTime() - t;
  return age >= -60_000 && age <= DETAILS_TOKEN_DAYS * 24 * 60 * 60 * 1000;
}

// ── What the file says about the sailing, for the page and the email ──────────────────────────────────────────

type Row = Record<string, unknown>;

export interface DetailsFacts {
  /** What the guest knows the group as: the interview's page name, else the group's own. */
  label: string;
  ship: string;
  sailDateText: string | null;
  returnDateText: string | null;
  /** The same dates with the weekday ("Sunday, May 9, 2027"), for the email. */
  sailLongText: string | null;
  returnLongText: string | null;
  embarkPort: string | null;
  ports: string[];
  /** The cabin categories and what each starts at per person: the group page's own list (empty when the interview hides the prices). */
  held: Array<{ category: string; perPersonText: string }>;
  taxesIncluded: boolean;
  /** What holds a spot per person ("$50"): the group's own deposit, else the lowest deposit on its cabins; null when the file has none. */
  depositPerPersonText: string | null;
  heroUrl: string | null;
  hostNames: string;
}

/** Everything the details page and the acknowledgement email say about the sailing, read from the group file (never typed here). */
export function detailsFacts(file: { group: Row; cabins: Row[] }, lang: Lang): DetailsFacts {
  const g = file.group;
  const answers = normalizeAnswers(g["marketing"]);
  const look = pageLook(answers);
  const facts = buildFacts({ group: g, cabins: file.cabins, travel: [] }, null, lang);
  const own = g["deposit_per_person"] === null || g["deposit_per_person"] === undefined || g["deposit_per_person"] === "" ? NaN : Number(g["deposit_per_person"]);
  const lowest = facts.cabins.map((c) => c.depositPerPerson).filter((x): x is number => x !== null && x > 0).sort((a, b) => a - b)[0];
  const deposit = Number.isFinite(own) && own > 0 ? own : lowest ?? null;
  return {
    label: look.label || String(g["name"] ?? ""),
    ship: facts.ship,
    sailDateText: facts.sailDateText,
    returnDateText: facts.returnDateText,
    sailLongText: formatDate(typeof g["sail_date"] === "string" ? (g["sail_date"] as string) : null, lang, true),
    returnLongText: formatDate(typeof g["return_date"] === "string" ? (g["return_date"] as string) : null, lang, true),
    embarkPort: facts.embarkPort,
    ports: facts.ports,
    held: answers["show_prices"] === false ? [] : cabinPrices(facts.cabins),
    taxesIncluded: look.taxesIncluded,
    depositPerPersonText: deposit === null ? null : formatMoney(deposit),
    heroUrl: look.heroUrl,
    hostNames: look.hostNames,
  };
}

// ── The links ─────────────────────────────────────────────────────────────────

const site = (s: string) => s.replace(/\/$/, "");
const pageFor = (lang: Lang) => (lang === "es" ? "/es/details.html" : "/details.html");

/** The guest's private "Your details" link. The Spanish page is /es/details.html (the same token opens both). */
export function detailsUrl(publicSite: string, token: string, lang: Lang = "en"): string {
  return `${site(publicSite)}${pageFor(lang)}?t=${token}`;
}

/** The same page, opened with the choice already made: the page tells us "call me" and thanks them. */
export function callUrl(publicSite: string, token: string, lang: Lang = "en"): string {
  return `${detailsUrl(publicSite, token, lang)}&choice=call`;
}

// ── pickCabin ─────────────────────────────────────────────────────────────────

/** A price as a number from its text ("$1,249.50" → 1249.5); null when there is none. */
function priceOf(text: string | null | undefined): number | null {
  if (typeof text !== "string") return null;
  const n = Number(text.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && /\d/.test(text) ? n : null;
}

const HAS_BALCONY = /balcon|balc[oó]n|suite|veranda|terrace|terraza/i;

/** The category names a room request falls back to when the group lists none (a page with the prices hidden). */
const GENERIC_CATEGORY: Record<Concierge["room"], Record<Lang, string>> = {
  inside: { en: "Interior", es: "Interior" },
  oceanview: { en: "Oceanview", es: "Vista al mar" },
  balcony: { en: "Balcony", es: "Balcón" },
  suite: { en: "Suite", es: "Suite" },
};

const WHERE: Record<"lowerMid" | "mid" | "high", Record<Lang, string>> = {
  lowerMid: { en: "midship, a lower deck", es: "en el centro del barco, en una cubierta baja" },
  mid: { en: "midship", es: "en el centro del barco" },
  high: { en: "a higher deck", es: "en una cubierta alta" },
};

const CLAUSE = {
  steady: { en: "Steady for whoever feels the motion", es: "Estable para quien sienta el movimiento" },
  quiet: { en: "quiet away from the pool deck", es: "alejada de la cubierta de la piscina" },
  balcony: { en: "a balcony for that coffee", es: "un balcón para ese café" },
  allBalconies: { en: "the group's cabins are all balconies, so you get one anyway", es: "todas las cabinas del grupo tienen balcón, así que usted tendrá uno de todos modos" },
  fallback: { en: "Our best fit for what you told us", es: "Lo que mejor se ajusta a lo que nos contó" },
} as const;

/** "A", "A and B", "A, B, and C" (English) / "A y B", "A, B y C" (Spanish). */
function joinClauses(parts: string[], lang: Lang): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return lang === "es" ? `${parts[0]} y ${parts[1]}` : `${parts[0]} and ${parts[1]}`;
  const head = parts.slice(0, -1).join(", ");
  return lang === "es" ? `${head} y ${parts[parts.length - 1]}` : `${head}, and ${parts[parts.length - 1]}`;
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * The cabin we suggest, from the four answers and the group's own cabin categories (`held`: category and per-person price text).
 *
 *   category  a treat or sky budget takes the higher-priced category, anything else the lower-priced one (prices are read from the text; one category is
 *             both). With no categories to choose from (the page's prices are hidden) it names the kind of cabin they asked for.
 *   where     "midship, a lower deck" when anyone feels the motion, else "midship" for a quiet priority, "a higher deck" for the ocean, else "midship".
 *   why       one or two sentences in Mark's voice, built only from what they told us: steady for the motion, quiet away from the pool deck, a balcony for
 *             that coffee (or, for an inside request, that the group's cabins are all balconies); then the price, with taxes and port fees when the group's
 *             quote includes them. A claim about balconies is made only when it is true of the cabin picked (an Interior pick never promises one).
 */
export function pickCabin(answers: Concierge, held: readonly Held[], lang: Lang = "en", taxesIncluded = false): Pick {
  const cats: Held[] = [];
  for (const h of held) if (h && typeof h.category === "string" && h.category.trim() && !cats.some((c) => c.category === h.category)) cats.push(h);
  // lowest price first; a category with no readable price keeps its place after the priced ones
  const ranked = cats.map((c, i) => ({ c, i, p: priceOf(c.perPersonText) })).sort((a, b) => (a.p ?? Infinity) - (b.p ?? Infinity) || a.i - b.i).map((x) => x.c);
  const higher = answers.budget === "treat" || answers.budget === "sky";
  const chosen: Held | null = ranked.length ? (higher ? ranked[ranked.length - 1]! : ranked[0]!) : null;
  const category = chosen ? chosen.category : GENERIC_CATEGORY[answers.room][lang];

  const where = (answers.motion === "yes" ? WHERE.lowerMid : answers.priority === "ocean" ? WHERE.high : WHERE.mid)[lang];

  const parts: string[] = [];
  if (answers.motion === "yes") parts.push(CLAUSE.steady[lang]);
  if (answers.priority === "quiet") parts.push(CLAUSE.quiet[lang]);
  const pickedBalcony = !!chosen && HAS_BALCONY.test(chosen.category);
  if ((answers.room === "balcony" || answers.room === "suite") && pickedBalcony) parts.push(CLAUSE.balcony[lang]);
  else if (answers.room === "inside" && cats.length > 0 && cats.every((c) => HAS_BALCONY.test(c.category))) parts.push(CLAUSE.allBalconies[lang]);
  let why = `${cap(joinClauses(parts.length ? parts : [CLAUSE.fallback[lang]], lang))}.`;

  const price = chosen?.perPersonText?.trim();
  if (price) {
    if (lang === "es") why += ` Desde ${price} por persona${taxesIncluded ? ", con impuestos y cargos portuarios incluidos" : ""}.`;
    else why += ` From ${price} per person${taxesIncluded ? ", taxes and port fees included" : ""}.`;
  }
  return { category, where, why };
}

// ── validateDetails ───────────────────────────────────────────────────────────

export type Validated =
  | { ok: true; travelers: Traveler[]; concierge: Concierge; count: number }
  | { ok: false; error: string; field: string };

const MSG = {
  noTravelers: { en: "Please add at least one traveler.", es: "Agregue al menos un viajero." },
  tooMany: { en: `Up to ${MAX_TRAVELERS} travelers on one list. For a bigger party, call or text Mark.`, es: `Hasta ${MAX_TRAVELERS} viajeros en una lista. Para un grupo más grande, llame o escriba a Mark.` },
  name: { en: (n: number) => `Traveler ${n}: please type the name as it is on the passport.`, es: (n: number) => `Viajero ${n}: escriba el nombre tal como aparece en el pasaporte.` },
  dob: { en: (n: number) => `Traveler ${n}: please add a date of birth.`, es: (n: number) => `Viajero ${n}: agregue la fecha de nacimiento.` },
  dobReal: { en: (n: number) => `Traveler ${n}: that date of birth does not look right. Please check it.`, es: (n: number) => `Viajero ${n}: esa fecha de nacimiento no parece correcta. Revísela.` },
  concierge: { en: "Please tap one answer for each of the four room questions.", es: "Toque una respuesta en cada una de las cuatro preguntas sobre la cabina." },
  body: { en: "Something went wrong with that form. Please reload the page.", es: "Algo salió mal con ese formulario. Recargue la página." },
} as const;

const LEGAL_NAME = /^[\p{L}\p{M}][\p{L}\p{M}'’.\- ]*$/u;

/** A date as yyyy-mm-dd that is a real calendar day; null otherwise. */
function realDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

/**
 * What the details page sends: `travelers` (1 to 12 of {legal_name, dob}) and `concierge` ({room, priority, budget, motion}). The names are tidied
 * (extra spaces dropped) and must be plain names: letters, spaces, hyphens, apostrophes and full stops, 2 to 80 characters, no markup. A birthday is a
 * real date, not in the future, and under 120 years ago. The number of travelers may differ from `guests` (people change their minds): any 1 to 12 is
 * accepted, and `count` says how many came.
 */
export function validateDetails(body: unknown, guests: number | null | undefined, lang: Lang = "en", now: Date = new Date()): Validated {
  void guests;
  const bad = (error: string, field: string): Validated => ({ ok: false, error, field });
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad(MSG.body[lang], "body");
  const raw = body as Record<string, unknown>;
  const list = raw["travelers"];
  if (!Array.isArray(list) || list.length < 1) return bad(MSG.noTravelers[lang], "travelers");
  if (list.length > MAX_TRAVELERS) return bad(MSG.tooMany[lang], "travelers");

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const oldest = Date.UTC(now.getUTCFullYear() - 120, now.getUTCMonth(), now.getUTCDate());
  const travelers: Traveler[] = [];
  for (let i = 0; i < list.length; i++) {
    const n = i + 1;
    const one = list[i];
    const o = one && typeof one === "object" && !Array.isArray(one) ? (one as Record<string, unknown>) : {};
    const name = typeof o["legal_name"] === "string" ? o["legal_name"].replace(/\s+/g, " ").trim() : "";
    if (name.length < 2 || name.length > 80 || !LEGAL_NAME.test(name) || (name.match(/\p{L}/gu) ?? []).length < 2) return bad(MSG.name[lang](n), `travelers.${i}.legal_name`);
    const dobText = typeof o["dob"] === "string" ? o["dob"].trim() : "";
    if (!dobText) return bad(MSG.dob[lang](n), `travelers.${i}.dob`);
    const dob = realDate(dobText);
    if (!dob || dob.getTime() > today || dob.getTime() <= oldest) return bad(MSG.dobReal[lang](n), `travelers.${i}.dob`);
    travelers.push({ legal_name: name, dob: dobText });
  }

  const c = raw["concierge"];
  const a = c && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
  const within = <T extends string>(v: unknown, set: readonly T[]): T | null => (typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : null);
  const room = within(a["room"], ROOMS), priority = within(a["priority"], PRIORITIES), budget = within(a["budget"], BUDGETS), motion = within(a["motion"], MOTIONS);
  if (!room) return bad(MSG.concierge[lang], "concierge.room");
  if (!priority) return bad(MSG.concierge[lang], "concierge.priority");
  if (!budget) return bad(MSG.concierge[lang], "concierge.budget");
  if (!motion) return bad(MSG.concierge[lang], "concierge.motion");
  return { ok: true, travelers, concierge: { room, priority, budget, motion }, count: travelers.length };
}

/**
 * Read back what was stored (the database holds JSON): the same shape, or null for anything that is not a list of named travelers / four known answers.
 * Never throws, so a half-saved or hand-edited row cannot break the page.
 */
export function storedTravelers(v: unknown): Traveler[] | null {
  if (!Array.isArray(v) || v.length < 1) return null;
  const out: Traveler[] = [];
  for (const t of v) {
    const o = t && typeof t === "object" ? (t as Record<string, unknown>) : {};
    if (typeof o["legal_name"] !== "string" || !o["legal_name"].trim() || typeof o["dob"] !== "string") return null;
    out.push({ legal_name: o["legal_name"], dob: o["dob"] });
  }
  return out;
}

export function storedConcierge(v: unknown): Concierge | null {
  const a = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const within = <T extends string>(x: unknown, set: readonly T[]): T | null => (typeof x === "string" && (set as readonly string[]).includes(x) ? (x as T) : null);
  const room = within(a["room"], ROOMS), priority = within(a["priority"], PRIORITIES), budget = within(a["budget"], BUDGETS), motion = within(a["motion"], MOTIONS);
  return room && priority && budget && motion ? { room, priority, budget, motion } : null;
}

export function storedPick(v: unknown): Pick | null {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return typeof o["category"] === "string" && typeof o["where"] === "string" && typeof o["why"] === "string"
    ? { category: o["category"], where: o["where"], why: o["why"] } : null;
}

/** The legal name split the way the group file keeps it: the LAST space divides first from last ("Mary Ann Smith" → "Mary Ann", "Smith"); one word is a first name only. */
export function splitLegalName(name: string): { first: string; last: string | null } {
  const clean = name.replace(/\s+/g, " ").trim();
  const cut = clean.lastIndexOf(" ");
  return cut < 0 ? { first: clean, last: null } : { first: clean.slice(0, cut), last: clean.slice(cut + 1) };
}

// ── The acknowledgement email ─────────────────────────────────────────────────

export interface AckInput {
  firstName: string;
  /** What the guest knows the group as (the page's name, else the group's). */
  groupLabel: string;
  ship?: string | null;
  /** The dates as they should read in the email ("Sunday, May 9, 2027"). */
  sailDateText: string | null;
  returnDateText: string | null;
  embarkPort?: string | null;
  /** The ports of call, home port left out. */
  ports: readonly string[];
  cabinPrices: ReadonlyArray<{ category: string; perPersonText: string }>;
  taxesIncluded: boolean;
  /** What holds a spot, per person ("$50"), when the file says. */
  depositPerPersonText: string | null;
  detailsUrl: string;
  callUrl: string;
  phone: string;
  /** Who signs: "Mark & Ceci", else "Mark". */
  hostNames: string;
  lang: Lang;
  /** The site the logos are loaded from (the box's own, so the email works on dev and on prod). */
  publicSite: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** The port as a person says it: the text before a comma or bracket, without "MSC Marine Reserve" (the group page does the same). */
const shortPort = (p: string) => p.split(/[,(]/)[0]!.replace(/MSC Marine Reserve/gi, " ").replace(/\s+/g, " ").trim();

const EMAIL = {
  en: {
    subject: (label: string) => `You're on the list for ${label}`,
    hi: (first: string) => `Hi ${first},`,
    h1: (first: string) => `You're on the list, ${first}!`,
    tapped: "You tapped Count me in! and that's all we needed.",
    tappedHtml: "You tapped <b>Count me in!</b> and that's all we needed.",
    twoWays: "Two ways from here. Your call.",
    twoWaysText: "Two ways from here, your call:",
    finish: "I'll finish it now",
    finishNote: "Names, birthdays and four quick questions from our Room Concierge. About three minutes, and your cabin is held.",
    call: "Mark, call me",
    callNote: "Mark calls or texts you within a day and does it with you.",
    callText: 'Or just reply "call me". Mark will call or text you within a day.',
    questions: (phone: string) => `Questions before then? Call or text Mark at ${phone}.`,
    see: "See you on board!",
    footer: (label: string) => `You got this email because you tapped Count me in on our ${label} page. Not you? Reply and we'll take you off.`,
  },
  es: {
    subject: (label: string) => `Ya está en la lista de ${label}`,
    hi: (first: string) => `Hola ${first}:`,
    h1: (first: string) => `¡Ya está en la lista, ${first}!`,
    tapped: "Tocó ¡Cuenten conmigo! y con eso nos basta.",
    tappedHtml: "Tocó <b>¡Cuenten conmigo!</b> y con eso nos basta.",
    twoWays: "Dos caminos desde aquí. Usted decide.",
    twoWaysText: "Dos caminos desde aquí, usted decide:",
    finish: "Lo termino ahora",
    finishNote: "Nombres, fechas de nacimiento y cuatro preguntas rápidas de nuestro Room Concierge. Unos tres minutos, y su cabina queda apartada.",
    call: "Mark, llámeme",
    callNote: "Mark le llama o le escribe en un día y lo hace con usted.",
    callText: 'O simplemente responda "llámeme". Mark le llamará o le escribirá en un día.',
    questions: (phone: string) => `¿Preguntas antes? Llame o escriba a Mark al ${phone}.`,
    see: "¡Nos vemos a bordo!",
    footer: (label: string) => `Recibió este correo porque tocó ¡Cuenten conmigo! en nuestra página de ${label}. ¿No fue usted? Responda y le quitamos de la lista.`,
  },
} as const;

/** "two cabins to choose from: A from $x or B from $y per person, taxes and port fees included… and just $50 per person holds your spot." */
function cabinSentence(i: AckInput): { text: string; html: string } | null {
  const cabins = i.cabinPrices.filter((c) => c.category && c.perPersonText);
  const es = i.lang === "es";
  if (!cabins.length) return null;
  const NUM_EN = ["", "one cabin", "two cabins", "three cabins", "four cabins", "five cabins"];
  const NUM_ES = ["", "una cabina", "dos cabinas", "tres cabinas", "cuatro cabinas", "cinco cabinas"];
  const count = (es ? NUM_ES : NUM_EN)[cabins.length] ?? `${cabins.length} ${es ? "cabinas" : "cabins"}`;
  const FROM = es ? "desde" : "from", OR = es ? "o" : "or";
  const items = cabins.map((c) => ({ t: `${c.category} ${FROM} ${c.perPersonText}`, h: `<b>${esc(c.category)} ${FROM} ${esc(c.perPersonText)}</b>` }));
  const join = (xs: string[]) => (xs.length <= 1 ? xs[0] ?? "" : `${xs.slice(0, -1).join(", ")} ${OR} ${xs[xs.length - 1]}`);
  const per = es ? "por persona" : "per person";
  const tax = i.taxesIncluded
    ? (es ? ", con impuestos y cargos portuarios incluidos" : ", taxes and port fees included")
    : (es ? ", con impuestos y cargos portuarios confirmados al reservar" : ", with taxes and port fees confirmed at booking");
  const dep = i.depositPerPersonText
    ? (es ? `… y solo ${i.depositPerPersonText} por persona aparta su lugar.` : `… and just ${i.depositPerPersonText} per person holds your spot.`)
    : ".";
  const depHtml = i.depositPerPersonText
    ? (es ? `… y solo <b>${esc(i.depositPerPersonText)} por persona</b> aparta su lugar.` : `… and just <b>${esc(i.depositPerPersonText)} per person</b> holds your spot.`)
    : ".";
  const lead = es ? `De cualquier manera, ${cabins.length === 1 ? "su cabina" : `${count} para elegir`}: ` : `Either way, ${cabins.length === 1 ? "your cabin" : `${count} to choose from`}: `;
  return {
    text: `${lead}${join(items.map((x) => x.t))} ${per}${tax}${dep}`,
    html: `${esc(lead)}${join(items.map((x) => x.h))} ${per}${esc(tax)}${depHtml}`,
  };
}

/** "The plan in one breath: we sail from Port Canaveral on Sunday, May 9… stops in Nassau and Ocean Cay… and home Thursday, May 13." Built only from the file. */
function planSentence(i: AckInput): string | null {
  const es = i.lang === "es";
  if (!i.sailDateText && !i.returnDateText) return null;
  const ports = [...new Set(i.ports.map(shortPort).filter(Boolean))];
  const list = ports.length <= 1 ? ports[0] ?? "" : `${ports.slice(0, -1).join(", ")} ${es ? "y" : "and"} ${ports[ports.length - 1]}`;
  const pieces: string[] = [];
  if (i.sailDateText) {
    const from = i.embarkPort ? (es ? ` desde ${i.embarkPort}` : ` from ${i.embarkPort}`) : "";
    pieces.push(es ? `zarpamos${from} el ${i.sailDateText}` : `we sail${from} on ${i.sailDateText}`);
  }
  if (list) pieces.push(es ? `${ports.length === 1 ? "una parada en" : "paradas en"} ${list}` : `${ports.length === 1 ? "a stop in" : "stops in"} ${list}`);
  if (i.returnDateText) {
    const back = pieces.length ? (es ? "y de regreso el" : "and home") : (es ? "regresamos el" : "we are home");
    pieces.push(`${back} ${i.returnDateText}`);
  }
  return `${es ? "El plan en pocas palabras" : "The plan in one breath"}: ${pieces.join("… ")}.`;
}

/**
 * The acknowledgement email (approved design 5, go-packets, 2026-10-23): "You're on the list, {first}!", two ways from here (yellow "I'll finish it now"
 * to the details page, outlined "Mark, call me" to the same page with the call already chosen), the cabins and what holds a spot, the plan in one
 * breath, the phone line, the sign-off and the legal footer with "Not you? Reply and we'll take you off." Every word that depends on the group comes
 * from the facts passed in; every value is escaped. The links are the guest's own and appear only in the body they are sent to.
 */
export function ackEmail(i: AckInput): { subject: string; html: string; text: string } {
  const T = EMAIL[i.lang];
  const first = i.firstName.trim();
  const label = i.groupLabel.trim();
  const cabins = cabinSentence(i);
  const plan = planSentence(i);
  const sign = i.hostNames.trim() || "Mark";

  const text = [
    T.hi(first),
    `${T.tapped} ${T.twoWaysText}`,
    `1. ${T.finish}: ${i.detailsUrl}\n   ${T.finishNote}`,
    `2. ${T.call}: ${i.callUrl}\n   ${T.callText}`,
    ...(cabins ? [cabins.text] : []),
    ...(plan ? [plan] : []),
    T.questions(i.phone),
    `${T.see}\n${sign}`,
    `${BUSINESS.legalName}\n${T.footer(label)}`,
  ].join("\n\n") + "\n";

  const p = (t: string) => `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:1.5;color:#07183f">${t}</p>`;
  const small = (t: string) => `<p style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.45;color:#4a5a7a">${t}</p>`;
  const logo = `${site(i.publicSite)}${BUSINESS.logoPath}`;
  const cornerstone = `${site(i.publicSite)}/assets/images/cornerstone-white.png`;
  const html = `<div style="margin:0;padding:0;background:#07183f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07183f"><tr><td align="center" style="padding:22px 16px 10px">
  <img src="${esc(logo)}" alt="Still Afloat" width="150" style="display:block;width:150px;height:auto"></td></tr>
<tr><td align="center" style="padding:6px 16px 24px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#f7fbff;border-radius:18px"><tr><td style="padding:26px 26px 18px">
    <p style="margin:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#9a6b00;font-weight:bold">${esc(label)}</p>
    <h1 style="margin:0 0 14px;font-family:Georgia,'Times New Roman',serif;font-weight:normal;font-size:30px;line-height:1.15;color:#07183f">${esc(T.h1(first))}</h1>
    ${p(T.tappedHtml)}
    ${p(T.twoWays)}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 6px"><tr><td style="background:#f5c33b;border-radius:999px"><a href="${esc(i.detailsUrl)}" style="display:inline-block;padding:14px 26px;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:bold;color:#07183f;text-decoration:none">${esc(T.finish)}</a></td></tr></table>
    ${small(esc(T.finishNote))}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 6px"><tr><td style="border:2px solid #07183f;border-radius:999px"><a href="${esc(i.callUrl)}" style="display:inline-block;padding:12px 24px;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:bold;color:#07183f;text-decoration:none">${esc(T.call)}</a></td></tr></table>
    ${small(esc(T.callNote))}
    ${cabins ? p(cabins.html) : ""}
    ${plan ? p(esc(plan)) : ""}
    ${p(esc(T.questions(i.phone)).replace(esc(i.phone), `<b>${esc(i.phone)}</b>`))}
    ${p(esc(T.see))}
    <p style="margin:0 0 18px;font-family:Georgia,'Times New Roman',serif;font-size:24px;color:#9a6b00">${esc(sign)}</p>
  </td></tr></table></td></tr>
<tr><td align="center" style="padding:0 16px 26px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px"><tr>
    <td style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#c9d3e8">${esc(BUSINESS.legalName)}<br>${esc(T.footer(label))}</td>
    <td align="right" valign="bottom" style="padding-left:12px"><img src="${esc(cornerstone)}" alt="" width="44" style="display:block;width:44px;height:auto"></td>
  </tr></table></td></tr></table></div>`;
  return { subject: T.subject(label), html, text };
}
