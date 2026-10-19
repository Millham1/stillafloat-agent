// booking-terms.ts — the parts of reading a quote that code does better than a
// model (Mark 2026-10-05: the reader "missed the deposits and payment dates").
//
// Measured on the first real quote (MSC, 5 pages): a model asked for the whole
// record put prices in the wrong column, did date arithmetic wrong and invented
// two deadlines. So:
//   * Dates that the document gives as "N days prior to sailing" are found by
//     pattern and worked out here from the sail date. A model never does the sum.
//   * A long document is cut into short sections (prices, payments,
//     cancellation, the header) so the AI box answers each in seconds.
//   * Every number and date a model returns must be printed in the document.
//     If it is not, the field is blanked and a plain warning says why. A blank
//     on the form is honest; a guess is not.

import { normalizeDate, type BookingExtraction, type CabinCategoryLine } from "./booking-extract";

export interface AllotmentReview {
  date: string | null;             // YYYY-MM-DD
  days_before: number | null;
  percent_retaken: number | null;  // share of the UNSOLD cabins the line takes back
  note: string | null;             // a special condition, in the document's words
}

export interface CancellationRow {
  from_days: number | null;        // days before sailing the row starts (the larger number)
  to_days: number | null;
  from_date: string | null;        // worked out from the sail date
  to_date: string | null;
  penalty: string | null;          // as printed
  percent: number | null;          // null when the penalty is the deposit
}

export interface Deadline {
  date: string | null;
  days_before: number;
  text: string;                    // the document's sentence
}

const DAY_MS = 86_400_000;

export function addDays(ymd: string, days: number): string | null {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + days * DAY_MS).toISOString().slice(0, 10);
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A money figure as quotes print it: "$1,234.56", "$403", or a bare "468.79" — MSC's group
 * quotator prints no dollar signs at all (Mark's Millham F/F 2027 quote, 2026-10-18). A bare
 * figure counts only with two decimals and at least two digits before the point, so a date,
 * a time, a percentage, a count or a "68/68/68/0" fee column never passes for one.
 */
const MONEY_FIGURE = /\$\s?\d[\d,]*(?:\.\d+)?|(?<![\d.,])(?:\d{1,3}(?:,\d{3})+|\d{2,})\.\d{2}(?!\d|[.,]\d)/g;

/** The money figures on a line, as numbers, in the order they are printed. */
const figuresOf = (line: string): number[] => (line.match(MONEY_FIGURE) ?? []).map((f) => Number(f.replace(/[$,\s]/g, "")));

/** Is this amount printed in the document? 575.8 matches "$575.80" (or a bare "575.80"); 403 does not match "403.50" or "1403". */
export function moneyAppears(text: string, n: number): boolean {
  if (!Number.isFinite(n)) return false;
  const [int, dec] = Math.abs(n).toFixed(2).split(".") as [string, string];
  const intPat = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",?");
  const decPat = dec === "00" ? "(?:\\.00)?" : dec.endsWith("0") ? `\\.${dec[0]}0?` : `\\.${dec}`;
  return new RegExp(`(?<![\\d.,])${intPat}${decPat}(?!\\d|[.,]\\d)`).test(text);
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Is this date printed in the document, in any of the ways quotes print dates? */
export function dateAppears(text: string, ymd: string): boolean {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [y, mo, d] = [m[1]!, +m[2]!, +m[3]!];
  const mon = MONTH_NAMES[mo - 1]!;
  const pats = [
    `(?<!\\d)${ymd}(?!\\d)`,
    `(?<![\\d/])0?${mo}/0?${d}/(?:${y}|${y.slice(2)})(?!\\d)`,
    `(?<!\\d)0?${d}\\s+(?:de\\s+)?${mon}[a-z]*\\.?,?\\s+(?:de\\s+)?${y}`,
    `\\b${mon}[a-z]*\\.?\\s+0?${d}(?:st|nd|rd|th)?,?\\s+${y}`,
  ];
  return pats.some((p) => new RegExp(p, "i").test(text));
}

const DAYS_BEFORE = /\b(\d{1,3})\s+days?\s+(?:prior\s+to|before)\s+(?:the\s+|your\s+)?(?:sailing|sail|departure|cruise|embarkation)(?:\s+date)?/i;
const PRINTED_DATE = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/;

function sentences(text: string): string[] {
  return collapse(text).split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/).map((s) => s.trim()).filter(Boolean);
}

/** Drop a glued-on ALL-CAPS section heading from the front of a sentence. */
function stripHeading(s: string): string {
  return s.replace(/^[A-Z][A-Z ,&/()'-]{4,}(?=\s+(?:\d|[A-Z](?:[a-z]|\s[a-z])))\s+/, "");
}

export interface FoundDeadlines {
  reviews: AllotmentReview[];
  deadlines: Deadline[];
  finalPaymentDays: number | null;
  warnings: string[];
}

/**
 * Every "N days prior to sailing" sentence in the document, sorted into the
 * allotment reviews (the line takes unsold cabins back), the final payment and
 * everything else. Dates come from the sail date; a printed date wins and a
 * disagreement is reported.
 */
export function findDeadlines(text: string, sailDate: string | null): FoundDeadlines {
  const all = sentences(text);
  const out: FoundDeadlines = { reviews: [], deadlines: [], finalPaymentDays: null, warnings: [] };
  const seen = new Set<string>();
  for (let i = 0; i < all.length; i++) {
    const s = all[i]!;
    const m = s.match(DAYS_BEFORE);
    if (!m) continue;
    const days = Number(m[1]);
    if (!Number.isInteger(days) || days < 1 || days > 400) continue;
    const computed = sailDate ? addDays(sailDate, -days) : null;
    const printed = normalizeDate(s.slice(m.index ?? 0).match(PRINTED_DATE)?.[1] ?? null);
    if (printed && computed && printed !== computed) {
      out.warnings.push(`The document prints ${printed} for "${days} days before sailing", but ${days} days before ${sailDate} is ${computed}. The printed date was kept; check it.`);
    }
    const date = printed ?? computed;

    const after: string[] = [];
    for (let j = i + 1; j < all.length && after.length < 2; j++) {
      if (DAYS_BEFORE.test(all[j]!)) break;
      after.push(all[j]!);
    }
    // Judge by the words around the match: table text has no full stops, so a
    // "sentence" can carry a whole unrelated table in front of it.
    const near = s.slice(Math.max(0, (m.index ?? 0) - 160));
    const context = [near, ...after].join(" ");
    const isFinal = /final payment|balance (?:is )?due/i.test(near);
    const isReview = !isFinal && /review|retaken|recall|releas/i.test(context) && /allotment|unsold|inventory/i.test(context);

    if (isFinal) {
      if (out.finalPaymentDays === null) out.finalPaymentDays = days;
      continue;
    }
    if (isReview) {
      const percents = [...context.matchAll(/(\d{1,3})\s?%/g)].map((p) => Number(p[1]));
      const ofUnsold = context.match(/(\d{1,3})\s?%\s+of\s+the\s+(?:remaining\s+)?unsold/i);
      const condition = [near, ...after].filter((x) => /\bif (?:no|none)\b/i.test(x)).map(stripHeading).join(" ");
      out.reviews.push({
        date,
        days_before: days,
        percent_retaken: ofUnsold ? Number(ofUnsold[1]) : percents.length ? percents[percents.length - 1]! : null,
        note: condition || null,
      });
      continue;
    }
    const lead = (m.index ?? 0) > 200 ? `…${s.slice((m.index ?? 0) - 200).replace(/^\S*\s/, "")}` : stripHeading(s);
    const textOut = lead.slice(0, 280);
    const key = `${days}|${textOut.slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.deadlines.push({ date, days_before: days, text: textOut });
  }
  out.reviews.sort((a, b) => (b.days_before ?? 0) - (a.days_before ?? 0));
  out.deadlines.sort((a, b) => b.days_before - a.days_before);
  out.deadlines = out.deadlines.slice(0, 20);
  return out;
}

// ── Sections ──────────────────────────────────────────────────────────────────

/** A document at or under this size is read in one question; a longer one by section. */
export const WHOLE_DOCUMENT_CHARS = 8_000;
const SECTION_CHARS = 5_000;
/** A section under this many characters says too little to answer from. */
const SECTION_MIN_CHARS = 200;

/**
 * The lines that match, each with some lines around it, in document order. `after` may be a
 * function when some lines (a row of column labels whose values follow below) need more room.
 */
export function sliceLines(text: string, hit: (line: string) => boolean, before: number, after: number | ((line: string) => number), maxChars = SECTION_CHARS): string {
  const lines = text.split("\n");
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (!hit(line)) return;
    const ahead = typeof after === "function" ? after(line) : after;
    for (let j = Math.max(0, i - before); j <= Math.min(lines.length - 1, i + ahead); j++) keep.add(j);
  });
  let out = "";
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const piece = (last >= 0 && i > last + 1 ? "[...]\n" : "") + lines[i] + "\n";
    if (out.length + piece.length > maxChars) break;
    out += piece;
    last = i;
  }
  return out.trim();
}

const amounts = (line: string) => (line.match(MONEY_FIGURE) ?? []).length;

/** How many money figures a line carries (with or without a dollar sign). */
export const countMoneyFigures = amounts;

/** How many rows of a price table a section holds (a row carries three or more money figures). */
export const rateRowCount = (section: string): number => section.split("\n").filter((l) => amounts(l) >= 3).length;

/**
 * MSC's group quotator header: "category double Rates 3rd/4th Adult Rate 3rd/4th Child Rate
 * 3rd/4th Jr Child Rate". Its rows are code, name, cabins held, SEVEN rates (double; 3rd, 4th
 * adult; 3rd, 4th child; 3rd, 4th junior child) and a "68/68/68/0" column of taxes and fees for
 * guests 1 to 4. No dollar signs, no total column.
 */
const DOUBLE_RATE_HEADER = /double\s+rates?\b[\s\S]{0,40}?3rd\/4th\s+adult[\s\S]{0,40}?3rd\/4th\s+child[\s\S]{0,40}?3rd\/4th\s+(?:jr|junior)\.?\s+child/i;
export const isDoubleRateTable = (text: string): boolean => DOUBLE_RATE_HEADER.test(text);

export interface Sections { basics: string; rates: string; payments: string; cancellation: string
  /** Lines about air, hotel-before and transfers (fly & cruise packages) — Mark 2026-10-10. */
  travel: string;
}

/** What a browser prints around a saved page (the stamp and the address line), which is not the quote. */
const PRINT_NOISE = /^\s*(?:https?:\/\/\S.*|\d{1,2}\/\d{1,2}\/\d{2,4},\s+\d{1,2}:\d{2}\s?[AP]M\b.*)$/i;

const DATE_IN_LINE = /\b\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}\b|\b[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;
const WEEKDAY = /\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i;
/** A port-call row: a weekday or a day number, a date, and a 24-hour time or "--:--" ("3 Tue 11 May 2027 Ocean Cay …, Bahamas 08:00 --:--"). */
const itineraryRow = (l: string) =>
  DATE_IN_LINE.test(l) && /\b\d{1,2}:\d{2}\b|--:--/.test(l) && (WEEKDAY.test(l) || /^\s*\d{1,2}\s/.test(l));

/** Words that mark the labels of the header block of a quote (all on short lines; prose that merely mentions a ship does not). */
const BASICS_LABEL = new RegExp([
  "\\bship(?: name)?\\b", "sailing date", "sail date", "embark", "group (?:id|name|number|#)", "\\bitinerary\\b", "\\bnights?\\b", "duration",
  "attention:", "amenit", "booking (?:number|#)", "confirmation (?:number|#)", "cruise line",
  // The MSC group quotator (2026-10-18): a row of column labels, then the values, and a SUMMARY block of "Label value" lines.
  "\\b(?:departure|arrival)\\s*:", "\\bdestination\\b",
  "^\\s*(?:group\\s+)?(?:classification|dining)\\b", "^\\s*(?:packages?|cabins|total rate|expire[sd]?\\s+on|create[ds]?\\s+on)\\b",
  "^\\s*day\\s+date\\s+port\\b",
].join("|"), "i");

/**
 * The quote cut into the short parts the AI box answers in seconds. A SHORT document is its own
 * section: whatever comes out under SECTION_MIN_CHARS for the header, the prices or the payments
 * is the whole text instead, so the box is never asked about an empty or near-empty section
 * (Mark's quotator, 2026-10-18: the cut found nothing, the box answered two empty questions and
 * the sail date came out as the date the quote was created). The cancellation and air/hotel
 * sections stay empty when the document says nothing about them, and are then not asked.
 */
export function cutSections(text: string): Sections {
  const clean = text.split("\n").filter((l) => !PRINT_NOISE.test(l)).join("\n");
  const lines = clean.split("\n");
  // Price table: its rows carry several money figures (with or without a dollar sign); the column headers sit above them.
  const rows = lines.map((l, i) => (amounts(l) >= 3 ? i : -1)).filter((i) => i >= 0);
  let rates = "";
  if (rows.length) {
    const end = rows[rows.length - 1]!;
    // The header sits just above the first row. It is never trimmed away to make the section fit.
    let header = -1;
    for (let i = rows[0]! - 1; i >= Math.max(0, rows[0]! - 4); i--) {
      if (amounts(lines[i]!) === 0 && /\b(?:rates?|fares?|price|adult|child|double|category|cabin|stateroom|occupancy|allotment)\b/i.test(lines[i]!)) { header = i; break; }
    }
    const keepFrom = header >= 0 ? header : rows[0]!;
    let start = Math.max(0, rows[0]! - 45);
    let block = lines.slice(start, end + 2).join("\n");
    while (block.length > SECTION_CHARS && start < keepFrom) block = lines.slice(++start, end + 2).join("\n");
    rates = block.trim();
  }
  const dayRange = (l: string) => /\d+\s*[–—-]\s*\d+\s+days|\d+\s+days or more/i.test(l);
  const hasTable = lines.some(dayRange);
  const s: Sections = {
    basics: sliceLines(
      clean,
      (l) => (l.length <= 120 && BASICS_LABEL.test(l)) || /\b\d{1,2}:\d{2}\s?(?:am|pm)\b/i.test(l) || itineraryRow(l),
      0,
      // A row of column labels ("Destination: Departure: Arrival: Ship: Duration (Nights):") has its values on the lines below it.
      (l) => (/departure\s*:/i.test(l) && /arrival\s*:/i.test(l) ? 6 : 1),
    ),
    rates,
    payments: sliceLines(clean, (l) => !dayRange(l) && /deposit|final payment|balance|payment (?:is |are )?due|names?\b.{0,40}\bdue|paid in full/i.test(l), 1, 1),
    // The table rows themselves when there is a table; else the sentences about cancelling.
    cancellation: hasTable
      ? sliceLines(clean, dayRange, 4, 2)
      : sliceLines(clean, (l) => /cancel|penalt|non-?refundable/i.test(l), 1, 1),
    // Air, hotel before the cruise, transfers (a fly & cruise or hotel package printed on the quote).
    travel: sliceLines(clean, (l) => /\b(air|airfare|flights?|fly\b|hotel|pre-?cruise|post-?cruise|transfers?|shuttle|motor ?coach)\b/i.test(l) && !/\bbalcony|interior|suite\b/i.test(l), 1, 1),
  };
  if (text.length <= WHOLE_DOCUMENT_CHARS) {
    for (const k of ["basics", "rates", "payments"] as const) if (s[k].length < SECTION_MIN_CHARS) s[k] = clean.trim();
  }
  return s;
}

// ── Checking a model's answer against the document ────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;

const eq = (a: number, b: number) => Math.abs(a - b) < 0.005;

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The price-table row that carries this category: by its code as a whole word first (so "BA" is not found inside "Balcony"), then by its name. */
function rateLine(text: string, c: CabinCategoryLine): string | null {
  const lines = text.split("\n").filter((l) => amounts(l) >= 3);
  if (c.code && c.code.length >= 2) {
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(c.code)}(?![A-Za-z0-9])`, "i");
    const hit = lines.find((l) => re.test(l));
    if (hit) return hit;
  }
  const name = c.category && c.category.length >= 2 ? c.category.toLowerCase() : null;
  return (name && lines.find((l) => l.toLowerCase().includes(name))) || null;
}

/** The money figures (with or without a dollar sign) on the price-table row that carries this category's code or name. */
function rateRow(text: string, c: CabinCategoryLine): number[] | null {
  const line = rateLine(text, c);
  return line ? figuresOf(line) : null;
}

interface DoubleRateRow {
  count: number | null;       // cabins held: the whole number right before the first rate
  rates: number[];            // the seven rates, in the header's order
  fees: number[];             // taxes and fees for guests 1 to 4 ("68/68/68/0")
}

/** One row of the quotator's double-rate table, or null when the row does not have the shape the header promises. */
function doubleRateRow(line: string | null): DoubleRateRow | null {
  if (!line) return null;
  const rates = figuresOf(line);
  const feeCol = line.match(/(?<![\d./])(\d+(?:\.\d{1,2})?(?:\/\d+(?:\.\d{1,2})?){3})(?=\s|$)/);
  if (rates.length !== 7 || !feeCol) return null;
  const first = new RegExp(MONEY_FIGURE.source).exec(line);
  const count = first ? line.slice(0, first.index).match(/\s(\d{1,4})\s*$/) : null;
  return { count: count ? Number(count[1]) : null, rates, fees: feeCol[1]!.split("/").map(Number) };
}

/**
 * A model reads the right row but can take a figure from the wrong column. A
 * rate row is arithmetic: total = fare + non-commissionable + tax. So the
 * columns are settled by the sums that work, not by the model's choice.
 * The MSC quotator has no totals to add up: its columns are settled by position
 * under the printed header (see doubleRateRow).
 */
function checkCategory(c: CabinCategoryLine, text: string, flat: string, groupDeposit: number | null, warnings: string[], doubleRate: boolean): CabinCategoryLine {
  const label = [c.code, c.category].filter(Boolean).join(" ") || "a cabin category";
  const out = { ...c };
  const row = rateRow(text, c);
  const inRow = (n: number | null) => n !== null && !!row && row.some((r) => eq(r, n));
  const derived = new Set<keyof CabinCategoryLine>();

  const dr = doubleRate ? doubleRateRow(rateLine(text, c)) : null;
  if (dr) {
    // What the printed row says wins over what the model put in each box.
    const put = (k: keyof CabinCategoryLine, v: number | null, what: string) => {
      if (v === null) return;
      if (out[k] !== null && out[k] !== v) warnings.push(`${label}: ${what} was read as ${out[k]}, but the printed row has ${v}. ${v} was used.`);
      (out[k] as number | null) = v;
    };
    const [dbl, ad3, ad4, ch3, ch4, jr3, jr4] = dr.rates as [number, number, number, number, number, number, number];
    put("count", dr.count, "the number of cabins held");
    put("commissionable_fare", dbl, "the double rate");
    put("price_third_fourth_adult", eq(ad3, ad4) ? ad3 : null, "the 3rd/4th adult rate");
    put("price_child", eq(ch3, ch4) ? ch3 : null, "the 3rd/4th child rate");
    put("price_junior_child", eq(jr3, jr4) ? jr3 : null, "the 3rd/4th junior-child rate");
    const tax = dr.fees[0] === dr.fees[1] ? dr.fees[0]! : null;
    put("taxes", tax, "the taxes and fees");
    out.ncf = null;                         // the double rate already includes the NCF; no separate NCF column is printed
    if (out.deposit_per_person !== null) {
      warnings.push(`${label}: the deposit per person was read as ${out.deposit_per_person}, but the quote prints no deposit on the row. Left blank.`);
      out.deposit_per_person = null;
    }
    // Rate and taxes are printed apart, and adding two printed figures is not a guess.
    if (out.commissionable_fare !== null && out.taxes !== null) {
      const total = round2(out.commissionable_fare + out.taxes);
      if (out.price_per_person !== null && out.price_per_person !== total) {
        warnings.push(`${label}: the price per person was read as ${out.price_per_person}; the double rate ${out.commissionable_fare} plus taxes and fees ${out.taxes} is ${total}. ${total} was used.`);
      }
      out.price_per_person = total;
      derived.add("price_per_person");
      warnings.push("This quote prints the double rate and the taxes and fees apart. The price per person is the double rate plus the taxes and fees, added up here from the two printed figures; the 3rd/4th guest figures are the printed rates, before taxes and fees. Check against the PDF.");
    }
  } else if (row && inRow(out.commissionable_fare)) {
    const fare = out.commissionable_fare!;
    const sums = (total: number) => {
      const pairs: Array<[number, number]> = [];
      for (let i = 0; i < row.length; i++) for (let j = i + 1; j < row.length; j++) {
        if (eq(fare + row[i]! + row[j]!, total) && !pairs.some((p) => eq(p[0], row[i]!) && eq(p[1], row[j]!))) pairs.push([row[i]!, row[j]!]);
      }
      return pairs;
    };
    // The total is the row figure the fare adds up to; prefer the model's when it works.
    const totals = [out.price_per_person, ...row].filter((t): t is number => t !== null && t > fare && inRow(t) && sums(t).length === 1);
    const total = totals[0] ?? null;
    if (total !== null) {
      const [ncf, tax] = sums(total)[0]!;
      if (out.price_per_person !== total) {
        warnings.push(`${label}: the price per person was read as ${out.price_per_person ?? "blank"}, but fare ${fare} + non-commissionable ${ncf} + tax ${tax} = ${total} on that row. ${total} was used; check it against the PDF.`);
      }
      out.price_per_person = total;
      out.ncf = ncf;
      out.taxes = tax;
      // Extra-guest totals: the other figures on the row that are a fare plus the same fees.
      const extra = row.filter((p, i) => !eq(p, total) && row.indexOf(p) === i
        && row.some((f) => f > 0 && !eq(f, p) && (eq(f + ncf + tax, p) || (row.some((z) => z === 0) && eq(f + tax, p)))));
      if (extra.length === 3) {
        [out.price_third_fourth_adult, out.price_child, out.price_junior_child] = [extra[0]!, extra[1]!, extra[2]!];
      }
    }
  }
  // A deposit read off the fare table is a fare-table figure, not a deposit.
  if (groupDeposit !== null && (out.deposit_per_person === null || (out.deposit_per_person !== groupDeposit && inRow(out.deposit_per_person)))) {
    out.deposit_per_person = groupDeposit;
  }
  const money: Array<keyof CabinCategoryLine> = [
    "price_per_person", "deposit_per_person", "commissionable_fare", "ncf", "taxes",
    "price_third_fourth_adult", "price_child", "price_junior_child",
  ];
  for (const k of money) {
    const v = out[k] as number | null;
    if (v !== null && !derived.has(k) && !moneyAppears(flat, v)) {
      warnings.push(`${label}: ${String(k).replace(/_/g, " ")} was read as ${v}, which is not printed in the document. Left blank.`);
      (out[k] as number | null) = null;
    }
  }
  if (out.commissionable_fare !== null && out.ncf !== null && out.taxes !== null && out.price_per_person !== null
    && !eq(out.commissionable_fare + out.ncf + out.taxes, out.price_per_person)) {
    warnings.push(`${label}: fare ${out.commissionable_fare} + non-commissionable ${out.ncf} + tax ${out.taxes} does not equal the price per person ${out.price_per_person}. Check this row against the PDF.`);
  }
  return out;
}

// "-" and "--:--" both mean "no time here"; a bare clock time is 24-hour ("08:00") or 12-hour ("4:00 PM").
const TIME = /(?<=\s)(?:[-–—]+(?::[-–—]+)?|\d{1,2}:\d{2}\s?(?:[ap]m)?)(?=\s|$)/gi;
function clock(tok: string): string | null {
  const m = tok.match(/^(\d{1,2}):(\d{2})\s?([ap]m)?$/i);
  if (!m) return null;
  let h = +m[1]!;
  if (m[3]) h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
  return h < 24 ? `${String(h).padStart(2, "0")}:${m[2]}` : null;
}

/**
 * Arrival and departure straight off the itinerary row ("-" means none), so a dash cannot shift the columns.
 * A row with ONE time is the first call (the ship leaves) or the last (the ship arrives): the quotator prints
 * no dash for the time that does not exist.
 */
function stopTimes(text: string, port: string | null, date: string | null, place: "first" | "last" | "middle"): { arrive: string | null; depart: string | null } | null {
  if (!port || !date) return null;
  const name = port.toLowerCase().split(",")[0]!.trim();
  const line = text.split("\n").find((l) => l.toLowerCase().includes(name) && dateAppears(l, date) && /\d{1,2}:\d{2}/.test(l));
  if (!line) return null;
  const toks = line.slice(line.toLowerCase().indexOf(name) + name.length).match(TIME) ?? [];
  if (toks.length >= 2) return { arrive: clock(toks[0]!), depart: clock(toks[1]!) };
  const only = toks.length === 1 ? clock(toks[0]!) : null;
  if (only && place === "first") return { arrive: null, depart: only };
  if (only && place === "last") return { arrive: only, depart: null };
  return null;
}

/** The dates a quote prints about itself ("Create on 18 Oct 2026", "Expire on 03 Nov 2026"): never a sailing date. */
function quoteAdminDates(text: string): Array<{ label: string; date: string }> {
  const out: Array<{ label: string; date: string }> = [];
  const re = /\b(create[ds]?\s+on|expire[sd]?\s+on|expir(?:y|ation)\s+date|valid\s+(?:until|through|till)|quote\s+date)\s*:?\s*(\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/gi;
  for (const m of text.matchAll(re)) {
    const date = normalizeDate(m[2]!);
    if (date) out.push({ label: `${m[1]!.replace(/\s+/g, " ")} ${m[2]!}`, date });
  }
  return out;
}

/** The group total and the commission a quote prints in its summary block, for the notes. */
export function quoteTotals(text: string): { total: number | null; commission: string | null } {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => /^\s*total\s+rate\b/i.test(l));
  if (i < 0) return { total: null, commission: null };
  const total = figuresOf(lines[i]!)[0] ?? null;
  // The label of the percentage does not come through in the PDF text: it stands alone on a line under the total.
  const pct = lines.slice(i + 1, i + 5).map((l) => l.match(/^\s*(\d{1,2}(?:\.\d+)?)\s?%\s*$/)).find(Boolean);
  return { total, commission: pct ? `${pct[1]} %` : null };
}

/** Is this amount printed on, or right beside, a line that talks about the deposit? (A taxes column also prints "68".) */
function depositPrinted(text: string, n: number): boolean {
  const lines = text.split("\n");
  return lines.some((l, i) => /deposit/i.test(l) && moneyAppears(collapse(lines.slice(Math.max(0, i - 1), i + 2).join(" ")), n));
}

/**
 * The gate between a model's answer and the confirmation form. Blanks anything
 * not printed in the document, replaces every "N days before sailing" date
 * with the worked-out one, and lists what it changed in `warnings`.
 */
export function verifyExtraction(x: BookingExtraction, text: string): BookingExtraction {
  const flat = collapse(text);
  const warnings = [...x.warnings];
  const out: BookingExtraction = { ...x };
  const doubleRate = isDoubleRateTable(flat);

  // The date a quote was created, or the date it expires, is not a sailing date (the quotator, 2026-10-18).
  const admin = quoteAdminDates(text);
  out.itinerary = out.itinerary
    .map((s) => (s.date && (!dateAppears(flat, s.date) || admin.some((a) => a.date === s.date)) ? { ...s, date: null } : s))
    .map((s, i, all) => ({ ...s, ...(stopTimes(text, s.port, s.date, i === 0 ? "first" : i === all.length - 1 ? "last" : "middle") ?? {}) }));

  const dateField = (k: "sail_date" | "return_date" | "deposit_due" | "names_due" | "recall_date", name: string) => {
    const v = out[k];
    if (v && !dateAppears(flat, v)) {
      warnings.push(`${name} was read as ${v}, which is not printed in the document. Left blank.`);
      out[k] = null;
    }
  };
  dateField("sail_date", "Sail date");
  if (out.return_date && !dateAppears(flat, out.return_date)) {
    const fromNights = out.sail_date && out.nights ? addDays(out.sail_date, out.nights) : null;
    if (fromNights !== out.return_date) dateField("return_date", "Return date");
  }
  for (const [k, name] of [["sail_date", "Sail date"], ["return_date", "Return date"]] as const) {
    const hit = out[k] ? admin.find((a) => a.date === out[k]) : undefined;
    if (hit) {
      warnings.push(`${name} was read as ${out[k]}, which is the date printed in "${hit.label}", not a sailing date. Left blank.`);
      out[k] = null;
    }
  }
  // Day 1 of the itinerary is the day the ship sails; a printed date is a printed date.
  const dayOne = out.itinerary.find((s) => s.day === 1 && s.date);
  if (!out.sail_date && dayOne) {
    out.sail_date = dayOne.date;
    warnings.push(`The sail date was blank; day 1 of the itinerary (${dayOne.date}) was used.`);
  }
  if (!out.return_date && out.sail_date && out.nights) out.return_date = addDays(out.sail_date, out.nights);
  dateField("deposit_due", "Deposit deadline");
  dateField("names_due", "Names-due date");

  for (const k of ["deposit_per_person", "total_price"] as const) {
    const v = out[k];
    if (v !== null && !moneyAppears(flat, v)) {
      warnings.push(`${k === "deposit_per_person" ? "Deposit per person" : "Total price"} was read as ${v}, which is not printed in the document. Left blank.`);
      out[k] = null;
    }
  }
  if (doubleRate && out.deposit_per_person !== null && !depositPrinted(text, out.deposit_per_person)) {
    warnings.push(`Deposit per person was read as ${out.deposit_per_person}, but no line about the deposit prints that amount. Left blank.`);
    out.deposit_per_person = null;
  }
  const heldBefore = out.cabin_categories.reduce((n, c) => n + (c.count ?? 0), 0);
  out.cabin_categories = out.cabin_categories.map((c) => checkCategory(c, text, flat, out.deposit_per_person, warnings, doubleRate));
  const held = out.cabin_categories.reduce((n, c) => n + (c.count ?? 0), 0);
  if (out.cabins_held === heldBefore && held !== heldBefore) out.cabins_held = held;   // it was only the rows' sum, and a row was corrected
  // The quotator's summary prints the block's size on its own line ("Cabins 12"); the rows must add up to it.
  const printedCabins = text.match(/^\s*cabins\s+(\d{1,4})\s*$/im);
  if (printedCabins) {
    const n = Number(printedCabins[1]);
    if (held > 0 && n !== held) warnings.push(`The quote says Cabins ${n}, but the category rows add up to ${held}. Check the cabins held on each row.`);
    if (doubleRate && out.cabins_held !== n) out.cabins_held = n;
  }
  if (out.deposit_timing === "at_booking" && !/(?:at|upon|with)\s+(?:the\s+)?(?:time\s+of\s+)?booking/i.test(flat)) out.deposit_timing = null;
  if (out.deposit_timing === "by_date" && !out.deposit_due) out.deposit_timing = null;
  if (out.deposit_timing === "at_booking") out.deposit_due = null;

  // Deadlines: found by pattern, dated by arithmetic.
  const found = findDeadlines(text, out.sail_date);
  warnings.push(...found.warnings);
  // Guest inclusions: keep one only when the document prints its distinctive words (the model must not invent a perk).
  out.guest_inclusions = (out.guest_inclusions ?? []).filter((inc) => {
    const words = inc.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    const ok = words.length > 0 && words.some((w) => flat.includes(w));
    if (!ok) warnings.push(`Guest inclusion "${inc}" is not printed in the document. Left out.`);
    return ok;
  });
  // Travel package (air / hotel before / transfers): every price must be printed in the document.
  if (out.travel_package) {
    const tp = { ...out.travel_package };
    const checkPrice = (label: string, v: number | null): number | null => {
      if (v !== null && !moneyAppears(flat, v)) { warnings.push(`${label} price was read as ${v}, which is not printed in the document. Left blank.`); return null; }
      return v;
    };
    if (tp.air) tp.air = { ...tp.air, price_per_person: checkPrice("Air", tp.air.price_per_person) };
    if (tp.hotel_before) tp.hotel_before = { ...tp.hotel_before, price_per_person: checkPrice("Hotel before the cruise", tp.hotel_before.price_per_person) };
    tp.transfers = tp.transfers.map((t) => ({ ...t, price_per_person: checkPrice(`Transfer ${t.route.replace(/_/g, " ")}`, t.price_per_person) }));
    out.travel_package = tp;
  }
  out.deadlines = found.deadlines;
  if (found.reviews.length) {
    out.allotment_reviews = found.reviews;
  } else {
    out.allotment_reviews = out.allotment_reviews
      .map((r) => {
        const worked = out.sail_date && r.days_before ? addDays(out.sail_date, -r.days_before) : null;
        const date = r.date && dateAppears(flat, r.date) ? r.date : worked;
        return { ...r, date };
      })
      .filter((r) => r.date);
  }
  if (out.allotment_reviews.length) {
    const reviews = out.allotment_reviews;
    out.recall_date = (reviews.find((r) => r.percent_retaken === 100 && !r.note) ?? reviews[reviews.length - 1]!).date;
  } else {
    dateField("recall_date", "The date unsold cabins go back");
  }

  const days = found.finalPaymentDays ?? out.final_payment_days_before;
  if (found.finalPaymentDays !== null && out.final_payment_days_before !== null && found.finalPaymentDays !== out.final_payment_days_before) {
    warnings.push(`Final payment: the document says ${found.finalPaymentDays} days before sailing; the reader said ${out.final_payment_days_before}. ${found.finalPaymentDays} was used.`);
  }
  out.final_payment_days_before = days;
  const worked = days !== null && out.sail_date ? addDays(out.sail_date, -days) : null;
  if (out.final_payment_due && dateAppears(flat, out.final_payment_due)) {
    if (worked && worked !== out.final_payment_due) {
      warnings.push(`Final payment: the document prints ${out.final_payment_due}, but ${days} days before sailing is ${worked}. The printed date was kept; check it.`);
    }
  } else {
    if (out.final_payment_due && !worked) warnings.push(`Final payment date was read as ${out.final_payment_due}, which is not printed in the document. Left blank.`);
    out.final_payment_due = worked;
  }

  out.cancellation_schedule = out.cancellation_schedule
    .filter((r) => {
      const ok = (n: number | null) => n === null || new RegExp(`(?<!\\d)${n}(?!\\d)`).test(flat);
      const good = (r.from_days !== null || r.to_days !== null) && ok(r.from_days) && ok(r.to_days) && (r.percent === null || new RegExp(`(?<!\\d)${r.percent}\\s?%`).test(flat));
      if (!good) warnings.push(`A cancellation row (${r.from_days ?? "?"} to ${r.to_days ?? "?"} days, ${r.penalty ?? "no penalty read"}) does not match the document. Left out.`);
      return good;
    })
    .map((r) => {
      const hi = r.from_days !== null && r.to_days !== null ? Math.max(r.from_days, r.to_days) : r.from_days;
      const lo = r.from_days !== null && r.to_days !== null ? Math.min(r.from_days, r.to_days) : r.to_days;
      return {
        ...r,
        from_days: hi,
        to_days: lo,
        from_date: out.sail_date && hi !== null ? addDays(out.sail_date, -hi) : null,
        to_date: out.sail_date && lo !== null ? addDays(out.sail_date, -lo) : null,
      };
    })
    .sort((a, b) => (b.from_days ?? 9999) - (a.from_days ?? 9999));

  // The group total and the commission have no field on the file; they go in the notes so nothing is lost.
  const totals = quoteTotals(text);
  const noted: string[] = [];
  if (totals.total !== null && !moneyAppears(out.notes ?? "", totals.total)) {
    noted.push(`Group total rate $${totals.total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}, as printed on the quote.`);
  }
  if (totals.commission && !/commission/i.test(out.notes ?? "")) noted.push(`Commission ${totals.commission}, printed on its own line under the total rate.`);
  if (noted.length) out.notes = [out.notes, ...noted].filter(Boolean).join(" ");

  out.warnings = [...new Set(warnings)];
  return out;
}
