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

/** Is this amount printed in the document? 575.8 matches "$575.80"; 403 does not match "403.50" or "1403". */
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

/** The lines that match, each with some lines around it, in document order. */
export function sliceLines(text: string, hit: (line: string) => boolean, before: number, after: number, maxChars = SECTION_CHARS): string {
  const lines = text.split("\n");
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (!hit(line)) return;
    for (let j = Math.max(0, i - before); j <= Math.min(lines.length - 1, i + after); j++) keep.add(j);
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

const amounts = (line: string) => (line.match(/\$\s?\d/g) ?? []).length;

export interface Sections { basics: string; rates: string; payments: string; cancellation: string }

export function cutSections(text: string): Sections {
  const lines = text.split("\n");
  // Price table: its rows carry several dollar figures; the column headers sit above them.
  const rows = lines.map((l, i) => (amounts(l) >= 3 ? i : -1)).filter((i) => i >= 0);
  let rates = "";
  if (rows.length) {
    const end = rows[rows.length - 1]!;
    let start = Math.max(0, rows[0]! - 45);
    let block = lines.slice(start, end + 2).join("\n");
    while (block.length > SECTION_CHARS && start < rows[0]!) block = lines.slice(++start, end + 2).join("\n");
    rates = block.trim();
  }
  const dayRange = (l: string) => /\d+\s*[–—-]\s*\d+\s+days|\d+\s+days or more/i.test(l);
  const hasTable = lines.some(dayRange);
  return {
    // Labels sit on short lines; prose that merely mentions a ship does not.
    basics: sliceLines(
      text,
      (l) => (l.length <= 120 && /\bship(?: name)?\b|sailing date|sail date|embark|group (?:id|name|number|#)|\bitinerary\b|\bnights?\b|duration|attention:|amenit|booking (?:number|#)|confirmation (?:number|#)|cruise line/i.test(l))
        || /\b\d{1,2}:\d{2}\s?(?:am|pm)\b/i.test(l),
      0, 1,
    ),
    rates,
    payments: sliceLines(text, (l) => !dayRange(l) && /deposit|final payment|balance|payment (?:is |are )?due|names?\b.{0,40}\bdue|paid in full/i.test(l), 1, 1),
    // The table rows themselves when there is a table; else the sentences about cancelling.
    cancellation: hasTable
      ? sliceLines(text, dayRange, 4, 2)
      : sliceLines(text, (l) => /cancel|penalt|non-?refundable/i.test(l), 1, 1),
  };
}

// ── Checking a model's answer against the document ────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;

const eq = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** The dollar figures on the price-table row that carries this category's code or name. */
function rateRow(text: string, c: CabinCategoryLine): number[] | null {
  const keys = [c.code, c.category].filter((k): k is string => !!k && k.length >= 2).map((k) => k.toLowerCase());
  const line = text.split("\n").find((l) => amounts(l) >= 3 && keys.some((k) => l.toLowerCase().includes(k)));
  if (!line) return null;
  return [...line.matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1]!.replace(/,/g, "")));
}

/**
 * A model reads the right row but can take a figure from the wrong column. A
 * rate row is arithmetic: total = fare + non-commissionable + tax. So the
 * columns are settled by the sums that work, not by the model's choice.
 */
function checkCategory(c: CabinCategoryLine, text: string, flat: string, groupDeposit: number | null, warnings: string[]): CabinCategoryLine {
  const label = [c.code, c.category].filter(Boolean).join(" ") || "a cabin category";
  const out = { ...c };
  const row = rateRow(text, c);
  const inRow = (n: number | null) => n !== null && !!row && row.some((r) => eq(r, n));

  if (row && inRow(out.commissionable_fare)) {
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
    if (v !== null && !moneyAppears(flat, v)) {
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

const TIME = /(?<=\s)(?:[-–—]|\d{1,2}:\d{2}\s?(?:[ap]m)?)(?=\s|$)/gi;
function clock(tok: string): string | null {
  const m = tok.match(/^(\d{1,2}):(\d{2})\s?([ap]m)?$/i);
  if (!m) return null;
  let h = +m[1]!;
  if (m[3]) h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
  return h < 24 ? `${String(h).padStart(2, "0")}:${m[2]}` : null;
}

/** Arrival and departure straight off the itinerary row ("-" means none), so a dash cannot shift the columns. */
function stopTimes(text: string, port: string | null, date: string | null): { arrive: string | null; depart: string | null } | null {
  if (!port || !date) return null;
  const name = port.toLowerCase().split(",")[0]!.trim();
  const line = text.split("\n").find((l) => l.toLowerCase().includes(name) && dateAppears(l, date) && /\d{1,2}:\d{2}/.test(l));
  if (!line) return null;
  const toks = line.slice(line.toLowerCase().indexOf(name) + name.length).match(TIME) ?? [];
  return toks.length >= 2 ? { arrive: clock(toks[0]!), depart: clock(toks[1]!) } : null;
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
  if (!out.return_date && out.sail_date && out.nights) out.return_date = addDays(out.sail_date, out.nights);
  dateField("deposit_due", "Deposit deadline");
  dateField("names_due", "Names-due date");

  out.itinerary = out.itinerary
    .map((s) => (s.date && !dateAppears(flat, s.date) ? { ...s, date: null } : s))
    .map((s) => ({ ...s, ...(stopTimes(text, s.port, s.date) ?? {}) }));
  for (const k of ["deposit_per_person", "total_price"] as const) {
    const v = out[k];
    if (v !== null && !moneyAppears(flat, v)) {
      warnings.push(`${k === "deposit_per_person" ? "Deposit per person" : "Total price"} was read as ${v}, which is not printed in the document. Left blank.`);
      out[k] = null;
    }
  }
  out.cabin_categories = out.cabin_categories.map((c) => checkCategory(c, text, flat, out.deposit_per_person, warnings));
  if (out.deposit_timing === "at_booking" && !/(?:at|upon|with)\s+(?:the\s+)?(?:time\s+of\s+)?booking/i.test(flat)) out.deposit_timing = null;
  if (out.deposit_timing === "by_date" && !out.deposit_due) out.deposit_timing = null;
  if (out.deposit_timing === "at_booking") out.deposit_due = null;

  // Deadlines: found by pattern, dated by arithmetic.
  const found = findDeadlines(text, out.sail_date);
  warnings.push(...found.warnings);
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

  out.warnings = [...new Set(warnings)];
  return out;
}
