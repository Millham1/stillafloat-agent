// booking-extract.ts — read a cruise line's group contract or quote and turn it
// into the fields of a group file (migration 0043, Mark 2026-10-02: "scrape the
// contracts / quotes to fill in the details").
//
// Two halves:
//   extractPdfText  — PDF bytes → plain text (pdfjs, pure JS, no native deps).
//   extractBooking  — text → BookingExtraction via llmJson (local box first,
//                     Claude fallback; job "groups.extract").
// normalizeExtraction is pure and tested: it tidies what the model returns
// (dates to YYYY-MM-DD, money to numbers, blanks to null) so the review form
// and the accept step never see a free-form value. The model is asked to
// return null for anything the document does not state — a blank on the form
// is honest, a guess is not.

import { llmJson } from "./llm";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** Enough for any quote; keeps a 200-page brochure from blowing the context. */
export const MAX_TEXT_CHARS = 60_000;

export interface CabinCategoryLine {
  category: string | null;        // Inside / Ocean View / Balcony / Suite / the line's name
  code: string | null;            // the line's category code, e.g. 8C
  count: number | null;           // cabins of this category in the block
  price_per_person: number | null;
  deposit_per_person: number | null;
}

export interface ItineraryStop {
  day: number | null;
  date: string | null;            // YYYY-MM-DD
  port: string | null;
  arrive: string | null;          // HH:MM or null
  depart: string | null;
}

export interface BookingExtraction {
  cruise_line: string | null;
  ship_name: string | null;
  sail_date: string | null;
  return_date: string | null;
  nights: number | null;
  embark_port: string | null;
  itinerary: ItineraryStop[];
  group_number: string | null;
  booking_number: string | null;
  cabins_held: number | null;
  cabin_categories: CabinCategoryLine[];
  deposit_per_person: number | null;
  deposit_due: string | null;
  names_due: string | null;
  final_payment_due: string | null;
  recall_date: string | null;
  amenities: string[];
  organizer_name: string | null;
  travelers: Array<{ first_name: string | null; last_name: string | null }>;
  total_price: number | null;
  notes: string | null;
}

const nullable = (type: string) => ({ type: [type, "null"] });

export const BOOKING_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    cruise_line: nullable("string"),
    ship_name: nullable("string"),
    sail_date: { ...nullable("string"), description: "Embarkation date, YYYY-MM-DD" },
    return_date: { ...nullable("string"), description: "Disembarkation date, YYYY-MM-DD" },
    nights: nullable("integer"),
    embark_port: nullable("string"),
    itinerary: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          day: nullable("integer"),
          date: nullable("string"),
          port: nullable("string"),
          arrive: nullable("string"),
          depart: nullable("string"),
        },
        required: ["day", "date", "port", "arrive", "depart"],
      },
    },
    group_number: { ...nullable("string"), description: "The cruise line's group id / group booking number" },
    booking_number: { ...nullable("string"), description: "Individual booking / reservation number, if this is one booking" },
    cabins_held: { ...nullable("integer"), description: "Total cabins held in the group block" },
    cabin_categories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: nullable("string"),
          code: nullable("string"),
          count: nullable("integer"),
          price_per_person: nullable("number"),
          deposit_per_person: nullable("number"),
        },
        required: ["category", "code", "count", "price_per_person", "deposit_per_person"],
      },
    },
    deposit_per_person: nullable("number"),
    deposit_due: { ...nullable("string"), description: "Date the deposit is due, YYYY-MM-DD" },
    names_due: { ...nullable("string"), description: "Date passenger names are due to the line, YYYY-MM-DD" },
    final_payment_due: { ...nullable("string"), description: "Final payment date, YYYY-MM-DD" },
    recall_date: { ...nullable("string"), description: "Date unsold cabins are released back to the line, YYYY-MM-DD" },
    amenities: { type: "array", items: { type: "string" }, description: "Group amenities / perks, one per entry, as stated" },
    organizer_name: nullable("string"),
    travelers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { first_name: nullable("string"), last_name: nullable("string") },
        required: ["first_name", "last_name"],
      },
    },
    total_price: nullable("number"),
    notes: { ...nullable("string"), description: "Anything else a travel advisor must not miss: penalties, deadlines, conditions. Two or three sentences at most." },
  },
  required: [
    "cruise_line", "ship_name", "sail_date", "return_date", "nights", "embark_port", "itinerary",
    "group_number", "booking_number", "cabins_held", "cabin_categories", "deposit_per_person",
    "deposit_due", "names_due", "final_payment_due", "recall_date", "amenities", "organizer_name",
    "travelers", "total_price", "notes",
  ],
};

export const SYSTEM_PROMPT = `You read cruise line group contracts, group quotes and individual booking confirmations for a travel advisor and fill in a booking record.
Rules:
- Copy only what the document states. If a field is not in the document, return null (or an empty list). Never guess, infer or fill a typical value.
- Dates as YYYY-MM-DD. Money as plain numbers in the document's currency, no symbols. Per-person figures stay per person.
- Cabin categories: one entry per category line in the block, with the line's own code when printed.
- Amenities: the group's perks exactly as written (onboard credit, free berths, cocktail party, etc.), one per entry.
- The organizer is the group leader / contact named on the contract, not the travel agency.
- Keep "notes" to the deadlines, penalties and conditions an advisor must act on.`;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

/** Accepts YYYY-MM-DD, MM/DD/YYYY, "March 1, 2027", "1 Mar 2027"; anything else → null. */
export function normalizeDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    return ymd(y, +m[1]!, +m[2]!);
  }
  m = s.match(/^([a-záéíóú]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (m) {
    const mo = MONTHS[m[1]!.toLowerCase().slice(0, m[1]!.toLowerCase() === "sept" ? 4 : 3)] ?? MONTHS[m[1]!.toLowerCase()];
    if (mo) return ymd(+m[3]!, mo, +m[2]!);
  }
  m = s.match(/^(\d{1,2})\s+(?:de\s+)?([a-záéíóú]+)\.?,?\s+(?:de\s+)?(\d{4})$/i);
  if (m) {
    const key = m[2]!.toLowerCase();
    const mo = MONTHS[key] ?? MONTHS[key.slice(0, 3)];
    if (mo) return ymd(+m[3]!, mo, +m[1]!);
  }
  return null;
}

function ymd(y: number, mo: number, d: number): string | null {
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function normalizeMoney(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  if (typeof v !== "string") return null;
  const digits = v.replace(/[^0-9.-]/g, "");
  if (!/\d/.test(digits)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function normalizeInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^0-9-]/g, "")) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

/** Tidy a raw model answer into the exact shape the review form expects. */
export function normalizeExtraction(raw: unknown): BookingExtraction {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const itinerary: ItineraryStop[] = list(r["itinerary"])
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {}))
    .map((x) => ({
      day: normalizeInt(x["day"]),
      date: normalizeDate(x["date"]),
      port: str(x["port"]),
      arrive: str(x["arrive"]),
      depart: str(x["depart"]),
    }))
    .filter((x) => x.port || x.date);
  const cabin_categories: CabinCategoryLine[] = list(r["cabin_categories"])
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {}))
    .map((x) => ({
      category: str(x["category"]),
      code: str(x["code"]),
      count: normalizeInt(x["count"]),
      price_per_person: normalizeMoney(x["price_per_person"]),
      deposit_per_person: normalizeMoney(x["deposit_per_person"]),
    }))
    .filter((x) => x.category || x.code);
  const travelers = list(r["travelers"])
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {}))
    .map((x) => ({ first_name: str(x["first_name"]), last_name: str(x["last_name"]) }))
    .filter((x) => x.first_name || x.last_name);
  const amenities = list(r["amenities"]).map(str).filter((x): x is string => !!x);

  const sail_date = normalizeDate(r["sail_date"]);
  const return_date = normalizeDate(r["return_date"]);
  let nights = normalizeInt(r["nights"]);
  if (nights === null && sail_date && return_date) {
    const d = Math.round((Date.parse(return_date) - Date.parse(sail_date)) / 86_400_000);
    if (d > 0 && d < 200) nights = d;
  }
  const cabins_held = normalizeInt(r["cabins_held"]) ?? (cabin_categories.length
    ? cabin_categories.reduce((n, c) => n + (c.count ?? 0), 0) || null
    : null);
  const deposit_per_person = normalizeMoney(r["deposit_per_person"])
    ?? cabin_categories.map((c) => c.deposit_per_person).find((x) => x !== null) ?? null;

  return {
    cruise_line: str(r["cruise_line"]),
    ship_name: str(r["ship_name"]),
    sail_date,
    return_date,
    nights,
    embark_port: str(r["embark_port"]),
    itinerary,
    group_number: str(r["group_number"]),
    booking_number: str(r["booking_number"]),
    cabins_held,
    cabin_categories,
    deposit_per_person,
    deposit_due: normalizeDate(r["deposit_due"]),
    names_due: normalizeDate(r["names_due"]),
    final_payment_due: normalizeDate(r["final_payment_due"]),
    recall_date: normalizeDate(r["recall_date"]),
    amenities,
    organizer_name: str(r["organizer_name"]),
    travelers,
    total_price: normalizeMoney(r["total_price"]),
    notes: str(r["notes"]),
  };
}

/** Which fields the document gave us — the form marks the rest "not found". */
export function foundFields(x: BookingExtraction): string[] {
  return (Object.keys(x) as Array<keyof BookingExtraction>).filter((k) => {
    const v = x[k];
    return Array.isArray(v) ? v.length > 0 : v !== null;
  });
}

/** The cabins to open on the group from the category lines (one row per cabin). */
export function cabinRowsFromExtraction(x: BookingExtraction, kind: "group" | "individual"): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const c of x.cabin_categories) {
    const n = kind === "individual" ? 1 : c.count ?? 0;
    for (let i = 0; i < n; i++) {
      rows.push({
        category: c.category,
        category_code: c.code,
        // Prices in a quote are per person; a cabin is sold double-occupancy.
        price_total: c.price_per_person !== null ? Math.round(c.price_per_person * 2 * 100) / 100 : null,
        deposit_amount: c.deposit_per_person !== null ? Math.round(c.deposit_per_person * 2 * 100) / 100 : null,
        status: kind === "individual" ? "booked" : "held",
        booking_number: kind === "individual" ? x.booking_number : null,
      });
    }
  }
  if (rows.length === 0) {
    const n = kind === "individual" ? 1 : x.cabins_held ?? 0;
    for (let i = 0; i < n; i++) {
      rows.push({
        status: kind === "individual" ? "booked" : "held",
        booking_number: kind === "individual" ? x.booking_number : null,
        deposit_amount: x.deposit_per_person !== null ? x.deposit_per_person * 2 : null,
      });
    }
  }
  return rows;
}

// ── I/O ───────────────────────────────────────────────────────────────────────

/** PDF bytes → text. Returns "" for a scanned (image-only) PDF. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages: string[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let line = "";
      let out = "";
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str !== "string") continue;
        line += item.str;
        if (item.hasEOL) { out += line.trimEnd() + "\n"; line = ""; }
        else line += " ";
      }
      out += line.trimEnd();
      pages.push(out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n"));
      if (pages.join("\n").length > MAX_TEXT_CHARS) break;
    }
  } finally {
    await doc.destroy();
  }
  return pages.join("\n\n--- page break ---\n\n").trim().slice(0, MAX_TEXT_CHARS);
}

export async function extractBooking(text: string, kind: "group" | "individual"): Promise<BookingExtraction> {
  const raw = await llmJson<Record<string, unknown>>({
    job: "groups.extract",
    system: SYSTEM_PROMPT,
    user:
      `This document is ${kind === "group" ? "a GROUP contract or group quote" : "an INDIVIDUAL booking confirmation or quote"}. ` +
      `Fill in the booking record from it.\n\n<document>\n${text}\n</document>`,
    schema: BOOKING_SCHEMA,
    maxTokens: 4000,
    timeoutMs: 180_000,
  });
  return normalizeExtraction(raw);
}
