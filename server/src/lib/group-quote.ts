// group-quote.ts — the quote step between the names and the paperwork (Mark 2026-11-01: "there has to be an intermediary step … the email the client
// receives the button should say Let's begin! then the discussion is which cabin, do they want to use flexpay, drink package (if not included), insurance,
// do they need a hotel/ air/ transfers? once those are answered and the quote is agreed to then the documentation is sent").
//
// Everything here is read from the group file: the categories the group holds and their fares (groups.terms.cabin_categories, else the cabin's own
// price), the cruise line's protection plan and the Allianz plans as Mark typed them (line_protection, insurance_plans), the air / hotel / transfer offer
// (group_travel rows with no traveler), the deposit and the final payment date. A figure the file does not have is never made up: the line says Mark
// quotes it and the total says "plus …". FlexPay is Mark's own installment plan, offered apart from the cruise line (Mark 2026-11-01: "the flexpay
// option is not msc. i can offer it separately"; "i will not know the terms until the client completes the app, which we need to do separately"): the
// step asks only whether they want the application, and promises no terms.
import { QUOTE_NOTE, planLabel, plansFromText } from "./allianz-quote";
import { displayName, formatDate, formatMoney, priceUnitOf, travelLabel, type Lang, type PriceUnit } from "./group-marketing";
import type { Traveler } from "./group-details";

type Row = Record<string, any>;

export interface QuoteFile { group: Row; cabins: Row[]; travel: Row[] }
export type TravelKind = "flight" | "hotel" | "transfer";
export const TRAVEL_KINDS: readonly TravelKind[] = ["flight", "hotel", "transfer"];

export interface CabinOption {
  /** What the page sends back: the category code, else the category's name as a slug. */
  key: string;
  category: string;
  code: string | null;
  perPerson: number | null;
  perPersonText: string | null;
  /** The reduced fares for the third and fourth travelers on the cabin, when the file has them. */
  thirdFourthAdult: number | null;
  juniorChild: number | null;
  child: number | null;
  taxes: number | null;
  taxesIncluded: boolean;
  available: number;
  /** "Balcony Bella · $536.79 per person · taxes and port fees included" */
  label: string;
}
export interface InsuranceOption { key: string; label: string; name: string | null; perPerson: number | null }
export interface TravelOption { key: string; kind: TravelKind; label: string; text: string; perUnit: number | null; unit: PriceUnit; included: boolean }
export interface QuoteOptions {
  cabins: CabinOption[];
  drinks: "ask" | "included";
  insurance: InsuranceOption[];
  travel: TravelOption[];
  /** The kinds the group has no offer for: asked as a yes/no ("Do you need flights?"), priced by Mark. */
  needs: TravelKind[];
  depositPerPerson: number | null;
  depositPerPersonText: string | null;
  finalPaymentText: string | null;
}

export interface QuoteAnswers {
  cabin: string;
  flexpay: boolean;
  /** null when the fare includes a package (the question is not asked). */
  drinks: boolean | null;
  insurance: string;
  travel: string[];
  needs: Partial<Record<TravelKind, boolean>>;
}
export interface QuoteLine {
  key: string;
  label: string;
  detail: string | null;
  amount: number | null;
  amountText: string | null;
  /** Mark prices this one: the total says "plus …". */
  toQuote: boolean;
}
export interface Quote {
  version: 1;
  computed_at: string;
  answers: QuoteAnswers;
  category: string;
  cabinKey: string;
  party: number;
  lines: QuoteLine[];
  total: number;
  totalText: string;
  toQuote: string[];
  deposit: number | null;
  depositText: string | null;
  depositPerPersonText: string | null;
  balance: number | null;
  balanceText: string | null;
  finalPaymentText: string | null;
  note: string;
  flexpay: boolean;
  /** Set when the guest agrees: where the paperwork went. */
  paperwork?: "booking" | "sent" | "held" | "no-email" | "failed";
  cabin_id?: string | null;
}

const W = {
  en: {
    perPerson: "per person", perRoom: "per room", taxesIn: "taxes and port fees included", plusTaxes: (t: string) => `plus ${t} taxes and port fees per person`,
    noPrice: "Mark quotes it", included: "included in the cruise price",
    linePlan: (name: string, price: string) => `${name} · ${price} per person`,
    allianz: (name: string, price: string) => `${name} (Allianz) · ${price} per person`,
    insQuote: "Yes, quote me the cruise line's plan and Allianz", insOwn: "I have my own policy", insNone: "No insurance for us",
    cabinLine: (cat: string, n: number) => `${cat} · ${n === 1 ? "one traveler" : `${n} travelers`}`,
    each: "each", thirdFourth: "third or fourth guest fare", junior: "junior fare", child: "child fare", fareToQuote: "the fare for this cabin is not on the file yet",
    taxesLine: (n: number) => `Taxes and port fees · ${n === 1 ? "one traveler" : `${n} travelers`}`,
    insuranceLine: "Travel insurance", insOwnLine: "Travel insurance: your own policy", insNoneLine: "Travel insurance: none",
    insQuoteDetail: "Mark quotes the cruise line's plan and Allianz for your party", perPersonTimes: (p: string, n: number) => `${p} per person × ${n}`,
    drinksLine: "Drink package", drinksDetail: "Mark prices it for your party", drinksIncluded: "Drinks: a package is included in your fare",
    needLine: { flight: "Flights", hotel: "Hotel", transfer: "Transfers" } as Record<TravelKind, string>, needDetail: "Mark quotes them for your party",
    flexLine: "FlexPay", flexDetail: "You pick the time of a brief video call with Mark to apply; it sets its own payment schedule and changes nothing on this quote",
    note: `Every figure comes from the group's file with the cruise line, and Mark confirms each one with you before anything is charged. ${QUOTE_NOTE}`,
  },
  es: {
    perPerson: "por persona", perRoom: "por habitación", taxesIn: "impuestos y tasas portuarias incluidos", plusTaxes: (t: string) => `más ${t} de impuestos y tasas portuarias por persona`,
    noPrice: "Mark lo cotiza", included: "incluido en el precio del crucero",
    linePlan: (name: string, price: string) => `${name} · ${price} por persona`,
    allianz: (name: string, price: string) => `${name} (Allianz) · ${price} por persona`,
    insQuote: "Sí, cotíceme el plan de la naviera y Allianz", insOwn: "Tengo mi propia póliza", insNone: "Sin seguro para nosotros",
    cabinLine: (cat: string, n: number) => `${cat} · ${n === 1 ? "un viajero" : `${n} viajeros`}`,
    each: "cada uno", thirdFourth: "tarifa de tercer o cuarto pasajero", junior: "tarifa junior", child: "tarifa de niño", fareToQuote: "la tarifa de esta cabina aún no está en el expediente",
    taxesLine: (n: number) => `Impuestos y tasas portuarias · ${n === 1 ? "un viajero" : `${n} viajeros`}`,
    insuranceLine: "Seguro de viaje", insOwnLine: "Seguro de viaje: su propia póliza", insNoneLine: "Seguro de viaje: ninguno",
    insQuoteDetail: "Mark cotiza el plan de la naviera y Allianz para su grupo", perPersonTimes: (p: string, n: number) => `${p} por persona × ${n}`,
    drinksLine: "Paquete de bebidas", drinksDetail: "Mark lo cotiza para su grupo", drinksIncluded: "Bebidas: su tarifa incluye un paquete",
    needLine: { flight: "Vuelos", hotel: "Hotel", transfer: "Traslados" } as Record<TravelKind, string>, needDetail: "Mark los cotiza para su grupo",
    flexLine: "FlexPay", flexDetail: "Usted elige la hora de una videollamada breve con Mark para solicitarlo; fija su propio calendario de pagos y no cambia nada en esta cotización",
    note: `Cada cifra viene del expediente del grupo con la naviera, y Mark confirma cada una con usted antes de cobrar nada. Los precios pueden cambiar hasta que se finalicen.`,
  },
} as const;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const LIVE = new Set(["held", "offered"]);

/** The file's line for a cabin category: matched by code, else by name (case and spacing aside). */
function termsFor(group: Row, code: string | null, category: string): Row | null {
  const cats: Row[] = Array.isArray(group.terms?.cabin_categories) ? group.terms.cabin_categories : [];
  const byCode = code ? cats.find((c) => typeof c["code"] === "string" && c["code"].trim().toUpperCase() === code.trim().toUpperCase()) : undefined;
  if (byCode) return byCode;
  const want = slug(category);
  return cats.find((c) => typeof c["category"] === "string" && slug(c["category"]) === want) ?? null;
}

/** What the group's `inclusions` say about drinks: a package is included when a line names one. */
export function drinksIncluded(group: Row): boolean {
  const list: unknown[] = Array.isArray(group.inclusions) ? group.inclusions : [];
  return list.some((x) => typeof x === "string" && /drink|beverage|bebida|easy\s*(plus|package)|premium extra/i.test(x));
}

/** What the page offers, from the file alone. */
export function quoteOptions(file: QuoteFile, lang: Lang): QuoteOptions {
  const T = W[lang];
  const g = file.group;
  const taxesIncluded = g.marketing?.taxes_included !== false;

  const byKey = new Map<string, CabinOption>();
  for (const c of file.cabins) {
    if (!LIVE.has(String(c.status)) || !c.category) continue;
    const category = displayName(String(c.category));
    const code = typeof c.category_code === "string" && c.category_code.trim() ? c.category_code.trim() : null;
    const key = code ?? slug(category);
    const have = byKey.get(key);
    if (have) { have.available++; continue; }
    const t = termsFor(g, code, category);
    const total = num(c.price_total);
    const perPerson = num(t?.["price_per_person"]) ?? (total !== null && total > 0 ? round2(total / 2) : null);
    const taxes = num(t?.["taxes"]);
    const perPersonText = formatMoney(perPerson);
    const taxNote = taxesIncluded ? T.taxesIn : taxes !== null ? T.plusTaxes(formatMoney(taxes)!) : null;
    byKey.set(key, {
      key, category, code, perPerson, perPersonText,
      thirdFourthAdult: num(t?.["price_third_fourth_adult"]), juniorChild: num(t?.["price_junior_child"]), child: num(t?.["price_child"]),
      taxes, taxesIncluded, available: 1,
      label: [category, perPersonText ? `${perPersonText} ${T.perPerson}` : T.noPrice, taxNote].filter(Boolean).join(" · "),
    });
  }
  const cabins = [...byKey.values()].sort((a, b) => (a.perPerson ?? Infinity) - (b.perPerson ?? Infinity));

  const insurance: InsuranceOption[] = [];
  const line = plansFromText(g.line_protection)[0];
  if (line) insurance.push({ key: "line", label: T.linePlan(line.name, formatMoney(line.price_per_person)!), name: line.name, perPerson: line.price_per_person });
  plansFromText(g.insurance_plans).forEach((p, i) => insurance.push({ key: `allianz-${i}`, label: T.allianz(p.name, formatMoney(p.price_per_person)!), name: p.name, perPerson: p.price_per_person }));
  if (!insurance.length) insurance.push({ key: "quote", label: T.insQuote, name: null, perPerson: null });
  insurance.push({ key: "own", label: T.insOwn, name: null, perPerson: null }, { key: "decline", label: T.insNone, name: null, perPerson: null });

  const travel: TravelOption[] = [];
  for (const r of file.travel) {
    if (r.traveler_id || r.cabin_id) continue;
    const kind = r.kind as TravelKind;
    if (!TRAVEL_KINDS.includes(kind) || typeof r.id !== "string") continue;
    const perUnit = num(r.price_per_person);
    const unit = priceUnitOf(r);
    const included = r.included === true;
    const label = travelLabel(r, lang);
    // Mark 2026-11-07: no flight, hotel or transfer price is shown before he finalizes the quote; the offer is named, and "included" when it is
    travel.push({ key: r.id, kind, label, text: included ? `${label} · ${T.included}` : label, perUnit, unit, included });
  }
  const needs = TRAVEL_KINDS.filter((k) => !travel.some((t) => t.kind === k));

  const dep = num(g.deposit_per_person);
  return {
    cabins, drinks: drinksIncluded(g) ? "included" : "ask", insurance, travel, needs,
    depositPerPerson: dep !== null && dep > 0 ? dep : null, depositPerPersonText: dep !== null && dep > 0 ? formatMoney(dep) : null,
    finalPaymentText: formatDate(g.final_payment_due, lang),
  };
}

const ASK = {
  en: { cabin: "Pick a cabin, please.", flexpay: "Yes or no on FlexPay, please.", drinks: "Yes or no on the drink package, please.", insurance: "Pick one of the insurance choices, please.", travel: "One of those travel choices is not on this group.", needs: (k: string) => `Yes or no on the ${k}, please.` },
  es: { cabin: "Elija una cabina, por favor.", flexpay: "Sí o no a FlexPay, por favor.", drinks: "Sí o no al paquete de bebidas, por favor.", insurance: "Elija una de las opciones de seguro, por favor.", travel: "Una de esas opciones de viaje no es de este grupo.", needs: (k: string) => `Responda sí o no sobre ${k}, por favor.` },
} as const;
const NEED_WORD = { en: { flight: "flights", hotel: "hotel", transfer: "transfers" }, es: { flight: "los vuelos", hotel: "el hotel", transfer: "los traslados" } } as const;

/** The guest's answers, checked against what the page offered: every answer is one of the options, nothing else gets through. */
export function validateQuoteAnswers(body: unknown, o: QuoteOptions, lang: Lang): { ok: true; answers: QuoteAnswers } | { ok: false; error: string; field: string } {
  const A = ASK[lang];
  const b = body && typeof body === "object" ? (body as Row) : {};
  const a = b["answers"] && typeof b["answers"] === "object" ? (b["answers"] as Row) : b;
  const cabin = typeof a["cabin"] === "string" ? a["cabin"] : "";
  if (!o.cabins.some((c) => c.key === cabin)) return { ok: false, error: A.cabin, field: "cabin" };
  if (typeof a["flexpay"] !== "boolean") return { ok: false, error: A.flexpay, field: "flexpay" };
  let drinks: boolean | null = null;
  if (o.drinks === "ask") {
    if (typeof a["drinks"] !== "boolean") return { ok: false, error: A.drinks, field: "drinks" };
    drinks = a["drinks"];
  }
  const insurance = typeof a["insurance"] === "string" ? a["insurance"] : "";
  if (!o.insurance.some((i) => i.key === insurance)) return { ok: false, error: A.insurance, field: "insurance" };
  const travelRaw = Array.isArray(a["travel"]) ? a["travel"] : [];
  const travel: string[] = [];
  for (const k of travelRaw) {
    if (typeof k !== "string" || !o.travel.some((t) => t.key === k)) return { ok: false, error: A.travel, field: "travel" };
    if (!travel.includes(k)) travel.push(k);
  }
  const needsRaw = a["needs"] && typeof a["needs"] === "object" ? (a["needs"] as Row) : {};
  const needs: Partial<Record<TravelKind, boolean>> = {};
  for (const k of o.needs) {
    if (typeof needsRaw[k] !== "boolean") return { ok: false, error: A.needs(NEED_WORD[lang][k]), field: `need-${k}` };
    needs[k] = needsRaw[k];
  }
  return { ok: true, answers: { cabin, flexpay: a["flexpay"], drinks, insurance, travel, needs } };
}

/** Whole years between a birth date and a day (the sail date); null when either is not a date. */
export function ageOn(dob: unknown, day: unknown): number | null {
  const b = typeof dob === "string" && /^\d{4}-\d{2}-\d{2}/.test(dob) ? new Date(dob.slice(0, 10) + "T00:00:00Z") : null;
  const d = typeof day === "string" && /^\d{4}-\d{2}-\d{2}/.test(day) ? new Date(day.slice(0, 10) + "T00:00:00Z") : null;
  if (!b || !d || !Number.isFinite(b.getTime()) || !Number.isFinite(d.getTime())) return null;
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  if (d.getUTCMonth() < b.getUTCMonth() || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

const firstWordOf = (s: string) => s.trim().split(/\s+/)[0] ?? "";

/**
 * The fare for each traveler, in the order they were listed: the first two pay the cabin's per-person fare, the third and fourth the file's reduced fares
 * by age at sailing (18 and over the third-and-fourth-guest fare, 12 to 17 the junior fare, under 12 the child fare), falling back to the per-person
 * fare when the file lacks the reduced one. null when the file has no fare at all.
 */
export function fares(c: CabinOption, travelers: readonly Traveler[], sailDate: unknown): Array<{ amount: number | null; tag: "full" | "thirdFourth" | "junior" | "child" }> {
  return travelers.map((t, i) => {
    if (i < 2) return { amount: c.perPerson, tag: "full" };
    const age = ageOn(t.dob, sailDate);
    if (age !== null && age < 12) return { amount: c.child ?? c.perPerson, tag: "child" };
    if (age !== null && age < 18) return { amount: c.juniorChild ?? c.child ?? c.thirdFourthAdult ?? c.perPerson, tag: "junior" };
    return { amount: c.thirdFourthAdult ?? c.perPerson, tag: "thirdFourth" };
  });
}

/** The quote the page shows, from the file and the answers. Never a figure the file does not have. */
export function buildQuote(file: QuoteFile, travelers: readonly Traveler[], answers: QuoteAnswers, lang: Lang, now: Date = new Date()): Quote {
  const T = W[lang];
  const o = quoteOptions(file, lang);
  const cabin = o.cabins.find((c) => c.key === answers.cabin);
  if (!cabin) throw new Error("quote: the cabin is not one of the group's");
  const n = Math.max(travelers.length, 1);
  const lines: QuoteLine[] = [];
  const money = (x: number) => formatMoney(round2(x))!;

  // the cabin
  const perTraveler = fares(cabin, travelers, file.group.sail_date);
  if (perTraveler.some((f) => f.amount === null)) {
    lines.push({ key: "cabin", label: T.cabinLine(cabin.category, n), detail: T.fareToQuote, amount: null, amountText: null, toQuote: true });
  } else {
    const sum = perTraveler.reduce((s, f) => s + f.amount!, 0);
    const parts = perTraveler.map((f, i) => {
      const who = firstWordOf(travelers[i]!.legal_name);
      const tag = f.tag === "thirdFourth" ? ` (${T.thirdFourth})` : f.tag === "junior" ? ` (${T.junior})` : f.tag === "child" ? ` (${T.child})` : "";
      return `${who} ${money(f.amount!)}${tag}`;
    });
    const detail = [parts.join(" · "), cabin.taxesIncluded ? T.taxesIn : null].filter(Boolean).join(" · ");
    lines.push({ key: "cabin", label: T.cabinLine(cabin.category, n), detail, amount: round2(sum), amountText: money(sum), toQuote: false });
    if (!cabin.taxesIncluded && cabin.taxes !== null) {
      lines.push({ key: "taxes", label: T.taxesLine(n), detail: T.perPersonTimes(money(cabin.taxes), n), amount: round2(cabin.taxes * n), amountText: money(cabin.taxes * n), toQuote: false });
    }
  }

  // drinks
  if (o.drinks === "included") lines.push({ key: "drinks", label: T.drinksIncluded, detail: null, amount: 0, amountText: T.included, toQuote: false });
  else if (answers.drinks === true) lines.push({ key: "drinks", label: T.drinksLine, detail: T.drinksDetail, amount: null, amountText: null, toQuote: true });

  // insurance
  const ins = o.insurance.find((i) => i.key === answers.insurance);
  if (ins) {
    if (ins.key === "own") lines.push({ key: "insurance", label: T.insOwnLine, detail: null, amount: null, amountText: null, toQuote: false });
    else if (ins.key === "decline") lines.push({ key: "insurance", label: T.insNoneLine, detail: null, amount: null, amountText: null, toQuote: false });
    else if (ins.perPerson === null) lines.push({ key: "insurance", label: T.insuranceLine, detail: T.insQuoteDetail, amount: null, amountText: null, toQuote: true });
    else lines.push({ key: "insurance", label: `${T.insuranceLine}: ${ins.name}`, detail: T.perPersonTimes(money(ins.perPerson), n), amount: round2(ins.perPerson * n), amountText: money(ins.perPerson * n), toQuote: false });
  }

  // getting there and back
  for (const key of answers.travel) {
    const t = o.travel.find((x) => x.key === key);
    if (!t) continue;
    // Mark 2026-11-07: the file's travel price is never on the starting price; every flight, hotel and transfer waits for his finalized quote
    if (t.included) lines.push({ key: `travel-${key}`, label: t.label, detail: null, amount: 0, amountText: T.included, toQuote: false });
    else lines.push({ key: `travel-${key}`, label: t.label, detail: T.noPrice, amount: null, amountText: null, toQuote: true });
  }
  for (const k of o.needs) if (answers.needs[k] === true) lines.push({ key: `need-${k}`, label: T.needLine[k], detail: T.needDetail, amount: null, amountText: null, toQuote: true });

  // FlexPay: a yes is a request for the application, nothing more
  if (answers.flexpay) lines.push({ key: "flexpay", label: T.flexLine, detail: T.flexDetail, amount: null, amountText: null, toQuote: false });

  const total = round2(lines.reduce((s, l) => s + (l.amount ?? 0), 0));
  const toQuote = lines.filter((l) => l.toQuote).map((l) => l.label);
  const deposit = o.depositPerPerson !== null ? round2(o.depositPerPerson * n) : null;
  const balance = deposit !== null ? round2(Math.max(total - deposit, 0)) : null;
  return {
    version: 1, computed_at: now.toISOString(), answers, category: cabin.category, cabinKey: cabin.key, party: n,
    lines, total, totalText: money(total), toQuote,
    deposit, depositText: deposit !== null ? money(deposit) : null, depositPerPersonText: o.depositPerPersonText,
    balance, balanceText: balance !== null ? money(balance) : null, finalPaymentText: o.finalPaymentText,
    note: T.note, flexpay: answers.flexpay,
  };
}

/** A stored quote, or null for anything that is not one. */
export function storedQuote(v: unknown): Quote | null {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null;
  if (!o || o["version"] !== 1 || !o["answers"] || typeof o["answers"] !== "object" || !Array.isArray(o["lines"]) || typeof o["category"] !== "string") return null;
  return o as unknown as Quote;
}

/** One line for Mark's list: the cabin, what they said yes to, the total and what he still prices. */
export function quoteSummary(q: Quote, o: QuoteOptions): string {
  const parts: string[] = [q.category];
  parts.push(`FlexPay ${q.answers.flexpay ? "yes" : "no"}`);
  if (o.drinks === "ask") parts.push(`drinks ${q.answers.drinks ? "yes" : "no"}`);
  const ins = o.insurance.find((i) => i.key === q.answers.insurance);
  parts.push(`insurance: ${ins ? (ins.name ?? (ins.key === "quote" ? "quote both" : ins.key === "own" ? "own policy" : "none")) : q.answers.insurance}`);
  const travel = q.answers.travel.map((k) => o.travel.find((t) => t.key === k)?.label).filter((x): x is string => !!x);
  const needs = o.needs.filter((k) => q.answers.needs[k] === true).map((k) => `${k} (quote)`);
  if (travel.length || needs.length) parts.push([...travel, ...needs].join(", "));
  parts.push(`total ${q.totalText}${q.toQuote.length ? ` + ${q.toQuote.length} to price` : ""}`);
  return parts.join(" · ");
}

/** The first cabin of the chosen category with nobody on it yet: where the travelers go when the quote is agreed. null when every one is taken. */
export function freeCabinFor(cabins: readonly Row[], option: CabinOption, usedCabinIds: ReadonlySet<string>): Row | null {
  for (const c of cabins) {
    if (!LIVE.has(String(c.status)) || usedCabinIds.has(String(c.id))) continue;
    const code = typeof c.category_code === "string" && c.category_code.trim() ? c.category_code.trim() : null;
    const key = code ?? slug(displayName(String(c.category ?? "")));
    if (key === option.key) return c;
  }
  return null;
}


/** What the guest chose for flights, hotels and transfers, kept on the lead's file when the quote is agreed (Mark 2026-11-03: the booking
 *  agreement's pre/post-cruise lines come from the quote). Rows are the group's own offers; "needs" are the kinds the guest asked Mark to quote. */
export interface TripRow { kind: TravelKind; direction: string | null; from_place: string | null; to_place: string | null; provider: string | null; starts_at: string | null; ends_at: string | null; label: string }
export interface Trip { chosen: TripRow[]; needs: Partial<Record<TravelKind, boolean>> }
export function tripOf(travel: Array<Record<string, unknown>>, answers: QuoteAnswers): Trip {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const chosen: TripRow[] = [];
  for (const r of travel) {
    const kind = r["kind"] as TravelKind;
    if (!TRAVEL_KINDS.includes(kind) || typeof r["id"] !== "string" || !answers.travel.includes(r["id"])) continue;
    chosen.push({ kind, direction: str(r["direction"]), from_place: str(r["from_place"]), to_place: str(r["to_place"]), provider: str(r["provider"]), starts_at: str(r["starts_at"]), ends_at: str(r["ends_at"]), label: travelLabel(r as never, "en") });
  }
  return { chosen, needs: answers.needs };
}

/** The insurance answer on the quote, as the paperwork keeps it (form_data.insurance): the insurance step then opens with the
 *  guest's own choice already made, and the packet carries the right document from the start (Mark 2026-11-06: "insurance is
 *  asked again inside the paperwork with nothing preselected"). The plan text is the one the paperwork offers, so the choice
 *  stands as made; the guest can still change it on the page. */
export function insuranceSeedOf(options: QuoteOptions, answers: QuoteAnswers, lineProtection: unknown): { choice: "quote" | "line" | "own" | "decline"; plan: string | null } | null {
  const o = options.insurance.find((i) => i.key === answers.insurance);
  if (!o) return null;
  if (o.key === "own" || o.key === "decline") return { choice: o.key, plan: null };
  // the line's plan is kept as Mark typed it on the file, the same text the page's own choice keeps (chooseInsurance)
  if (o.key === "line") return { choice: "line", plan: typeof lineProtection === "string" && lineProtection.trim() ? lineProtection.trim() : null };
  return { choice: "quote", plan: o.name && o.perPerson !== null ? planLabel({ name: o.name, price_per_person: o.perPerson }) : null };
}
