// group-document-kit.ts — the shared vocabulary of the client-paperwork renderer:
// types, small formatting helpers, and the group-file lookups every document spec uses.
// Pure (no I/O). The engine is group-documents.ts; the per-document data is
// group-document-specs.ts; both import this file, so neither imports the other's runtime.
//
// RULE (Mark 2026-10-03): every number and date printed on a client document comes from the
// group file. A helper here returns "" / null when the file does not hold the value, and the
// engine then leaves the template's blank in place (and reports it) instead of guessing.

import type { BUSINESS } from "./group-secure";

export type Row = Record<string, any>;
export type Lang = "en" | "es";
/** Which signature row a document produces (group_signatures.signer_role). */
export type SignerRole = "traveler" | "lead" | "organizer";
export type Answers = Record<string, string | boolean | string[]>;

/** The template version a signature records: "<doc key>@<capture date>". */
export const TEMPLATE_VERSION_DATE = "2026-10-03";

// ── Fees ──────────────────────────────────────────────────────────────────────
/** "No fees unless I hand enter them" (Mark 2026-10-03): groups.fees is {} by default. */
export interface FeeLine {
  key: string;
  label: string;
  amount: number;
  /** "booking" | "person" | "cabin" | "change" … as Mark typed it; shown after the amount. */
  per: string | null;
  note: string | null;
}

const FEE_LABELS: Record<string, string> = {
  planning_fee: "Planning fee",
  service_fee: "Service fee",
  booking_fee: "Booking fee",
  change_fee: "Change / rebooking fee",
  cancellation_fee: "Cancellation / processing fee",
  substitution_fee: "Substitution fee",
  retainer_fee: "Group organizer retainer fee",
};

function humanize(key: string): string {
  const s = key.replace(/[_-]+/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : key;
}

/** groups.fees → fee lines. Accepts { planning_fee: 150 } or { planning_fee: { amount, label?, per?, note? } }.
 * Anything that is not a positive number is ignored, so a stray key can never print a fee. */
export function normalizeFees(raw: unknown): FeeLine[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: FeeLine[] = [];
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const obj = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    const amount = Number(obj ? obj["amount"] : v);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const text = (x: unknown) => (typeof x === "string" && x.trim() ? cleanValue(x).slice(0, 160) : null);
    out.push({
      key,
      label: text(obj?.["label"]) ?? FEE_LABELS[key] ?? humanize(key),
      amount,
      per: text(obj?.["per"]),
      note: text(obj?.["note"]),
    });
  }
  return out;
}

export const fee = (ctx: DocCtx, key: string): FeeLine | undefined => ctx.fees.find((f) => f.key === key);

// ── Context ───────────────────────────────────────────────────────────────────
/** One port of the itinerary with its country's State Department advisory (null level = the feed did not name the country). */
export interface Advisory { port: string; country: string; level: 1 | 2 | 3 | 4 | null; title: string }

export interface DocCtx {
  business: typeof BUSINESS;
  group: Row;
  /** The cabin the signer sails in (null for the organizer's contract). */
  cabin: Row | null;
  /** The signer's own file row (null for the organizer's contract). */
  traveler: Row | null;
  /** The other travelers on the same cabin, by file order. */
  mates: Row[];
  lang: Lang;
  fees: FeeLine[];
  now: Date;
  /** How big the group's file is today (for the organizer's contract). */
  counts: { travelers: number; cabins: number };
  /** The State Department advisory for every port of the itinerary, read when the page opened (empty = not read). */
  advisories: Advisory[];
}

/** Build the context for one signer from rows already read from the group file. */
export function buildCtx(input: {
  business: typeof BUSINESS;
  group: Row;
  cabins?: Row[];
  travelers?: Row[];
  traveler?: Row | null;
  lang?: Lang;
  now?: Date;
  advisories?: Advisory[];
}): DocCtx {
  const traveler = input.traveler ?? null;
  const cabin = traveler?.cabin_id ? (input.cabins ?? []).find((c) => c.id === traveler.cabin_id) ?? null : null;
  const mates = traveler?.cabin_id
    ? (input.travelers ?? []).filter((t) => t.cabin_id === traveler.cabin_id && t.id !== traveler.id)
    : [];
  return {
    business: input.business,
    group: input.group,
    cabin,
    traveler,
    mates,
    lang: input.lang ?? (traveler?.lang === "es" ? "es" : "en"),
    fees: normalizeFees(input.group?.fees),
    now: input.now ?? new Date(),
    counts: { travelers: (input.travelers ?? []).length, cabins: (input.cabins ?? []).length },
    advisories: input.advisories ?? [],
  };
}

// ── Formatting ────────────────────────────────────────────────────────────────
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const YMD = /^(\d{4})-(\d{2})-(\d{2})/;

/** "2027-03-05" → "March 5, 2027". "" when the value is not a date. */
export function fmtLong(value: unknown): string {
  if (typeof value !== "string") return "";
  const m = YMD.exec(value);
  if (!m) return "";
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  return `${MONTHS[mo - 1]} ${d}, ${y}`;
}

export function fmtMoney(n: number): string {
  const [int, dec] = Math.abs(n).toFixed(2).split(".") as [string, string];
  return `${n < 0 ? "-" : ""}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${dec === "00" ? "" : `.${dec}`}`;
}

/** A bare amount for a template that already prints the "$": 1250 → "1,250", 99.5 → "99.50". */
export function amountText(n: number): string {
  return fmtMoney(n).replace(/^\$/, "");
}

/** Keep a value from turning into markup or a template token when it is written into the text. */
export function cleanValue(v: unknown): string {
  return String(v ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[*_{}|\\<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function fullName(t: Row | null | undefined): string {
  if (!t) return "";
  return cleanValue([t.first_name, t.middle_name, t.last_name].filter(Boolean).join(" "));
}

/** Where the ship goes: the itinerary's ports (sea days left out), else "N-night cruise from <port>". */
export function destinationText(group: Row): string {
  const itinerary: Row[] = Array.isArray(group.itinerary) ? group.itinerary : [];
  const ports: string[] = [];
  for (const stop of itinerary) {
    const port = typeof stop?.port === "string" ? cleanValue(stop.port) : "";
    if (!port || /^(at sea|cruising|sea day|scenic cruising)/i.test(port)) continue;
    if (!ports.some((p) => p.toLowerCase() === port.toLowerCase())) ports.push(port);
  }
  if (ports.length) return ports.slice(0, 10).join(", ");
  const nights = Number(group.nights);
  const from = cleanValue(group.embark_port);
  if (nights > 0 && from) return `${nights}-night cruise from ${from}`;
  return cleanValue(group.ship_name) || "";
}

/** "March 5, 2027 to March 12, 2027" for headings; each half is "" when unknown. */
export function sailDates(group: Row): { from: string; to: string } {
  return { from: fmtLong(group.sail_date), to: fmtLong(group.return_date) };
}

export function bookingReference(ctx: DocCtx): string {
  return cleanValue(ctx.cabin?.booking_number) || cleanValue(ctx.group.group_number) || "";
}

// ── The cruise line's own cancellation schedule ───────────────────────────────
export interface ScheduleRow {
  days: string;
  dates: string;
  penalty: string;
}

/** The line's schedule as read from its contract: groups.terms.cancellation_schedule (written at
 * accept), else groups.cancellation_schedule (migration 0044). [] when the file has none. */
export function cancellationRows(group: Row): ScheduleRow[] {
  const fromTerms = group.terms?.cancellation_schedule;
  const fromColumn = group.cancellation_schedule;
  const rows: Row[] = Array.isArray(fromTerms) && fromTerms.length ? fromTerms : Array.isArray(fromColumn) ? fromColumn : [];
  const out: ScheduleRow[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const from = Number.isFinite(Number(r.from_days)) && r.from_days !== null ? Number(r.from_days) : null;
    const to = Number.isFinite(Number(r.to_days)) && r.to_days !== null ? Number(r.to_days) : null;
    if (from === null && to === null) continue;
    const hi = from !== null && to !== null ? Math.max(from, to) : from;
    const lo = from !== null && to !== null ? Math.min(from, to) : to;
    const fromDate = fmtLong(r.from_date);
    const toDate = fmtLong(r.to_date);
    let days: string;
    let dates: string;
    if (hi !== null && lo !== null) {
      days = `${lo}–${hi} days`;
      dates = fromDate && toDate ? `${fromDate} – ${toDate}` : fromDate || toDate || "";
    } else if (from !== null) {
      days = `${from}+ days`;
      dates = fromDate ? `On or before ${fromDate}` : "";
    } else {
      days = `${to} days or fewer`;
      dates = toDate ? `${toDate} until sailing` : "";
    }
    const percent = Number.isFinite(Number(r.percent)) && r.percent !== null ? Number(r.percent) : null;
    const penalty = cleanValue(r.penalty) || (percent !== null ? `${percent}% of the cruise fare` : "The deposit");
    out.push({ days, dates, penalty });
  }
  return out;
}

export function cancellationNote(group: Row): string {
  return typeof group.terms?.cancellation_note === "string" ? cleanValue(group.terms.cancellation_note).slice(0, 600) : "";
}

// ── Cabin pricing, from the quote on the file ─────────────────────────────────
function categoryLine(ctx: DocCtx): Row | null {
  const lines: Row[] = Array.isArray(ctx.group.terms?.cabin_categories) ? ctx.group.terms.cabin_categories : [];
  const cabin = ctx.cabin;
  if (!cabin) return null;
  const code = String(cabin.category_code ?? "").trim().toLowerCase();
  const name = String(cabin.category ?? "").trim().toLowerCase();
  return (
    lines.find((l) => code && String(l.code ?? "").trim().toLowerCase() === code) ??
    lines.find((l) => name && String(l.category ?? "").trim().toLowerCase() === name) ??
    null
  );
}

export function perPersonPrice(ctx: DocCtx): number | null {
  const n = Number(categoryLine(ctx)?.price_per_person);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function depositPerPerson(ctx: DocCtx): number | null {
  const n = Number(categoryLine(ctx)?.deposit_per_person ?? ctx.group.deposit_per_person);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function cabinTotal(ctx: DocCtx): number | null {
  const n = Number(ctx.cabin?.price_total);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Days before sailing the final payment is due: the line's stated number, else worked out from the two dates on the file. */
export function finalPaymentDays(group: Row): number | null {
  const stated = Number(group.terms?.final_payment_days_before);
  if (Number.isInteger(stated) && stated > 0) return stated;
  const sail = Date.parse(`${String(group.sail_date ?? "").slice(0, 10)}T00:00:00Z`);
  const due = Date.parse(`${String(group.final_payment_due ?? "").slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(sail) || !Number.isFinite(due) || due >= sail) return null;
  return Math.round((sail - due) / 86_400_000);
}

// ── Template structure ────────────────────────────────────────────────────────
export type Block =
  | { t: "h"; level: number; text: string }
  | { t: "hr" }
  | { t: "p"; text: string }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[] }
  | { t: "table"; header: string[]; rows: string[][] };

export type TableBlock = Extract<Block, { t: "table" }>;

/** Rewrite the table that `match` picks (first match only); leave every other block alone. */
export function mapTable(blocks: Block[], match: (t: TableBlock) => boolean, fn: (t: TableBlock) => Block[]): Block[] {
  const i = blocks.findIndex((b) => b.t === "table" && match(b));
  if (i < 0) throw new Error("client document template changed: the expected table is no longer there");
  return [...blocks.slice(0, i), ...fn(blocks[i] as TableBlock), ...blocks.slice(i + 1)];
}

// ── Fields ────────────────────────────────────────────────────────────────────
export type FieldKind = "text" | "date" | "email" | "tel" | "textarea" | "choice" | "multi" | "check" | "passport" | "license";

export interface Option {
  value: string;
  label: string;
  /** The words after the template's ☐ that identify this option (defaults to label). */
  match?: string;
}

export interface FieldSpec {
  name: string;
  label: string;
  kind: FieldKind;
  required?: boolean | ((answers: Answers) => boolean);
  options?: Option[];
  maxLength?: number;
  /** group_travelers column an accepted answer is also written to. */
  col?: string;
  /** Dotted path into group_travelers.form_data an accepted answer is also written to. */
  form?: string;
  /** Date sanity: "dob" = in the past and under 125 years ago, "past", "future". */
  date?: "dob" | "past" | "future";
  /** What the page pre-fills when the file holds nothing under col/form. */
  prefill?: (ctx: DocCtx) => string | string[] | undefined;
}

// ── Template edits ────────────────────────────────────────────────────────────
export type Rule =
  /** Replace literal text (first occurrence at or after the cursor). */
  | { sub: string | RegExp; with: (c: DocCtx) => string }
  /** The next blank run after `after` becomes a value from the file; null/"" leaves it blank (and reports `label`). */
  | { after: string; fill: (c: DocCtx) => string | null | undefined; label: string }
  /** The next blank run after `after` becomes an input for field `slot`. */
  | { after: string; slot: string }
  /** The ☐ markers after `after` become the options of choice/multi field `choice`. */
  | { after: string; choice: string }
  /** Insert a multi-line text box for field `area` right after the paragraph holding `after`. */
  | { after: string; area: string }
  /** The next blank run after `after` becomes the date the signer signs (shown as "[date of signing]" in the hashed text). */
  | { after: string; today: true };

export interface DocSpec {
  key: string;
  title: string;
  signerRole: SignerRole;
  /** Only in a packet when the file carries fees (02 and 03). */
  requiresFees?: boolean;
  /** The template has an agent signature that the dashboard records later (09: the contract). */
  agentCountersign?: boolean;
  /** The paragraph that starts the template's own signature lines; they are replaced by the typed signature. */
  sigStart?: RegExp;
  rules: Rule[];
  fields: FieldSpec[];
  /** Structural edits (tables, inserted sections), run in order after the signature lines are dropped. */
  edits?: Array<(blocks: Block[], ctx: DocCtx) => Block[]>;
  /** Agent-fee lines to remove when the file carries no fees: matched against table rows, sentences and list items. */
  feeLines?: RegExp[];
  /** After this paragraph, list the file's fees (when it has any). */
  feesAfter?: RegExp;
  /** The heading above this document's "typical" cruise-line cancellation table. */
  cancellationHeading?: RegExp;
  /** Cross-field checks that need more than one answer. */
  validate?: (answers: Answers) => Record<string, string>;
  /** Columns on group_travelers that follow from several answers (e.g. emergency_phone, special_needs). */
  derive?: (answers: Answers, ctx: DocCtx) => Row;
}
