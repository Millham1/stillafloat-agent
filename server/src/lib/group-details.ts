// group-details.ts — what happens after "Save my spot!" on a group page (Mark 2026-10-23, reshaped 2026-10-24 into two roads).
//
// "I want to give them the ability to just complete the forms rather than have me call them, so it becomes a choice giving them some control."
// Then (2026-10-24): the client gets ONE message, never two. Road A, "Talk me into it, Mark!": a drop-down for the time, one line, ONE email, one item for
// Mark. Road B, "I've got this… let me fill it in!": a details page in three short parts, "Hold my cabin!", one line, ONE email, one item for Mark.
// No prices after the group page: the guest has seen them. This file holds every rule the two roads need, as pure functions (no database, no mailer, no
// clock unless it is passed in), so each one is unit-tested in group-details.test.ts; routes/group-details.ts and routes/group-marketing.ts only wire
// them to Supabase and the mailer.
//
//   * pickCabin       the cabin we suggest from the four Room Concierge answers and the group's own cabin categories, with the upgrade hook;
//   * validateDetails the names, birthdays, address and answers the page sends, refused in plain words (English and Spanish);
//   * callEmail       Road A's ONE email ("Good call… literally!");
//   * holdEmail       Road B's ONE email ("Your cabin is on hold… nicely done!");
//   * detailsUrl / callUrl   the guest's private links.
//
// THE RULES (Mark 2026-10-23/24):
//   * the link is a credential: a random token whose sha256 alone is stored (group-secure.ts), good for 90 days;
//   * nothing here charges, books or signs anything: "Hold my cabin" is a request Mark confirms with the cruise line himself;
//   * what we say about a cabin is true of the group's own cabin categories, never a promise the file cannot back (see pickCabin);
//   * no cabin name and no price in Road A's email, no price anywhere in Road B (the deposit per person on the hold line is what holds the cabin, not a price).

import { BUSINESS } from "./group-secure";
import { buildFacts, cabinPrices, formatDate, formatMoney, normalizeAnswers, pageLook, type Lang } from "./group-marketing";
import { US_STATES } from "./address-lookup";

export type { Lang };

// ── The four Room Concierge answers (the same values as lib/concierge-interview.ts; details-page.test.ts holds the page to them) ──

export const ROOMS = ["inside", "oceanview", "balcony", "suite"] as const;
export const PRIORITIES = ["ocean", "quiet", "action", "space"] as const;
export const BUDGETS = ["lean", "middle", "treat", "sky"] as const;
export const MOTIONS = ["yes", "no"] as const;
/** The four answers to "When's a good time to catch you?" (Road A's drop-down). */
export const CALL_WHENS = ["morning", "afternoon", "evening", "anytime"] as const;
export type CallWhen = (typeof CALL_WHENS)[number];

export interface Concierge {
  room: (typeof ROOMS)[number];
  priority: (typeof PRIORITIES)[number];
  budget: (typeof BUDGETS)[number];
  motion: (typeof MOTIONS)[number];
}

/** One traveler as the guest typed them: the name as on the passport, and the birthday as yyyy-mm-dd. */
export interface Traveler { legal_name: string; dob: string }

/** The one home address for the cabin. `tidied` is true when the post office's lookup corrected it and the guest accepted the correction. */
export interface Address { street: string; city: string; state: string; zip: string; tidied: boolean }

/** A cabin category the group holds, with what it starts at per person (the same pair the group page shows under "Your cabin"). The price only orders the categories: it is never said after the group page. */
export interface Held { category: string; perPersonText: string | null }

/** The higher category as a hook: its short name ("Aurea") and the sentence of what it adds, built from the group's own `upgrade_perks`. */
export interface Upgrade { category: string; hook: string }

/** Our pick: the category, where on the ship, why in a sentence, and the upgrade hook when the file gives one. */
export interface Pick { category: string; where: string; why: string; upgrade: Upgrade | null }

/** How long a details link works after it was made (days). */
export const DETAILS_TOKEN_DAYS = 90;
/** Most travelers on one cabin (the cruise line's limit for these cabins). A bigger party gets a second cabin from Mark, on the call. */
export const MAX_TRAVELERS = 4;

/** Whether a link made at `issuedAt` still works at `now`. A missing or unreadable time never works. */
export function detailsTokenFresh(issuedAt: unknown, now: Date): boolean {
  if (typeof issuedAt !== "string" && !(issuedAt instanceof Date)) return false;
  const t = new Date(issuedAt as string).getTime();
  if (!Number.isFinite(t)) return false;
  const age = now.getTime() - t;
  return age >= -60_000 && age <= DETAILS_TOKEN_DAYS * 24 * 60 * 60 * 1000;
}

// ── What the file says about the sailing, for the page and the emails ─────────────────────────────────────────

type Row = Record<string, unknown>;

export interface DetailsFacts {
  /** What the guest knows the group as: the interview's page name, else the group's own. */
  label: string;
  ship: string;
  sailDateText: string | null;
  returnDateText: string | null;
  /** The cabin categories and what each starts at per person: the group page's own list (empty when the interview hides the prices). Used to ORDER the categories, never said. */
  held: Array<{ category: string; perPersonText: string }>;
  taxesIncluded: boolean;
  /** What holds a spot per person ("$50"): the group's own deposit, else the lowest deposit on its cabins; null when the file has none. */
  depositPerPersonText: string | null;
  /** One perk of the higher category per entry, from the interview's `upgrade_perks` (one per line). Empty when Mark has not written them. */
  upgradePerks: string[];
  heroUrl: string | null;
  hostNames: string;
}

/** The lines of the interview's `upgrade_perks` answer: trimmed, no bullets, no blanks. */
export function upgradePerkLines(v: unknown): string[] {
  return (typeof v === "string" ? v : "").split(/\r?\n/).map((l) => l.replace(/^[\s\-*•·]+/, "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8);
}

/** Everything the details page and the emails say about the sailing, read from the group file (never typed here). */
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
    held: answers["show_prices"] === false ? [] : cabinPrices(facts.cabins),
    taxesIncluded: look.taxesIncluded,
    depositPerPersonText: deposit === null ? null : formatMoney(deposit),
    upgradePerks: upgradePerkLines(answers["upgrade_perks"]),
    heroUrl: look.heroUrl,
    hostNames: look.hostNames,
  };
}

/** The first number that looks like a phone number in a line ("Questions? Call or text Mark at 919-346-6127." → "919-346-6127"); null when there is none. */
export function phoneFromBlurb(text: unknown): string | null {
  const m = typeof text === "string" ? /\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/.exec(text) : null;
  return m ? m[0] : null;
}

/** The number Mark rings from, as the guest reads it: the number in the group's own "line beside the button", else the business number. */
export function callerPhone(blurb: unknown): string {
  return phoneFromBlurb(blurb) ?? BUSINESS.phone;
}

/** "919-346-6127" → "919". */
function areaCode(phone: string): string | null {
  const d = phone.replace(/\D/g, "");
  const ten = d.length >= 10 ? d.slice(-10) : "";
  return ten ? ten.slice(0, 3) : null;
}

/** The first word of a name ("Mary Ann van der Berg" → "Mary"); what the page and the emails call the guest. */
export function firstWord(name: unknown): string {
  return (typeof name === "string" ? name : "").trim().split(/\s+/)[0] ?? "";
}

// ── The links ─────────────────────────────────────────────────────────────────

const site = (s: string) => s.replace(/\/$/, "");
const pageFor = (lang: Lang) => (lang === "es" ? "/es/details.html" : "/details.html");

/** The guest's private "Your details" link. The Spanish page is /es/details.html (the same token opens both). */
export function detailsUrl(publicSite: string, token: string, lang: Lang = "en"): string {
  return `${site(publicSite)}${pageFor(lang)}?t=${token}`;
}

/** The same page, with `&choice=call` (the earlier design's "Mark, call me" link; the page no longer reads it, and the group page now carries the call road itself). */
export function callUrl(publicSite: string, token: string, lang: Lang = "en"): string {
  return `${detailsUrl(publicSite, token, lang)}&choice=call`;
}

// ── Numbers and lists in words ────────────────────────────────────────────────

const NUM = {
  en: ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"],
  es: ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce"],
} as const;

/** 3 → "three" / "tres" (0 to 12; anything else stays digits). */
export function numberWord(n: number, lang: Lang): string {
  return Number.isInteger(n) && n >= 0 && n <= 12 ? NUM[lang][n]! : String(n);
}

/** "Mark" / "Mark and Ceci" / "Mark, Ceci and Pat" (English) / "Mark y Ceci" / "Mark, Ceci y Pat" (Spanish): the email's way, with no comma before the last. */
function joinNames(names: readonly string[], lang: Lang): string {
  if (names.length <= 1) return names[0] ?? "";
  const and = lang === "es" ? "y" : "and";
  return `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`;
}

/** "A", "A and B", "A, B, and C" (English, the Oxford comma the hook is written with) / "A y B", "A, B y C" (Spanish). */
function joinSerial(parts: readonly string[], lang: Lang): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return lang === "es" ? `${parts[0]} y ${parts[1]}` : `${parts[0]} and ${parts[1]}`;
  const head = parts.slice(0, -1).join(", ");
  return lang === "es" ? `${head} y ${parts[parts.length - 1]}` : `${head}, and ${parts[parts.length - 1]}`;
}

/** "A", "A and B", "A, B, and C" for the pick's why clauses (the original rule: no serial comma before "and" for two, one for three or more). */
function joinClauses(parts: string[], lang: Lang): string { return joinSerial(parts, lang); }

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** Lower-case the first letter of a perk so it reads in the middle of a sentence, unless it starts an acronym written in capitals ("MSC Yacht Club" stays as it is). */
const lowerFirst = (s: string) => (/^[A-Z](?![A-Z])/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

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

/**
 * The name the upgrade goes by: the higher category without the words it shares at the front with the pick ("Balcony Aurea" over "Balcony Bella" is
 * "Aurea"; "Balcony" over "Interior" stays "Balcony"). Never empty: when nothing is left, the full name.
 */
export function upgradeName(pickCategory: string, higherCategory: string): string {
  const a = pickCategory.trim().split(/\s+/), b = higherCategory.trim().split(/\s+/);
  let k = 0;
  while (k < a.length && k < b.length - 1 && a[k]!.toLowerCase() === b[k]!.toLowerCase()) k++;
  return b.slice(k).join(" ") || higherCategory.trim();
}

/** The perks as one sentence: the first three, the first letter of each lower-cased, joined with commas and "and" before the last; capitalised, with a full stop. "" for no perks. */
export function upgradeHook(perks: readonly string[], lang: Lang): string {
  const three = perks.map((p) => p.trim().replace(/[.;]+$/, "")).filter(Boolean).slice(0, 3).map(lowerFirst);
  return three.length ? `${cap(joinSerial(three, lang))}.` : "";
}

/**
 * The cabin we suggest, from the four answers and the group's own cabin categories (`held`: category and per-person price text, the price used ONLY
 * to put the categories in order: it is never said after the group page).
 *
 *   category  a treat or sky budget takes the higher-priced category, anything else the lower-priced one (prices are read from the text; one category is
 *             both). With no categories to choose from (the page's prices are hidden) it names the kind of cabin they asked for.
 *   where     "midship, a lower deck" when anyone feels the motion, else "midship" for a quiet priority, "a higher deck" for the ocean, else "midship".
 *   why       one or two sentences in Mark's voice, built only from what they told us: steady for the motion, quiet away from the pool deck, a balcony for
 *             that coffee (or, for an inside request, that the group's cabins are all balconies). A claim about balconies is made only when it is true of
 *             the cabin picked (an Interior pick never promises one). No price.
 *   upgrade   the NEXT category up, as a hook from `perks` (the group's `upgrade_perks`); null when there are no perks, no higher category, or the pick is the top.
 */
export function pickCabin(answers: Concierge, held: readonly Held[], lang: Lang = "en", perks: readonly string[] = []): Pick {
  const cats: Held[] = [];
  for (const h of held) if (h && typeof h.category === "string" && h.category.trim() && !cats.some((c) => c.category === h.category)) cats.push(h);
  // lowest price first; a category with no readable price keeps its place after the priced ones
  const ranked = cats.map((c, i) => ({ c, i, p: priceOf(c.perPersonText) })).sort((a, b) => (a.p ?? Infinity) - (b.p ?? Infinity) || a.i - b.i).map((x) => x.c);
  const higher = answers.budget === "treat" || answers.budget === "sky";
  const at = ranked.length ? (higher ? ranked.length - 1 : 0) : -1;
  const chosen: Held | null = at >= 0 ? ranked[at]! : null;
  const category = chosen ? chosen.category : GENERIC_CATEGORY[answers.room][lang];

  const where = (answers.motion === "yes" ? WHERE.lowerMid : answers.priority === "ocean" ? WHERE.high : WHERE.mid)[lang];

  const parts: string[] = [];
  if (answers.motion === "yes") parts.push(CLAUSE.steady[lang]);
  if (answers.priority === "quiet") parts.push(CLAUSE.quiet[lang]);
  const pickedBalcony = !!chosen && HAS_BALCONY.test(chosen.category);
  if ((answers.room === "balcony" || answers.room === "suite") && pickedBalcony) parts.push(CLAUSE.balcony[lang]);
  else if (answers.room === "inside" && cats.length > 0 && cats.every((c) => HAS_BALCONY.test(c.category))) parts.push(CLAUSE.allBalconies[lang]);
  const why = `${cap(joinClauses(parts.length ? parts : [CLAUSE.fallback[lang]], lang))}.`;

  const next = chosen && at + 1 < ranked.length ? ranked[at + 1]! : null;
  const hook = upgradeHook(perks, lang);
  const upgrade: Upgrade | null = next && hook ? { category: upgradeName(chosen!.category, next.category), hook } : null;
  return { category, where, why, upgrade };
}

/** The reasons behind a pick in words, for Mark's list: "feels the motion, wants quiet, balcony". */
export function reasonsInWords(c: Concierge): string {
  const priority = { ocean: "wants the ocean", quiet: "wants quiet", action: "wants the action", space: "wants room to spread out" }[c.priority];
  const room = { inside: "inside cabin", oceanview: "oceanview", balcony: "balcony", suite: "suite" }[c.room];
  return [c.motion === "yes" ? "feels the motion" : null, priority, room].filter(Boolean).join(", ");
}

// ── validateDetails ───────────────────────────────────────────────────────────

export type Validated =
  | { ok: true; travelers: Traveler[]; address: Address; concierge: Concierge; count: number }
  | { ok: false; error: string; field: string };

/** The words of the red notes, the same on the page and here (Road B design, row 5). */
export const MSG = {
  noTravelers: { en: "Please add at least one traveler.", es: "Agregue al menos un viajero." },
  tooMany: {
    en: "More than four? Mark will set up a second cabin on the call… tap Talk me into it, Mark! on the group page.",
    es: "¿Más de cuatro? Mark arma una segunda cabina en la llamada… toque ¡Convénzame, Mark! en la página del grupo.",
  },
  name: { en: "First AND last name, please… the way the passport has it.", es: "Nombre Y apellido, por favor… tal como aparecen en el pasaporte." },
  dob: { en: "Month, day and a four-digit year: 03 / 04 / 1965.", es: "Mes, día y año de cuatro dígitos (el mes primero): 03 / 04 / 1965." },
  street: { en: "A street and number, please… like 123 Main St.", es: "Una calle y un número, por favor… como 123 Main St." },
  city: { en: "Which city, please?", es: "¿En qué ciudad, por favor?" },
  state: { en: "The state's two letters, please… like NC.", es: "Las dos letras del estado, por favor… como NC." },
  zip: { en: "Five digits for the ZIP, please… like 27601.", es: "Cinco dígitos para el código postal, por favor… como 27601." },
  concierge: { en: "Please tap one answer for each of the four room questions.", es: "Toque una respuesta en cada una de las cuatro preguntas sobre la cabina." },
  body: { en: "Something went wrong with that form. Please reload the page.", es: "Algo salió mal con ese formulario. Recargue la página." },
} as const;

/** Letters (any language), marks, apostrophes, hyphens and spaces: nothing else is a name. */
const NAME_CHARS = /^[\p{L}\p{M}'’\- ]+$/u;

/** A legal name as typed → the tidy name, or null when it is not a first AND last name made of letters, spaces, hyphens and apostrophes (2 to 80 characters). */
export function tidyLegalName(raw: unknown): string | null {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (name.length < 3 || name.length > 80 || !NAME_CHARS.test(name)) return null;
  const words = name.split(" ");
  if (words.length < 2 || words.some((w) => !/\p{L}/u.test(w))) return null;
  return name;
}

/** A date as yyyy-mm-dd that is a real calendar day; null otherwise. */
function realDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

/** The address as typed → the tidy address, or the field and the words that refuse it. */
export function validateAddress(raw: unknown, lang: Lang): { ok: true; address: Address } | { ok: false; error: string; field: string } {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const text = (k: string, max: number) => (typeof o[k] === "string" ? (o[k] as string).replace(/\s+/g, " ").trim().slice(0, max + 1) : "");
  const bad = (key: "street" | "city" | "state" | "zip") => ({ ok: false as const, error: MSG[key][lang], field: `address.${key}` });
  const street = text("street", 100);
  if (street.length < 5 || street.length > 100 || !/\p{L}/u.test(street) || !/^[\p{L}\p{M}\d .,#'’\/&\-]+$/u.test(street)) return bad("street");
  const city = text("city", 60);
  if (city.length < 2 || city.length > 60 || !/^[\p{L}\p{M}][\p{L}\p{M} .'’\-]*$/u.test(city)) return bad("city");
  const state = text("state", 2).toUpperCase();
  if (!US_STATES.has(state)) return bad("state");
  const zip = text("zip", 10);
  if (!/^\d{5}(-\d{4})?$/.test(zip)) return bad("zip");
  return { ok: true, address: { street, city, state, zip, tidied: o["tidied"] === true } };
}

/**
 * What the details page sends: `travelers` (1 to 4 of {legal_name, dob}), `address` ({street, city, state, zip, tidied}) and `concierge` ({room, priority,
 * budget, motion}). Every refusal carries the same words as the page's red note and the `field` it belongs to. The names are tidied (extra spaces dropped)
 * and must be a first AND last name of letters, spaces, hyphens and apostrophes; a birthday is a real date, not in the future, and under 120 years ago.
 * The number of travelers may differ from `guests` (people change their minds): any 1 to 4 is accepted, and `count` says how many came.
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
    const one = list[i];
    const o = one && typeof one === "object" && !Array.isArray(one) ? (one as Record<string, unknown>) : {};
    const name = tidyLegalName(o["legal_name"]);
    if (!name) return bad(MSG.name[lang], `travelers.${i}.legal_name`);
    const dobText = typeof o["dob"] === "string" ? o["dob"].trim() : "";
    const dob = dobText ? realDate(dobText) : null;
    if (!dob || dob.getTime() > today || dob.getTime() <= oldest) return bad(MSG.dob[lang], `travelers.${i}.dob`);
    travelers.push({ legal_name: name, dob: dobText });
  }

  const a = validateAddress(raw["address"], lang);
  if (!a.ok) return bad(a.error, a.field);

  const c = raw["concierge"];
  const ans = c && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
  const within = <T extends string>(v: unknown, set: readonly T[]): T | null => (typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : null);
  const room = within(ans["room"], ROOMS), priority = within(ans["priority"], PRIORITIES), budget = within(ans["budget"], BUDGETS), motion = within(ans["motion"], MOTIONS);
  if (!room) return bad(MSG.concierge[lang], "concierge.room");
  if (!priority) return bad(MSG.concierge[lang], "concierge.priority");
  if (!budget) return bad(MSG.concierge[lang], "concierge.budget");
  if (!motion) return bad(MSG.concierge[lang], "concierge.motion");
  return { ok: true, travelers, address: a.address, concierge: { room, priority, budget, motion }, count: travelers.length };
}

/** Just the four answers (the pick route asks for them alone): the Concierge, or the plain refusal. */
export function validateConcierge(body: unknown, lang: Lang = "en"): { ok: true; concierge: Concierge } | { ok: false; error: string; field: string } {
  const raw = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const stored = storedConcierge(raw["concierge"]);
  return stored ? { ok: true, concierge: stored } : { ok: false, error: MSG.concierge[lang], field: "concierge" };
}

/** Road A's "when": one of the four answers, or null. */
export function validCallWhen(v: unknown): CallWhen | null {
  return typeof v === "string" && (CALL_WHENS as readonly string[]).includes(v) ? (v as CallWhen) : null;
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
  if (typeof o["category"] !== "string" || typeof o["where"] !== "string" || typeof o["why"] !== "string") return null;
  const u = o["upgrade"] && typeof o["upgrade"] === "object" ? (o["upgrade"] as Record<string, unknown>) : null;
  const upgrade = u && typeof u["category"] === "string" && typeof u["hook"] === "string" ? { category: u["category"], hook: u["hook"] } : null;
  return { category: o["category"], where: o["where"], why: o["why"], upgrade };
}

/** The address a reply holds, or null for anything that is not a full one. */
export function storedAddress(v: unknown): Address | null {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
  return s("street") && s("city") && s("state") && s("zip") ? { street: s("street"), city: s("city"), state: s("state"), zip: s("zip"), tidied: o["tidied"] === true } : null;
}

/** The legal name split the way the group file keeps it: the LAST space divides first from last ("Mary Ann Smith" → "Mary Ann", "Smith"); one word is a first name only. */
export function splitLegalName(name: string): { first: string; last: string | null } {
  const clean = name.replace(/\s+/g, " ").trim();
  const cut = clean.lastIndexOf(" ");
  return cut < 0 ? { first: clean, last: null } : { first: clean.slice(0, cut), last: clean.slice(cut + 1) };
}

// ── The two emails ────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What both emails share: the guest, the group as they know it, who signs, and where the logos are served from. */
interface MailBase {
  firstName: string;
  /** What the guest knows the group as (the page's name, else the group's). */
  groupLabel: string;
  /** Who signs: "Mark & Ceci", else "Mark". */
  hostNames: string;
  lang: Lang;
  /** The site the logos are loaded from (the box's own, so the email works on dev and on prod). */
  publicSite: string;
}

/** The yellow, card-on-navy frame of both emails (the approved designs): logo, label, title, the paragraphs, the signature, the footer line. `body` is already escaped html. */
function mailFrame(i: MailBase, title: string, body: string, footer: string): string {
  const logo = `${site(i.publicSite)}${BUSINESS.logoPath}`;
  const cornerstone = `${site(i.publicSite)}/assets/images/cornerstone-white.png`;
  const sign = i.hostNames.trim() || "Mark";
  return `<div style="margin:0;padding:0;background:#07183f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07183f"><tr><td align="center" style="padding:22px 16px 10px">
  <img src="${esc(logo)}" alt="Still Afloat" width="150" style="display:block;width:150px;height:auto"></td></tr>
<tr><td align="center" style="padding:6px 16px 24px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#f7fbff;border-radius:18px"><tr><td style="padding:26px 26px 18px">
    <p style="margin:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#9a6b00;font-weight:bold">${esc(i.groupLabel.trim())}</p>
    <h1 style="margin:0 0 14px;font-family:Georgia,'Times New Roman',serif;font-weight:normal;font-size:30px;line-height:1.15;color:#07183f">${esc(title)}</h1>
    ${body}
    <p style="margin:0 0 18px;font-family:Georgia,'Times New Roman',serif;font-size:24px;color:#9a6b00">${esc(sign)}</p>
  </td></tr></table></td></tr>
<tr><td align="center" style="padding:0 16px 26px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px"><tr>
    <td style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#c9d3e8">${esc(BUSINESS.legalName)}<br>${esc(footer)}</td>
    <td align="right" valign="bottom" style="padding-left:12px"><img src="${esc(cornerstone)}" alt="" width="44" style="display:block;width:44px;height:auto"></td>
  </tr></table></td></tr></table></div>`;
}

const para = (html: string) => `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:1.5;color:#07183f">${html}</p>`;

// ── Road A: "Good call… literally!" ───────────────────────────────────────────

export interface CallInput extends MailBase {
  /** When the guest said Mark can catch them. */
  when: CallWhen;
  /** The number Mark rings from (callerPhone). */
  phone: string;
}

/** "mornings" … "whenever works": how the email repeats the guest's answer back ("… {this}, like you said."). */
const WHEN_PHRASE: Record<CallWhen, Record<Lang, string>> = {
  morning: { en: "mornings", es: "por la mañana" },
  afternoon: { en: "afternoons", es: "por la tarde" },
  evening: { en: "evenings", es: "por la noche" },
  anytime: { en: "whenever works", es: "cuando le quede bien" },
};
/** The same answer for Mark's list: "Ring Mark Millham · party of 2 · evenings". */
export const WHEN_WORD: Record<CallWhen, string> = { morning: "mornings", afternoon: "afternoons", evening: "evenings", anytime: "whenever" };

const CALL = {
  en: {
    subject: (label: string) => `Good call… literally! ${label}`,
    title: "Good call… literally!",
    hi: (first: string) => `Hi ${first},`,
    p1: (phone: string, when: string) => `Smart move… the best cruise decisions happen over a phone call, not a scroll bar! Mark will ring you within a day from [[${phone}]]… ${when}, like you said. Save the number now, or you'll send him to voicemail like everyone does… twice.`,
    p2: "No homework. Bring your questions and your maybes. He'll go over your choices, jot down the names and birthdays, and hold your spot before you hang up. Nothing is charged until you say the word. The only thing to decide tonight: coffee on the balcony, or coffee on the balcony.",
    p3: "One smart-cruiser move while you wait: dig out everyone's passport and check the expiry date. Renewals take weeks, and your paperwork page will ask for the number later.",
    p4: "Can't wait? Call or text him first… he'll pretend he wasn't sitting by the phone.",
    p5: (area: string | null) => `Cruise smarter, laugh more… and pick up when the ${area ? `${area} number` : "number"} rings!`,
    footer: (label: string) => `You got this email because you saved your spot on our ${label} page and asked Mark to talk you into it. Not you? Reply and we'll take you off.`,
  },
  es: {
    subject: (label: string) => `Buena decisión… ¡la llamada va en camino! ${label}`,
    title: "Buena decisión… ¡y la llamada va en camino!",
    hi: (first: string) => `Hola ${first}:`,
    p1: (phone: string, when: string) => `Qué buena idea… ¡las mejores decisiones de un crucero se toman por teléfono, no con el dedo en la pantalla! Mark le llamará en un día desde el [[${phone}]]… ${when}, como usted dijo. Guarde el número ahora, o lo mandará al buzón de voz como todo el mundo… dos veces.`,
    p2: "Nada de tarea. Traiga sus preguntas y sus dudas. Mark repasará con usted sus opciones, anotará los nombres y las fechas de nacimiento, y apartará su lugar antes de colgar. No se cobra nada hasta que usted diga la palabra. Lo único que hay que decidir esta noche: café en el balcón, o café en el balcón.",
    p3: "Una jugada inteligente mientras espera: saque el pasaporte de cada quien y revise la fecha de vencimiento. Las renovaciones tardan semanas, y su página de documentos le pedirá el número más adelante.",
    p4: "¿No puede esperar? Llámelo o escríbale primero… él hará como que no estaba sentado junto al teléfono.",
    p5: (area: string | null) => `Navegue con inteligencia, ría más… ¡y conteste cuando suene el ${area ? `número ${area}` : "teléfono"}!`,
    footer: (label: string) => `Recibió este correo porque apartó su lugar en nuestra página de ${label} y pidió que Mark lo convenciera. ¿No fue usted? Responda y le quitamos de la lista.`,
  },
} as const;

/**
 * Road A's ONE email (approved design, go-packets "Road A · Talk me into it", cell 3, 2026-10-24): "Good call… literally!", who rings, from what number, when
 * (in the guest's own answer), the no-homework promise, the one smart-cruiser move (the passports), the brand line and the signature, and the footer with
 * "Not you? Reply and we'll take you off." No cabin names and no prices, ever: the guest saw them on the page. Every value that came from a person or
 * a file is escaped; there is no link in it (nothing to open: the next move is Mark's call).
 */
export function callEmail(i: CallInput): { subject: string; html: string; text: string } {
  const T = CALL[i.lang];
  const first = i.firstName.trim();
  const label = i.groupLabel.trim();
  const when = WHEN_PHRASE[i.when][i.lang];
  const area = areaCode(i.phone);
  const p1 = T.p1(i.phone, when);
  const sign = i.hostNames.trim() || "Mark";
  const text = [T.hi(first), p1.replace(/\[\[|\]\]/g, ""), T.p2, T.p3, T.p4, T.p5(area), sign, `${BUSINESS.legalName}\n${T.footer(label)}`].join("\n\n") + "\n";
  const p1Html = esc(p1).replace(/\[\[(.*?)\]\]/, (_m, n: string) => `<b>${n}</b>`);
  const body = [para(esc(T.hi(first))), para(p1Html), para(esc(T.p2)), para(esc(T.p3)), para(esc(T.p4)), para(esc(T.p5(area)))].join("\n    ");
  return { subject: T.subject(label), html: mailFrame(i, T.title, body, T.footer(label)), text };
}

// ── Road B: "Your cabin is on hold… nicely done!" ─────────────────────────────

export interface HoldInput extends MailBase {
  /** The pick: the category and where on the ship, as the page showed them. */
  category: string;
  where: string;
  /** The first name of each traveler, in the order they were listed. */
  travelerFirstNames: readonly string[];
  /** The guest's private link: "Open my details". */
  detailsUrl: string;
}

const HOLD = {
  en: {
    subject: (label: string) => `Your cabin is on hold… nicely done! ${label}`,
    title: "Your cabin is on hold… nicely done!",
    hi: (first: string) => `Hi ${first},`,
    p1: "You planned a cruise in three minutes. Some people take three months and still end up next to the elevator.",
    p2: (cabin: string, names: string) => `Here's what you did: [[${cabin}]], for ${names}. Mark confirms it with the cruise line within a day, and your paperwork follows. Nothing is charged tonight.`,
    passports: (n: number) => (n <= 1
      ? "One smart-cruiser move while you wait: dig out your passport and check the expiry date. Renewals take weeks, and your paperwork page will ask for the number."
      : `One smart-cruiser move while you wait: dig out ${n === 2 ? "both passports" : "everyone's passport"} and check the expiry dates. Renewals take weeks, and your paperwork page will ask for the numbers.`),
    change: "Need to change a name, a birthday or your mind?",
    open: "Open my details",
    close: "Cruise smarter, laugh more… see you at the muster drill!",
    footer: (label: string) => `You got this email because you put your cabin on hold on our ${label} page. Not you? Reply and we'll take you off.`,
  },
  es: {
    subject: (label: string) => `Su cabina está apartada… ¡bien hecho! ${label}`,
    title: "Su cabina está apartada… ¡bien hecho!",
    hi: (first: string) => `Hola ${first}:`,
    p1: "Usted planeó un crucero en tres minutos. Hay quien tarda tres meses y aun así termina junto al elevador.",
    p2: (cabin: string, names: string) => `Esto es lo que hizo: [[${cabin}]], para ${names}. Mark la confirma con la naviera en un día, y sus documentos le llegan después. No se cobra nada esta noche.`,
    passports: (n: number) => (n <= 1
      ? "Una jugada inteligente mientras espera: saque su pasaporte y revise la fecha de vencimiento. Las renovaciones tardan semanas, y su página de documentos le pedirá el número."
      : `Una jugada inteligente mientras espera: saque ${n === 2 ? "los dos pasaportes" : "el pasaporte de cada quien"} y revise las fechas de vencimiento. Las renovaciones tardan semanas, y su página de documentos le pedirá los números.`),
    change: "¿Necesita cambiar un nombre, una fecha de nacimiento o de opinión?",
    open: "Abrir mis datos",
    close: "Navegue con inteligencia, ría más… ¡nos vemos en el simulacro de seguridad!",
    footer: (label: string) => `Recibió este correo porque apartó su cabina en nuestra página de ${label}. ¿No fue usted? Responda y le quitamos de la lista.`,
  },
} as const;

/**
 * Road B's ONE email (approved design, go-packets "Road B · I've got this", cell 4, 2026-10-24): a laugh about how fast they were, what they did (the
 * category and where, for the travelers by first name), what Mark does next, the passport move ("both passports", "everyone's passport" for more than two),
 * the way back to their details (the yellow "Open my details" button), the brand line, the signature and the footer. No prices: the deposit, the totals and
 * the category prices were on the page they came from. Every value is escaped; the link appears only in the body it is sent to.
 */
export function holdEmail(i: HoldInput): { subject: string; html: string; text: string } {
  const T = HOLD[i.lang];
  const first = i.firstName.trim();
  const label = i.groupLabel.trim();
  const cabin = `${i.category}, ${i.where}`;
  const names = joinNames(i.travelerFirstNames.map((n) => n.trim()).filter(Boolean), i.lang);
  const n = Math.max(i.travelerFirstNames.length, 1);
  const p2 = T.p2(cabin, names);
  const sign = i.hostNames.trim() || "Mark";
  const text = [T.hi(first), T.p1, p2.replace(/\[\[|\]\]/g, ""), T.passports(n), `${T.change} ${T.open}: ${i.detailsUrl}`, T.close, sign, `${BUSINESS.legalName}\n${T.footer(label)}`].join("\n\n") + "\n";
  const button = `<a href="${esc(i.detailsUrl)}" style="display:inline-block;margin-left:6px;background:#f5c33b;color:#07183f;font-weight:bold;border-radius:999px;padding:10px 18px;text-decoration:none;font-size:16px">${esc(T.open)}</a>`;
  const body = [
    para(esc(T.hi(first))), para(esc(T.p1)),
    para(esc(p2).replace(/\[\[(.*?)\]\]/, (_m, c: string) => `<b>${c}</b>`)),
    para(esc(T.passports(n))),
    para(`${esc(T.change)} ${button}`),
    para(esc(T.close)),
  ].join("\n    ");
  return { subject: T.subject(label), html: mailFrame(i, T.title, body, T.footer(label)), text };
}
