// group-workspace.ts — the Group Bookings Workspace's data and its rules, with no React in it so they can be tested:
// the shape of GET /api/groups/analytics, the slicers (filters that live in the address and in the browser's storage),
// the cross-filters a click on a chart sets, and every number the cards and charts show.
//
// Mark 2026-10-19: "I need a link to open a power BI style dashboard to track this. the group booking tab in the business
// dashboard should give the 'big picture', the power BI should be the workhorse."
//
// HOW FILTERING WORKS (one rule, so the page is predictable)
//   * SLICERS (group, status, ship, sail dates, traveler language, needs attention) narrow EVERYTHING: the cards, the charts
//     and the grids. A slicer decides which groups are in; the language slicer also narrows the travelers, paperwork rows,
//     emails and leads that carry a language.
//   * CROSS-FILTERS (a click on a chart segment: "overdue", "failed", "pending"…) narrow the GRIDS only. The charts stay whole
//     so there is something to click next. Each cross-filter shows as a chip that can be removed.
//   * Clicking a group in a chart sets the Group slicer, which narrows everything.

export type PayStatus = "paid" | "due" | "overdue" | "no date";
export type DeadlineKind = "deposit" | "names" | "final" | "recall" | "line" | "journey" | "sail";

export interface WGroup {
  id: string; name: string; status: string; lang: string;
  cruiseLine: string | null; shipName: string | null; sailDate: string | null; returnDate: string | null; daysToSail: number | null;
  cabinsTotal: number; cabinsHeld: number; cabinsOffered: number; cabinsBooked: number; cabinsReleased: number;
  travelersExpected: number; travelersOnFile: number; formsSent: number; formsReturned: number; fullySigned: number;
  depositsTotal: number; depositsPaid: number;
  paymentsOpen: number; paymentsPaid: number; paymentsOverdue: number;
  amountDue: number; amountPaid: number; amountOverdue: number;
  interestsTotal: number; interestsNew: number; interestsConverted: number;
  journeyQueued: number; journeySent: number; journeyFailed: number;
  nextDeadlineLabel: string | null; nextDeadlineDate: string | null; nextDeadlineDaysOut: number | null;
  marketingApproved: boolean; needsAttention: boolean; attentionReasons: string[];
}
export interface WCabin {
  id: string; groupId: string; groupName: string; cabinNum: string | null; category: string | null; categoryCode: string | null; status: string;
  bookingNumber: string | null; priceTotal: number | null; depositAmount: number | null; travelerCount: number; travelers: string;
}
export interface WTraveler {
  id: string; groupId: string; groupName: string; cabinId: string | null; cabinNum: string | null; firstName: string | null; lastName: string | null;
  name: string; email: string | null; lang: string; isLead: boolean; formSentAt: string | null; formSubmittedAt: string | null;
  formStatus: "returned" | "sent" | "not sent"; docsRequired: number; docsSigned: number; fullySigned: boolean; passportOnFile: boolean;
  formOpenedAt?: string | null; consentAt?: string | null; copiesSentAt?: string | null;
}
export interface WPayment {
  id: string; groupId: string; groupName: string; cabinId: string | null; cabinNum: string | null; kind: string; dueDate: string | null;
  amount: number | null; paidAt: string | null; status: PayStatus; daysOut: number | null;
}
export interface WPaperwork {
  groupId: string; groupName: string; travelerId: string; travelerName: string; cabinNum: string | null; travelerLang: string;
  docKey: string; docTitle: string; status: "signed" | "pending"; signedAt: string | null;
  /** Mark 2026-10-25: the signature's id (null while pending), whether a signed copy is kept, whether it carries our seal. */
  signatureId: string | null; hasCopy: boolean; sealed: boolean;
}

/** A traveler's signed copies the workspace can open, in packet order: only rows with a signature id AND a kept copy. */
export function signedCopies(paperwork: WPaperwork[], travelerId: string): Array<{ signatureId: string; groupId: string; docTitle: string; signedAt: string | null; sealed: boolean }> {
  return paperwork
    .filter((p) => p.travelerId === travelerId && p.status === "signed" && p.hasCopy && !!p.signatureId)
    .map((p) => ({ signatureId: p.signatureId as string, groupId: p.groupId, docTitle: p.docTitle, signedAt: p.signedAt, sealed: p.sealed }));
}
export interface WMessage {
  id: string; groupId: string; groupName: string; travelerId: string | null; travelerName: string | null; travelerLang: string | null;
  kind: string; status: string; scheduledFor: string | null; sentAt: string | null; createdAt: string | null; to: string | null; journey: boolean;
}
export interface WInterest {
  id: string; groupId: string; groupName: string; createdAt: string | null; daysAgo: number | null; status: string; guests: number | null;
  cabinType: string | null; lang: string; name: string; email: string | null;
}
export interface WDeadline {
  groupId: string; groupName: string; kind: DeadlineKind; label: string; date: string; daysOut: number; done: boolean; state: "planned" | "due" | null; detail: string | null;
}
export interface WJourney {
  groupId: string; groupName: string; kind: string; label: string; date: string | null;
  planned: number; due: number; sent: number; failed: number; skipped: number; blocked: number;
}
export interface WorkspaceData {
  generatedAt: string; today: string;
  groups: WGroup[]; cabins: WCabin[]; travelers: WTraveler[]; payments: WPayment[]; paperwork: WPaperwork[];
  messages: WMessage[]; interests: WInterest[]; deadlines: WDeadline[]; journey: WJourney[];
  docs: Array<{ key: string; title: string }>; warnings: string[];
}

export const ACTIVE_STATUSES = ["draft", "marketing", "booking", "final-paid"] as const;
export const ALL_STATUSES = [...ACTIVE_STATUSES, "sailed", "closed", "cancelled"] as const;
export const isActive = (g: Pick<WGroup, "status">): boolean => (ACTIVE_STATUSES as readonly string[]).includes(g.status);

export type Tab = "groups" | "cabins" | "travelers" | "payments" | "paperwork" | "messages" | "interests" | "deadlines";
export const TABS: Tab[] = ["groups", "cabins", "travelers", "payments", "paperwork", "messages", "interests", "deadlines"];

// ── Dates ─────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const ymdMs = (d: string): number => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
export const dayDiff = (from: string, to: string): number => Math.round((ymdMs(to) - ymdMs(from)) / DAY_MS);
export const addDays = (d: string, n: number): string => new Date(ymdMs(d) + n * DAY_MS).toISOString().slice(0, 10);
/** The Monday of the week a day falls in. */
export const weekStart = (d: string): string => addDays(d, -((new Date(ymdMs(d)).getUTCDay() + 6) % 7));
export const shortDate = (d: string | null | undefined): string =>
  d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—";
export const longDate = (d: string | null | undefined): string =>
  d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";

export const shipKey = (g: Pick<WGroup, "cruiseLine" | "shipName">): string => [g.cruiseLine, g.shipName].filter(Boolean).join(" · ") || "Ship not set";

// ── Filters ───────────────────────────────────────────────────────────────────

/** A click on a chart segment. Each one narrows the grid that holds the rows it is about. */
export type CrossDim = "pay" | "cab" | "doc" | "pws" | "tf" | "dk" | "mk" | "ms" | "ix";
export interface Cross { dim: CrossDim; value: string }

export interface Filters {
  /** Group ids; empty = every group. */
  groups: string[];
  /** Statuses; empty = every status. The default is the four active ones. */
  status: string[];
  /** "Carnival · Mardi Gras" keys; empty = every ship. */
  ships: string[];
  from: string;
  to: string;
  /** "en" / "es" travelers; empty = both. */
  lang: string[];
  attention: boolean;
  x: Cross[];
}

export const defaultFilters = (): Filters => ({ groups: [], status: [...ACTIVE_STATUSES], ships: [], from: "", to: "", lang: [], attention: false, x: [] });

export const CROSS_DIMS: CrossDim[] = ["pay", "cab", "doc", "pws", "tf", "dk", "mk", "ms", "ix"];
/** The grid each cross-filter belongs to (clicking one opens that grid). */
export const CROSS_TAB: Record<CrossDim, Tab> = { pay: "payments", cab: "cabins", doc: "paperwork", pws: "paperwork", tf: "travelers", dk: "deadlines", mk: "messages", ms: "messages", ix: "interests" };

const FILTER_PARAMS = ["g", "status", "ship", "from", "to", "lang", "attn", "x"];
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True when the address carries any filter (so a stored set of filters should not replace it). */
export function hasFilterParams(search: string): boolean {
  const p = new URLSearchParams(search);
  return FILTER_PARAMS.some((k) => p.has(k));
}

export function parseFilters(search: string): Filters {
  const p = new URLSearchParams(search);
  const f = defaultFilters();
  f.groups = p.getAll("g").filter(Boolean);
  if (p.has("status")) {
    const list = p.getAll("status").filter(Boolean);
    f.status = list.includes("all") ? [] : list.filter((s) => (ALL_STATUSES as readonly string[]).includes(s));
  }
  f.ships = p.getAll("ship").filter(Boolean);
  const from = p.get("from") ?? "";
  const to = p.get("to") ?? "";
  f.from = ISO_DAY.test(from) ? from : "";
  f.to = ISO_DAY.test(to) ? to : "";
  f.lang = p.getAll("lang").filter((l) => l === "en" || l === "es");
  f.attention = p.get("attn") === "1";
  f.x = p.getAll("x").flatMap((raw): Cross[] => {
    const i = raw.indexOf(":");
    const dim = raw.slice(0, i) as CrossDim;
    return i > 0 && CROSS_DIMS.includes(dim) && raw.slice(i + 1) ? [{ dim, value: raw.slice(i + 1) }] : [];
  });
  return f;
}

/** The query string (no leading "?") for a set of filters; filters at their default leave no trace. */
export function serializeFilters(f: Filters, tab?: Tab): string {
  const p = new URLSearchParams();
  for (const g of f.groups) p.append("g", g);
  if (f.status.length === 0) p.append("status", "all");
  else if (!sameSet(f.status, ACTIVE_STATUSES)) for (const s of f.status) p.append("status", s);
  for (const s of f.ships) p.append("ship", s);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  for (const l of f.lang) p.append("lang", l);
  if (f.attention) p.set("attn", "1");
  for (const c of f.x) p.append("x", `${c.dim}:${c.value}`);
  if (tab && tab !== "groups") p.set("tab", tab);
  return p.toString();
}

export const parseTab = (search: string): Tab => {
  const t = new URLSearchParams(search).get("tab");
  return (TABS as string[]).includes(t ?? "") ? (t as Tab) : "groups";
};

/** The number of slicers that are narrowing the data (the default status set does not count). */
export function activeFilterCount(f: Filters): number {
  return (f.groups.length ? 1 : 0) + (sameSet(f.status, ACTIVE_STATUSES) ? 0 : 1) + (f.ships.length ? 1 : 0) + (f.from || f.to ? 1 : 0) + (f.lang.length ? 1 : 0) + (f.attention ? 1 : 0);
}

export const isDefaultFilters = (f: Filters): boolean => activeFilterCount(f) === 0 && f.x.length === 0;

/** Toggle a group in the Group slicer. A plain click selects that group alone (or clears it when it is the only one); an additive click (shift, ctrl or cmd) adds or removes it. */
export function toggleGroup(f: Filters, id: string, additive: boolean): Filters {
  const has = f.groups.includes(id);
  return { ...f, groups: additive ? (has ? f.groups.filter((g) => g !== id) : [...f.groups, id]) : has && f.groups.length === 1 ? [] : [id] };
}

/** Set (or, with the same value again, clear) a cross-filter. A dimension holds one value at a time. */
export function toggleCross(f: Filters, c: Cross): Filters {
  const same = f.x.some((x) => x.dim === c.dim && x.value === c.value);
  const rest = f.x.filter((x) => x.dim !== c.dim);
  return { ...f, x: same ? rest : [...rest, c] };
}
export const removeCross = (f: Filters, c: Cross): Filters => ({ ...f, x: f.x.filter((x) => !(x.dim === c.dim && x.value === c.value)) });
export const crossValue = (f: Filters, dim: CrossDim): string | null => f.x.find((x) => x.dim === dim)?.value ?? null;

// ── Slicing ───────────────────────────────────────────────────────────────────

export interface Slice {
  today: string;
  groups: WGroup[]; cabins: WCabin[]; travelers: WTraveler[]; payments: WPayment[]; paperwork: WPaperwork[];
  messages: WMessage[]; interests: WInterest[]; deadlines: WDeadline[]; journey: WJourney[];
  docs: Array<{ key: string; title: string }>;
  /** True when the language slicer is on: counts of travelers are then of named travelers, because an unnamed one has no language. */
  byLanguage: boolean;
}

export function groupMatches(g: WGroup, f: Filters): boolean {
  if (f.groups.length && !f.groups.includes(g.id)) return false;
  if (f.status.length && !f.status.includes(g.status)) return false;
  if (f.ships.length && !f.ships.includes(shipKey(g))) return false;
  if (f.from && (!g.sailDate || g.sailDate < f.from)) return false;
  if (f.to && (!g.sailDate || g.sailDate > f.to)) return false;
  if (f.attention && !g.needsAttention) return false;
  return true;
}

export function applyFilters(data: WorkspaceData, f: Filters): Slice {
  const groups = data.groups.filter((g) => groupMatches(g, f));
  const ids = new Set(groups.map((g) => g.id));
  const inGroups = <T extends { groupId: string }>(rows: T[]) => rows.filter((r) => ids.has(r.groupId));
  const speaks = (lang: string | null) => f.lang.length === 0 || (lang !== null && f.lang.includes(lang));
  const paperwork = inGroups(data.paperwork).filter((p) => speaks(p.travelerLang));
  const used = new Set(paperwork.map((p) => p.docKey));
  return {
    today: data.today,
    groups,
    cabins: inGroups(data.cabins),
    travelers: inGroups(data.travelers).filter((t) => speaks(t.lang)),
    payments: inGroups(data.payments),
    paperwork,
    messages: inGroups(data.messages).filter((m) => speaks(m.travelerLang)),
    interests: inGroups(data.interests).filter((i) => speaks(i.lang)),
    deadlines: inGroups(data.deadlines),
    journey: inGroups(data.journey),
    docs: data.docs.filter((d) => used.has(d.key)),
    byLanguage: f.lang.length > 0,
  };
}

/** The rows a grid shows: the slice's rows narrowed by the cross-filters that belong to that grid. */
export function gridRows(tab: Tab, slice: Slice, cross: Cross[]): Array<Record<string, any>> {
  const v = (dim: CrossDim) => cross.find((c) => c.dim === dim)?.value ?? null;
  switch (tab) {
    case "groups": return slice.groups;
    case "cabins": return slice.cabins.filter((c) => !v("cab") || c.status === v("cab"));
    case "travelers": return slice.travelers.filter((t) => !v("tf") || (v("tf") === "signed" ? t.fullySigned : !t.fullySigned));
    case "payments": return slice.payments.filter((p) => !v("pay") || p.status === v("pay"));
    case "paperwork": return slice.paperwork.filter((p) => (!v("doc") || p.docKey === v("doc")) && (!v("pws") || p.status === v("pws")));
    case "messages": return slice.messages.filter((m) => (!v("mk") || m.kind === v("mk")) && (!v("ms") || m.status === v("ms")));
    case "interests": return slice.interests.filter((i) => !v("ix") || i.status === v("ix"));
    case "deadlines": return slice.deadlines.filter((d) => !v("dk") || d.kind === v("dk"));
  }
}

// ── Numbers on the cards ──────────────────────────────────────────────────────

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const cents = (n: number) => Math.round(n * 100) / 100;
const amountOf = (p: WPayment) => p.amount ?? 0;

export interface Kpis {
  cabinsBooked: number; cabinsHeld: number; cabinsOffered: number; cabinsBlock: number;
  signedPeople: number; signedOf: number; signedPct: number | null;
  dueNext30: number; dueNext30Count: number;
  overdue: number; overdueCount: number;
  collected: number; collectedCount: number;
  newInterests: number;
  journeyQueued: number; journeyFailed: number;
}

export const LEADS_WINDOW_DAYS = 7;
export const DUE_WINDOW_DAYS = 30;

export function computeKpis(s: Slice): Kpis {
  const people = s.travelers.filter((t) => t.fullySigned).length;
  // Without a language slicer the denominator is what the files expect (named or not yet named); with one, only named travelers have a language.
  const of = s.byLanguage ? s.travelers.length : sum(s.groups.map((g) => g.travelersExpected));
  const due = s.payments.filter((p) => p.status === "due" && p.daysOut !== null && p.daysOut <= DUE_WINDOW_DAYS);
  const late = s.payments.filter((p) => p.status === "overdue");
  const paid = s.payments.filter((p) => p.status === "paid");
  return {
    cabinsBooked: sum(s.groups.map((g) => g.cabinsBooked)),
    cabinsHeld: sum(s.groups.map((g) => g.cabinsHeld)),
    cabinsOffered: sum(s.groups.map((g) => g.cabinsOffered)),
    cabinsBlock: sum(s.groups.map((g) => g.cabinsTotal - g.cabinsReleased)),
    signedPeople: people, signedOf: of, signedPct: of > 0 ? Math.round((people / of) * 100) : null,
    dueNext30: cents(sum(due.map(amountOf))), dueNext30Count: due.length,
    overdue: cents(sum(late.map(amountOf))), overdueCount: late.length,
    collected: cents(sum(paid.map(amountOf))), collectedCount: paid.length,
    newInterests: s.interests.filter((i) => i.daysAgo !== null && i.daysAgo >= 0 && i.daysAgo < LEADS_WINDOW_DAYS).length,
    journeyQueued: sum(s.groups.map((g) => g.journeyQueued)), journeyFailed: sum(s.groups.map((g) => g.journeyFailed)),
  };
}

// ── Pipeline funnel ───────────────────────────────────────────────────────────

export interface FunnelStep { key: string; label: string; unit: string; unitOne: string; value: number; tab: Tab; cross: Cross | null }

export function funnel(s: Slice): FunnelStep[] {
  return [
    { key: "interests", label: "Interests", unit: "replies", unitOne: "reply", value: s.interests.length, tab: "interests", cross: null },
    { key: "booked", label: "Cabins booked", unit: "cabins", unitOne: "cabin", value: sum(s.groups.map((g) => g.cabinsBooked)), tab: "cabins", cross: { dim: "cab", value: "booked" } },
    { key: "onfile", label: "Travelers on file", unit: "people", unitOne: "person", value: s.travelers.length, tab: "travelers", cross: null },
    { key: "signed", label: "Paperwork complete", unit: "people", unitOne: "person", value: s.travelers.filter((t) => t.fullySigned).length, tab: "travelers", cross: { dim: "tf", value: "signed" } },
    { key: "final", label: "Final payment paid", unit: "cabins", unitOne: "cabin", value: s.payments.filter((p) => p.kind === "final" && p.status === "paid").length, tab: "payments", cross: { dim: "pay", value: "paid" } },
  ];
}

// ── Money by week ─────────────────────────────────────────────────────────────

export interface MoneyBucket {
  key: string; label: string; weekOf: string | null;
  paid: number; due: number; overdue: number; paidCount: number; dueCount: number; overdueCount: number;
}
export interface MoneyModel { buckets: MoneyBucket[]; noDate: number; noDateCount: number; later: number; laterCount: number }

export const MONEY_WEEKS = 26;

/** An "Overdue" bar first (everything unpaid and past its date), then 26 weeks starting with this one: paid and still-due dollars by the week they fall due. */
export function moneyByWeek(payments: WPayment[], today: string, weeks = MONEY_WEEKS): MoneyModel {
  const start = weekStart(today);
  const blank = (key: string, label: string, weekOf: string | null): MoneyBucket => ({ key, label, weekOf, paid: 0, due: 0, overdue: 0, paidCount: 0, dueCount: 0, overdueCount: 0 });
  const buckets: MoneyBucket[] = [blank("overdue", "Overdue", null)];
  for (let i = 0; i < weeks; i++) buckets.push(blank(`w${i}`, shortDate(addDays(start, i * 7)), addDays(start, i * 7)));
  const model: MoneyModel = { buckets, noDate: 0, noDateCount: 0, later: 0, laterCount: 0 };
  for (const p of payments) {
    const amount = amountOf(p);
    if (!p.dueDate) {
      if (p.status !== "paid") { model.noDate = cents(model.noDate + amount); model.noDateCount++; }
      continue;
    }
    if (p.status === "overdue") { const b = buckets[0]!; b.overdue = cents(b.overdue + amount); b.overdueCount++; continue; }
    const idx = Math.floor(dayDiff(start, p.dueDate) / 7);
    if (idx < 0) continue; // paid, and due before this week: collected already, not part of the weeks ahead
    if (idx >= weeks) { model.later = cents(model.later + amount); model.laterCount++; continue; }
    const b = buckets[idx + 1]!;
    if (p.status === "paid") { b.paid = cents(b.paid + amount); b.paidCount++; } else { b.due = cents(b.due + amount); b.dueCount++; }
  }
  return model;
}

// ── Deadlines timeline ────────────────────────────────────────────────────────

export const TIMELINE_DAYS = 120;
export const TIMELINE_LOOKBACK = 14;

export const KIND_LABEL: Record<DeadlineKind, string> = {
  deposit: "Deposit", final: "Final payment", names: "Names due", recall: "Cabins go back", line: "Cruise line deadline", journey: "Journey email", sail: "Sailing",
};
/** Where in its group's row each kind sits, so markers on the same day do not sit on top of one another. */
const LANE: Record<DeadlineKind, number> = { deposit: 0.27, final: 0.27, names: 0, recall: 0, line: 0, sail: 0, journey: -0.27 };

export interface TimelinePoint { x: number; y: number; kind: DeadlineKind; label: string; date: string; daysOut: number; groupId: string; groupName: string; done: boolean; detail: string | null; state: "planned" | "due" | null }
export interface TimelineModel { rows: Array<{ groupId: string; groupName: string; y: number }>; points: TimelinePoint[]; from: number; to: number }

export function timeline(s: Slice, days = TIMELINE_DAYS): TimelineModel {
  const inWindow = s.deadlines.filter((d) => d.daysOut >= -TIMELINE_LOOKBACK && d.daysOut <= days);
  const rows = s.groups.filter((g) => inWindow.some((d) => d.groupId === g.id)).map((g, i) => ({ groupId: g.id, groupName: g.name, y: i }));
  const y = new Map(rows.map((r) => [r.groupId, r.y]));
  const points = inWindow.filter((d) => y.has(d.groupId)).map((d): TimelinePoint => ({
    x: d.daysOut, y: y.get(d.groupId)! + LANE[d.kind], kind: d.kind, label: d.label, date: d.date, daysOut: d.daysOut,
    groupId: d.groupId, groupName: d.groupName, done: d.done, detail: d.detail, state: d.state,
  }));
  return { rows, points, from: -TIMELINE_LOOKBACK, to: days };
}

// ── Journey status ────────────────────────────────────────────────────────────

/** The milestones of the journey, in the order a traveler meets them. */
export const JOURNEY_MILESTONES: Array<{ kind: string; label: string }> = [
  { kind: "confirmation", label: "Confirmation" },
  ...[120, 90, 45, 20, 10, 5, 2].map((n) => ({ kind: `t-${n}`, label: `T-${n}` })),
];

export interface JourneyBar { kind: string; label: string; planned: number; sent: number; failed: number; skipped: number }

export function journeyBars(s: Slice): JourneyBar[] {
  return JOURNEY_MILESTONES.map(({ kind, label }) => {
    const rows = s.journey.filter((j) => j.kind === kind);
    return { kind, label, planned: sum(rows.map((r) => r.planned + r.due)), sent: sum(rows.map((r) => r.sent)), failed: sum(rows.map((r) => r.failed)), skipped: sum(rows.map((r) => r.skipped)) };
  });
}

// ── Paperwork matrix ──────────────────────────────────────────────────────────

export type Cell = "signed" | "pending" | "n/a";
export interface MatrixRow { travelerId: string; name: string; cabinNum: string | null; cells: Record<string, Cell>; signed: number; required: number }
export interface MatrixGroup { groupId: string; groupName: string; rows: MatrixRow[] }
export interface MatrixModel { columns: Array<{ key: string; title: string }>; groups: MatrixGroup[] }

export function paperworkMatrix(s: Slice): MatrixModel {
  const columns = s.docs;
  const byTraveler = new Map<string, WPaperwork[]>();
  for (const p of s.paperwork) {
    const list = byTraveler.get(p.travelerId);
    if (list) list.push(p); else byTraveler.set(p.travelerId, [p]);
  }
  const groups: MatrixGroup[] = [];
  for (const g of s.groups) {
    const people = s.travelers.filter((t) => t.groupId === g.id && byTraveler.has(t.id))
      .sort((a, b) => String(a.cabinNum ?? "~").localeCompare(String(b.cabinNum ?? "~"), undefined, { numeric: true }) || Number(b.isLead) - Number(a.isLead) || a.name.localeCompare(b.name));
    if (!people.length) continue;
    groups.push({
      groupId: g.id, groupName: g.name,
      rows: people.map((t) => {
        const mine = byTraveler.get(t.id)!;
        const cells: Record<string, Cell> = {};
        for (const c of columns) cells[c.key] = mine.find((p) => p.docKey === c.key)?.status ?? "n/a";
        return { travelerId: t.id, name: t.name, cabinNum: t.cabinNum, cells, signed: mine.filter((p) => p.status === "signed").length, required: mine.length };
      }),
    });
  }
  return { columns, groups };
}

// ── The big picture on the Group Bookings tab ─────────────────────────────────

export interface NextDeadline { groupId: string; groupName: string; label: string; date: string; daysOut: number }

/** The kinds of deadline a person can miss (the group's own deposit, final-payment and names dates). The others (the line taking cabins back, a date in the quote) are events: once they pass they are history, not a failure. */
export const missable = (kind: DeadlineKind): boolean => kind === "deposit" || kind === "final" || kind === "names";

/** The next dated things to do across groups: not already met, not an email, not the sailing; a missed one (up to two weeks back) comes first. */
export function nextDeadlines(s: Slice, n = 5): NextDeadline[] {
  return s.deadlines
    .filter((d) => !d.done && d.kind !== "journey" && d.kind !== "sail" && (d.daysOut >= 0 || (missable(d.kind) && d.daysOut >= -TIMELINE_LOOKBACK)))
    .sort((a, b) => a.daysOut - b.daysOut || a.groupName.localeCompare(b.groupName))
    .slice(0, n)
    .map((d) => ({ groupId: d.groupId, groupName: d.groupName, label: d.label, date: d.date, daysOut: d.daysOut }));
}

export function bigPicture(data: WorkspaceData) {
  const s = applyFilters(data, defaultFilters());
  return { activeGroups: s.groups.length, kpis: computeKpis(s), next: nextDeadlines(s), needAttention: s.groups.filter((g) => g.needsAttention).length };
}

// ── Chips ─────────────────────────────────────────────────────────────────────

const PAY_WORDS: Record<string, string> = { paid: "paid", due: "still to come", overdue: "overdue", "no date": "no date" };
export function crossLabel(c: Cross, docs: Array<{ key: string; title: string }> = []): string {
  const doc = (k: string) => docs.find((d) => d.key === k)?.title ?? k;
  switch (c.dim) {
    case "pay": return `Payments: ${PAY_WORDS[c.value] ?? c.value}`;
    case "cab": return `Cabins: ${c.value}`;
    case "doc": return `Paperwork: ${doc(c.value)}`;
    case "pws": return `Paperwork: ${c.value}`;
    case "tf": return `Travelers: ${c.value === "signed" ? "fully signed" : "not fully signed"}`;
    case "dk": return `Deadlines: ${KIND_LABEL[c.value as DeadlineKind] ?? c.value}`;
    case "mk": return `Emails: ${JOURNEY_MILESTONES.find((m) => m.kind === c.value)?.label ?? c.value}`;
    case "ms": return `Emails: ${c.value}`;
    case "ix": return `Leads: ${c.value}`;
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export type CsvValue = string | number | boolean | null | undefined;

/** One CSV cell. A cell that starts with = + - @ is prefixed so a spreadsheet reads it as text, never as a formula. */
export function csvCell(v: CsvValue): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "boolean" ? (v ? "yes" : "no") : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCsv = (headers: string[], rows: CsvValue[][]): string =>
  [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
