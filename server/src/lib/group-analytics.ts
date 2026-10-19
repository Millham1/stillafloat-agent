// group-analytics.ts — ONE flat dataset across every group, for the dashboard's Group Bookings Workspace
// (Mark 2026-10-19: "this editorial command center is not a command center by design. it's just a webpage. I need a
// link to open a power BI style dashboard to track this. the group booking tab in the business dashboard should give
// the 'big picture', the power BI should be the workhorse.").
//
// PURE: rows in, datasets out. Nothing here reads a database; lib/group-analytics-store.ts loads the rows and
// routes/group-analytics.ts serves the result. The workspace page slices these datasets in the browser (filters,
// cross-filtering, KPIs), so every field a slicer or a grid needs is a plain column here.
//
// THE RULES THIS FILE ENFORCES
//   * Every output object is built field by field from a whitelist. A row is never spread into the output, so a
//     column added to a table later cannot reach the dashboard by accident.
//   * Never in the output: passport numbers, link-token hashes (traveler form, traveler hub, organizer), ip / user
//     agent hashes, the answers a person gave on a document, a message's body, a signed copy's file path. Whether a
//     passport is on file is a yes / no taken from the last four digits being present, never the digits.
//   * An email address leaves this file masked ("m•••@gmail.com"); so does a lead's name ("Jane S."). A final pass
//     masks any address that turns up inside a free-text label (a quote's deadline text), so the guarantee does not
//     depend on every field having been remembered.
//   * Counts agree with the group list: each group's cabin, traveler and payment figures come from summarize() in
//     group-file.ts, called with the same date, and rows on a released or cancelled cabin are left out of the row
//     datasets exactly as summarize() leaves them out of its counts.

import { publicGroupRow, summarize, type GroupFile } from "./group-file";
import { DOC_SPECS, packetFor } from "./group-documents";
import { ALL_KINDS, KIND_LABEL, approvalFor, planJourney, summarizePlan, type JourneyDefaults, type MilestoneKind } from "./group-journey";
import { dayDiff, ymd, type JourneyInput } from "./group-journey-facts";

type Row = Record<string, any>;

/** The raw rows of every group, as the store loads them. Columns outside what each field below reads are never used. */
export interface AnalyticsRaw {
  groups: Row[];
  cabins: Row[];
  travelers: Row[];
  payments: Row[];
  travel: Row[];
  checklist: Row[];
  documents: Row[];
  /** group_signatures: group_id, traveler_id, doc_key, signer_role, signed_at — never the answers. */
  signatures: Row[];
  /** group_messages: no body. `dedupe_key`, `meta` and `updated_at` are read only to plan the journey. */
  messages: Row[];
  interests: Row[];
  journeyDefaults: JourneyDefaults;
}

export type PayStatus = "paid" | "due" | "overdue" | "no date";
export type DeadlineKind = "deposit" | "names" | "final" | "recall" | "line" | "journey" | "sail";

export interface AnalyticsGroup {
  id: string; name: string; status: string; lang: string;
  cruiseLine: string | null; shipName: string | null; sailDate: string | null; returnDate: string | null; daysToSail: number | null;
  cabinsTotal: number; cabinsHeld: number; cabinsOffered: number; cabinsBooked: number; cabinsReleased: number;
  travelersExpected: number; travelersOnFile: number; formsSent: number; formsReturned: number; fullySigned: number;
  depositsTotal: number; depositsPaid: number;
  /** Counts of payment lines (open = not yet paid) and what they add up to, in dollars. */
  paymentsOpen: number; paymentsPaid: number; paymentsOverdue: number;
  amountDue: number; amountPaid: number; amountOverdue: number;
  interestsTotal: number; interestsNew: number; interestsConverted: number;
  journeyQueued: number; journeySent: number; journeyFailed: number;
  nextDeadlineLabel: string | null; nextDeadlineDate: string | null; nextDeadlineDaysOut: number | null;
  marketingApproved: boolean;
  needsAttention: boolean; attentionReasons: string[];
}

export interface AnalyticsCabin {
  id: string; groupId: string; groupName: string; cabinNum: string | null; category: string | null; categoryCode: string | null;
  status: string; bookingNumber: string | null; priceTotal: number | null; depositAmount: number | null;
  travelerCount: number; travelers: string;
}

export interface AnalyticsTraveler {
  id: string; groupId: string; groupName: string; cabinId: string | null; cabinNum: string | null;
  firstName: string | null; lastName: string | null; name: string; email: string | null; lang: string; isLead: boolean;
  formSentAt: string | null; formSubmittedAt: string | null; formStatus: "returned" | "sent" | "not sent";
  docsRequired: number; docsSigned: number; fullySigned: boolean; passportOnFile: boolean;
}

export interface AnalyticsPayment {
  id: string; groupId: string; groupName: string; cabinId: string | null; cabinNum: string | null;
  kind: string; dueDate: string | null; amount: number | null; paidAt: string | null; status: PayStatus; daysOut: number | null;
}

export interface AnalyticsPaperwork {
  groupId: string; groupName: string; travelerId: string; travelerName: string; cabinNum: string | null; travelerLang: string;
  docKey: string; docTitle: string; status: "signed" | "pending"; signedAt: string | null;
}

export interface AnalyticsMessage {
  id: string; groupId: string; groupName: string; travelerId: string | null; travelerName: string | null; travelerLang: string | null;
  kind: string; status: string; scheduledFor: string | null; sentAt: string | null; createdAt: string | null; to: string | null; journey: boolean;
}

export interface AnalyticsInterest {
  id: string; groupId: string; groupName: string; createdAt: string | null; daysAgo: number | null; status: string;
  guests: number | null; cabinType: string | null; lang: string; name: string; email: string | null;
}

export interface AnalyticsDeadline {
  groupId: string; groupName: string; kind: DeadlineKind; label: string; date: string; daysOut: number;
  /** A deposit, final-payment or names deadline that is already met, so it does not need doing. */
  done: boolean;
  /** For a journey email: "planned" (a future day) or "due" (goes out on the next run). */
  state: "planned" | "due" | null;
  detail: string | null;
}

export interface AnalyticsJourneyRow {
  groupId: string; groupName: string; kind: MilestoneKind; label: string; date: string | null;
  planned: number; due: number; sent: number; failed: number; skipped: number; blocked: number;
}

export interface GroupAnalytics {
  generatedAt: string;
  today: string;
  groups: AnalyticsGroup[];
  cabins: AnalyticsCabin[];
  travelers: AnalyticsTraveler[];
  payments: AnalyticsPayment[];
  paperwork: AnalyticsPaperwork[];
  messages: AnalyticsMessage[];
  interests: AnalyticsInterest[];
  deadlines: AnalyticsDeadline[];
  journey: AnalyticsJourneyRow[];
  /** The documents that appear in `paperwork`, in the order a packet lists them. */
  docs: Array<{ key: string; title: string }>;
  /** Anything that could not be worked out, in plain words (a group whose journey plan failed). The rest is still right. */
  warnings: string[];
}

// ── Reading a whole table ─────────────────────────────────────────────────────

type Page = { data: Row[] | null; error: { message: string } | null };

/** One request to the database returns at most 1,000 rows, and a silent cut-off would make every total wrong without an error. */
export const PAGE_SIZE = 1000;

/** Read a whole table: ask for rows 0–999, then 1000–1999, … until a page comes back short. `make` builds the query for one range. */
export async function fetchAll(make: (from: number, to: number) => PromiseLike<Page>, what: string, pageSize = PAGE_SIZE): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = await make(from, from + pageSize - 1);
    if (page.error) throw new Error(`${what}: ${page.error.message}`);
    const got = page.data ?? [];
    rows.push(...got);
    if (got.length < pageSize) return rows;
  }
}

// ── Small helpers ─────────────────────────────────────────────────────────────

/** "mark@gmail.com" → "m•••@gmail.com". null when it is not an address. */
export function maskEmail(v: unknown): string | null {
  const s = String(v ?? "").trim();
  const at = s.lastIndexOf("@");
  if (at < 1 || at === s.length - 1) return null;
  return `${s.slice(0, 1)}•••${s.slice(at)}`;
}

/** "Jane Smith" → "Jane S.". A lead is a stranger until Mark has spoken to them, so the surname stays out of the workspace. */
export function maskName(first: unknown, last: unknown): string {
  const f = String(first ?? "").trim();
  const l = String(last ?? "").trim();
  return [f, l ? `${l.slice(0, 1).toUpperCase()}.` : ""].filter(Boolean).join(" ") || "—";
}

const EMAIL_IN_TEXT = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** Mask any address inside free text. The masked form ("m•••@x.com") has no word character before the @, so it is left alone. */
const scrub = (s: string): string => s.replace(EMAIL_IN_TEXT, (m) => maskEmail(m) ?? "•••");

function scrubDeep<T>(v: T): T {
  if (typeof v === "string") return scrub(v) as unknown as T;
  if (Array.isArray(v)) return v.map(scrubDeep) as unknown as T;
  if (v && typeof v === "object") {
    const out: Row = {};
    for (const [k, x] of Object.entries(v as Row)) out[k] = scrubDeep(x);
    return out as T;
  }
  return v;
}

const text = (v: unknown, max = 200): string | null => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const money = (v: unknown): number => Math.round((num(v) ?? 0) * 100) / 100;
const iso = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

const personName = (t: Row): string => [t["first_name"], t["last_name"]].map((x) => text(x, 60)).filter(Boolean).join(" ") || "Unnamed traveler";

function indexBy(rows: Row[], key: string): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const r of rows) {
    const k = String(r[key] ?? "");
    const list = out.get(k);
    if (list) list.push(r); else out.set(k, [r]);
  }
  return out;
}

const DEAD_CABIN = new Set(["released", "cancelled"]);
const FINISHED = new Set(["sailed", "closed", "cancelled"]);

/** The short column titles of the paperwork matrix. A key not listed falls back to the document's own title. */
export const DOC_SHORT: Record<string, string> = {
  "15-emergency-contact-form": "Emergency contact",
  "01-terms-and-conditions": "Terms",
  "02-travel-planning-agreement": "Planning agreement",
  "03-service-fee-planning-fee-agreement": "Service fee",
  "05-liability-waiver": "Liability waiver",
  "07-travel-insurance-declination": "Insurance choice",
  "16-passport-document-checklist": "Passport checklist",
  "12-cruise-booking-agreement": "Booking agreement",
};
const docTitle = (key: string): string => DOC_SHORT[key] ?? text(DOC_SPECS[key]?.title, 60) ?? key;

/** Days before today that a dated item still shows (a deadline that just passed), and days ahead it is listed. */
export const DEADLINE_LOOKBACK_DAYS = 14;
export const DEADLINE_HORIZON_DAYS = 400;

// ── The builder ───────────────────────────────────────────────────────────────

export function buildAnalytics(raw: AnalyticsRaw, now: Date = new Date()): GroupAnalytics {
  // The same "today" the group list uses (UTC), so a card on the Group Bookings tab and a number here are the same number.
  const today = now.toISOString().slice(0, 10);
  const warnings: string[] = [];

  const cabinsBy = indexBy(raw.cabins, "group_id");
  const travelersBy = indexBy(raw.travelers, "group_id");
  const paymentsBy = indexBy(raw.payments, "group_id");
  const travelBy = indexBy(raw.travel, "group_id");
  const checklistBy = indexBy(raw.checklist, "group_id");
  const documentsBy = indexBy(raw.documents, "group_id");
  const signaturesBy = indexBy(raw.signatures, "group_id");
  const messagesBy = indexBy(raw.messages, "group_id");
  const interestsBy = indexBy(raw.interests, "group_id");

  const out: GroupAnalytics = {
    generatedAt: now.toISOString(), today,
    groups: [], cabins: [], travelers: [], payments: [], paperwork: [], messages: [], interests: [], deadlines: [], journey: [], docs: [], warnings,
  };
  const docOrder = new Map<string, string>();

  const groups = raw.groups.map((g) => publicGroupRow(g)).sort((a, b) =>
    String(a["sail_date"] ?? "9999").localeCompare(String(b["sail_date"] ?? "9999")) || String(a["id"]).localeCompare(String(b["id"])));

  for (const g of groups) {
    const gid = String(g["id"]);
    const gname = text(g["name"], 120) ?? "Unnamed group";
    const cabins = cabinsBy.get(gid) ?? [];
    const travelers = travelersBy.get(gid) ?? [];
    const payments = paymentsBy.get(gid) ?? [];
    const signatures = signaturesBy.get(gid) ?? [];
    const messages = messagesBy.get(gid) ?? [];
    const interests = interestsBy.get(gid) ?? [];
    const dryRun = (m: Row) => String(m["dedupe_key"] ?? "").startsWith("sim:");
    const realMessages = messages.filter((m) => !dryRun(m));

    const cabinById = new Map(cabins.map((c) => [String(c["id"]), c]));
    const live = (cabinId: unknown): boolean => !cabinId || !DEAD_CABIN.has(String(cabinById.get(String(cabinId))?.["status"] ?? "held"));
    const cabinNumOf = (cabinId: unknown): string | null => text(cabinById.get(String(cabinId ?? ""))?.["cabin_num"], 20);

    // The roll-up the group list shows, from the same function, so the two can never disagree.
    const file: GroupFile = {
      group: g, cabins, travelers, payments, checklist: checklistBy.get(gid) ?? [], documents: documentsBy.get(gid) ?? [], messages,
    };
    const s = summarize(file, today);
    const active = !FINISHED.has(String(g["status"]));

    // ── cabins ──
    const liveTravelers = travelers.filter((t) => live(t["cabin_id"]));
    for (const c of cabins) {
      const here = liveTravelers.filter((t) => t["cabin_id"] === c["id"]);
      out.cabins.push({
        id: String(c["id"]), groupId: gid, groupName: gname, cabinNum: text(c["cabin_num"], 20), category: text(c["category"], 60),
        categoryCode: text(c["category_code"], 20), status: String(c["status"] ?? "held"), bookingNumber: text(c["booking_number"], 40),
        priceTotal: num(c["price_total"]), depositAmount: num(c["deposit_amount"]),
        travelerCount: here.length, travelers: here.map(personName).join(", "),
      });
    }

    // ── travelers and the paperwork each one owes ──
    let fullySigned = 0;
    let formsSent = 0;
    for (const t of liveTravelers) {
      const cabin = t["cabin_id"] ? cabinById.get(String(t["cabin_id"])) ?? null : null;
      const required = packetFor({ group: g, cabin, traveler: t });
      const signedKeys = new Set(signatures.filter((x) => x["traveler_id"] === t["id"]).map((x) => String(x["doc_key"])));
      const signedAt = new Map<string, string | null>();
      for (const x of signatures) if (x["traveler_id"] === t["id"] && !signedAt.has(String(x["doc_key"]))) signedAt.set(String(x["doc_key"]), iso(x["signed_at"]));
      const docsSigned = required.filter((k) => signedKeys.has(k)).length;
      const complete = required.length > 0 && docsSigned === required.length;
      if (complete) fullySigned++;
      if (t["form_sent_at"] || t["form_submitted_at"]) formsSent++;
      const name = personName(t);
      const lang = t["lang"] === "es" ? "es" : "en";
      out.travelers.push({
        id: String(t["id"]), groupId: gid, groupName: gname, cabinId: t["cabin_id"] ? String(t["cabin_id"]) : null, cabinNum: cabinNumOf(t["cabin_id"]),
        firstName: text(t["first_name"], 60), lastName: text(t["last_name"], 60), name, email: maskEmail(t["email"]), lang, isLead: !!t["is_lead"],
        formSentAt: iso(t["form_sent_at"]), formSubmittedAt: iso(t["form_submitted_at"]),
        formStatus: t["form_submitted_at"] ? "returned" : t["form_sent_at"] ? "sent" : "not sent",
        docsRequired: required.length, docsSigned, fullySigned: complete, passportOnFile: !!text(t["passport_last4"], 8),
      });
      for (const key of required) {
        if (!docOrder.has(key)) docOrder.set(key, docTitle(key));
        out.paperwork.push({
          groupId: gid, groupName: gname, travelerId: String(t["id"]), travelerName: name, cabinNum: cabinNumOf(t["cabin_id"]), travelerLang: lang,
          docKey: key, docTitle: docTitle(key), status: signedKeys.has(key) ? "signed" : "pending", signedAt: signedAt.get(key) ?? null,
        });
      }
    }

    // ── payments (live cabins only, as summarize counts them) ──
    let paymentsPaid = 0;
    let paymentsOpen = 0;
    let paymentsOverdue = 0;
    let amountOverdue = 0;
    const liveFinal: Row[] = [];
    const liveDeposit: Row[] = [];
    for (const p of payments) {
      if (!live(p["cabin_id"])) continue;
      const due = ymd(p["due_date"]);
      const daysOut = due ? dayDiff(today, due) : null;
      const amount = num(p["amount"]);
      const status: PayStatus = p["paid_at"] ? "paid" : !due ? "no date" : daysOut! < 0 ? "overdue" : "due";
      if (status === "paid") paymentsPaid++; else paymentsOpen++;
      if (status === "overdue") { paymentsOverdue++; amountOverdue += amount ?? 0; }
      if (p["kind"] === "final") liveFinal.push(p);
      if (p["kind"] === "deposit") liveDeposit.push(p);
      out.payments.push({
        id: String(p["id"]), groupId: gid, groupName: gname, cabinId: p["cabin_id"] ? String(p["cabin_id"]) : null, cabinNum: cabinNumOf(p["cabin_id"]),
        kind: String(p["kind"] ?? "other"), dueDate: due, amount, paidAt: iso(p["paid_at"]), status, daysOut,
      });
    }

    // ── messages and leads ──
    const journeyKinds = new Set<string>(ALL_KINDS);
    const travelerById = new Map(travelers.map((t) => [String(t["id"]), t]));
    let journeyQueued = 0, journeySent = 0, journeyFailed = 0;
    for (const m of realMessages) {
      const isJourney = journeyKinds.has(String(m["template"]));
      if (isJourney) {
        if (m["status"] === "queued") journeyQueued++;
        else if (m["status"] === "sent") journeySent++;
        else if (m["status"] === "failed") journeyFailed++;
      }
      const tr = m["traveler_id"] ? travelerById.get(String(m["traveler_id"])) ?? null : null;
      out.messages.push({
        id: String(m["id"]), groupId: gid, groupName: gname, travelerId: tr ? String(tr["id"]) : null, travelerName: tr ? personName(tr) : null,
        travelerLang: tr ? (tr["lang"] === "es" ? "es" : "en") : null,
        kind: String(m["template"] ?? "other"), status: String(m["status"] ?? "draft"), scheduledFor: iso(m["scheduled_for"]), sentAt: iso(m["sent_at"]),
        createdAt: iso(m["created_at"]), to: maskEmail(m["to_email"]), journey: isJourney,
      });
    }
    let interestsTotal = 0, interestsNew = 0, interestsConverted = 0;
    for (const i of interests) {
      if (i["status"] === "spam") continue;
      interestsTotal++;
      if (i["status"] === "new") interestsNew++;
      if (i["status"] === "booked") interestsConverted++;
      const day = typeof i["created_at"] === "string" ? ymd(i["created_at"].slice(0, 10)) : null;
      out.interests.push({
        id: String(i["id"]), groupId: gid, groupName: gname, createdAt: iso(i["created_at"]), daysAgo: day ? dayDiff(day, today) : null,
        status: String(i["status"] ?? "new"), guests: num(i["guests"]), cabinType: text(i["cabin_type"], 60), lang: i["lang"] === "es" ? "es" : "en",
        name: maskName(i["first_name"], i["last_name"]), email: maskEmail(i["email"]),
      });
    }

    // ── the journey plan: which emails are planned, sent, failed; and the dated ones become deadlines ──
    const journeyInput: JourneyInput = {
      group: g, cabins, travelers, payments, travel: travelBy.get(gid) ?? [], checklist: file.checklist, signatures, messages,
    };
    const dated = new Map<string, { kind: MilestoneKind; date: string; state: "planned" | "due"; n: number; blocked: number }>();
    try {
      const plan = planJourney(journeyInput, now, { isApproved: (k) => approvalFor(k, g["journey"], raw.journeyDefaults).approved });
      for (const m of summarizePlan(plan, g)) {
        out.journey.push({
          groupId: gid, groupName: gname, kind: m.kind, label: m.label, date: m.date,
          planned: m.counts.planned, due: m.counts.due, sent: m.counts.sent, failed: m.counts.failed, skipped: m.counts.skipped, blocked: m.counts.blocked,
        });
      }
      for (const t of plan.travelers) {
        for (const it of t.items) {
          if (!it.date || (it.status !== "planned" && it.status !== "due")) continue;
          const key = `${it.kind}|${it.date}`;
          const e = dated.get(key) ?? { kind: it.kind, date: it.date, state: it.status, n: 0, blocked: 0 };
          e.n++;
          if (it.blocked) e.blocked++;
          if (it.status === "due") e.state = "due";
          dated.set(key, e);
        }
      }
    } catch (err) {
      warnings.push(`The journey plan of "${gname}" could not be worked out (${(err as Error).message}); its emails are missing from the journey figures.`);
    }

    // ── deadlines ──
    const deadlines: AnalyticsDeadline[] = [];
    const add = (kind: DeadlineKind, label: string, date: unknown, extra: Partial<Pick<AnalyticsDeadline, "done" | "state" | "detail">> = {}) => {
      const d = ymd(date);
      if (!d) return;
      const daysOut = dayDiff(today, d);
      if (daysOut < -DEADLINE_LOOKBACK_DAYS || daysOut > DEADLINE_HORIZON_DAYS) return;
      deadlines.push({ groupId: gid, groupName: gname, kind, label: text(label, 160) ?? kind, date: d, daysOut, done: false, state: null, detail: null, ...extra });
    };
    if (active) {
      const reviews: Row[] = Array.isArray(g["terms"]?.allotment_reviews) ? g["terms"].allotment_reviews : [];
      const reviewDates = new Set(reviews.map((r) => ymd(r?.date)).filter(Boolean));
      const allPaid = (rows: Row[]) => rows.length > 0 && rows.every((p) => !!p["paid_at"]);
      add("deposit", "Group deposit deadline", g["deposit_due"], { done: allPaid(liveDeposit) || (s.deposits.total > 0 && s.deposits.paid >= s.deposits.total) });
      add("names", "Names due to the cruise line", g["names_due"], { done: s.travelers.total > 0 && s.travelers.formsIn >= s.travelers.total });
      add("final", "Group final payment deadline", g["final_payment_due"], { done: allPaid(liveFinal) });
      if (!reviewDates.has(ymd(g["recall_date"]))) add("recall", "Unsold cabins go back to the line", g["recall_date"]);
      for (const r of reviews) {
        const pct = num(r?.percent_retaken);
        add("line", `Line reviews the block${pct !== null ? ` (takes back ${pct}% of unsold)` : ""}`, r?.date);
      }
      const quoted: Row[] = Array.isArray(g["terms"]?.deadlines) ? g["terms"].deadlines : [];
      for (const d of quoted) add("line", text(d?.text, 160) ?? "Deadline in the quote", d?.date);
      add("sail", `Sailing${text(g["ship_name"], 60) ? ` — ${text(g["ship_name"], 60)}` : ""}`, g["sail_date"]);
      for (const e of dated.values()) {
        add("journey", `Email: ${KIND_LABEL[e.kind]}`, e.date, {
          state: e.state, detail: `${e.n} traveler${e.n === 1 ? "" : "s"}${e.blocked ? `, ${e.blocked} waiting for the template to be approved` : ""}`,
        });
      }
    }
    deadlines.sort((a, b) => a.daysOut - b.daysOut || a.label.localeCompare(b.label));
    out.deadlines.push(...deadlines);
    const next = deadlines.find((d) => d.daysOut >= 0 && !d.done && d.kind !== "journey" && d.kind !== "sail") ?? null;

    // ── the group row ──
    const overdueOther = s.attention.filter((a) => a.overdue && a.kind !== "payment").length;
    const reasons: string[] = [];
    if (active) {
      if (paymentsOverdue > 0) reasons.push(`${paymentsOverdue} overdue payment${paymentsOverdue === 1 ? "" : "s"}`);
      if (overdueOther > 0) reasons.push(`${overdueOther} overdue item${overdueOther === 1 ? "" : "s"} on the file`);
      if (journeyFailed > 0) reasons.push(`${journeyFailed} journey email${journeyFailed === 1 ? "" : "s"} failed`);
      if (interestsNew > 0) reasons.push(`${interestsNew} new lead${interestsNew === 1 ? "" : "s"} waiting`);
    }
    out.groups.push({
      id: gid, name: gname, status: String(g["status"] ?? "draft"), lang: String(g["lang"] ?? "en"),
      cruiseLine: text(g["cruise_line"], 60), shipName: text(g["ship_name"], 60), sailDate: ymd(g["sail_date"]), returnDate: ymd(g["return_date"]), daysToSail: s.daysToSail,
      cabinsTotal: s.cabins.total, cabinsHeld: s.cabins.held, cabinsOffered: s.cabins.offered, cabinsBooked: s.cabins.booked, cabinsReleased: s.cabins.released,
      travelersExpected: s.travelers.total, travelersOnFile: liveTravelers.length, formsSent, formsReturned: s.travelers.formsIn, fullySigned,
      depositsTotal: money(s.deposits.total), depositsPaid: money(s.deposits.paid),
      paymentsOpen, paymentsPaid, paymentsOverdue,
      amountDue: money(s.payments.dueTotal), amountPaid: money(s.payments.paidTotal), amountOverdue: money(amountOverdue),
      interestsTotal, interestsNew, interestsConverted,
      journeyQueued, journeySent, journeyFailed,
      nextDeadlineLabel: next?.label ?? null, nextDeadlineDate: next?.date ?? null, nextDeadlineDaysOut: next?.daysOut ?? null,
      marketingApproved: !!g["marketing_approved_at"],
      needsAttention: reasons.length > 0, attentionReasons: reasons,
    });
  }

  out.docs = [...docOrder.entries()].map(([key, title]) => ({ key, title }));
  return scrubDeep(out);
}
