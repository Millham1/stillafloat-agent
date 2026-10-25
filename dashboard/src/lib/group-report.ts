// group-report.ts — the Group Bookings Workspace as a Power BI-style report (Mark 2026-10-25).
//
// Mark: "it shouldnt be this one big scrolling document. it should be a power BI format that leads the clicks to bring up
// specific pieces." So the workspace is a set of one-screen REPORT PAGES (tabs along the bottom), and a click on a traveler,
// group, cabin, payment or lead opens that item's own DRILL-THROUGH page, with a back arrow.
//
// This file is the pure part: which page and drill the address names, the numbers each page shows, and what a drill page
// gathers about one item. The filters, the slice and the charts' models stay in group-workspace.ts.

import {
  computeKpis, dayDiff, missable, moneyByWeek, serializeFilters,
  type Filters, type Slice, type WCabin, type WDeadline, type WGroup, type WInterest, type WMessage, type WPaperwork, type WPayment,
  type WTraveler, type WorkspaceData,
} from "./group-workspace";

// ── Pages and drill-through in the address ───────────────────────────────────

export type Page = "overview" | "cabins" | "paperwork" | "money" | "deadlines" | "journey" | "leads";
export const PAGES: Page[] = ["overview", "cabins", "paperwork", "money", "deadlines", "journey", "leads"];
export const PAGE_LABEL: Record<Page, string> = {
  overview: "Overview", cabins: "Cabins", paperwork: "Paperwork", money: "Money", deadlines: "Deadlines", journey: "Journey emails", leads: "Leads",
};
/** Links made before the report pages (…?tab=payments) still land on the matching page. */
const LEGACY_TAB: Record<string, Page> = {
  groups: "overview", cabins: "cabins", travelers: "paperwork", paperwork: "paperwork", payments: "money", messages: "journey", interests: "leads", deadlines: "deadlines",
};

export type DrillKind = "traveler" | "group" | "cabin" | "payment" | "lead";
export interface Drill { kind: DrillKind; id: string }
export const DRILL_LABEL: Record<DrillKind, string> = { traveler: "traveler", group: "group", cabin: "cabin", payment: "payment", lead: "lead" };

export function parsePage(search: string): Page {
  const p = new URLSearchParams(search);
  const v = p.get("page");
  if (v && (PAGES as string[]).includes(v)) return v as Page;
  const t = p.get("tab");
  return (t && LEGACY_TAB[t]) || "overview";
}

export function parseDrill(search: string): Drill | null {
  const m = /^(traveler|group|cabin|payment|lead):([A-Za-z0-9_-]{1,64})$/.exec(new URLSearchParams(search).get("d") ?? "");
  return m ? { kind: m[1] as DrillKind, id: m[2]! } : null;
}

/** The address (no leading "?") for filters + page + an optional drill. The overview and "no drill" leave no trace. */
export function reportQuery(f: Filters, page: Page, drill: Drill | null = null): string {
  const p = new URLSearchParams(serializeFilters(f));
  if (page !== "overview") p.set("page", page);
  if (drill) p.set("d", `${drill.kind}:${drill.id}`);
  return p.toString();
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const cents = (n: number) => Math.round(n * 100) / 100;
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);

// ── Paperwork page ───────────────────────────────────────────────────────────

export interface PaperworkKpis {
  onFile: number; expected: number; fullySigned: number;
  /** Travelers whose link went out but was never opened (not complete). */
  sentNotOpened: number; oldestUnopenedDays: number | null;
  signedDocs: number; sealedDocs: number;
}

export function paperworkKpis(s: Slice): PaperworkKpis {
  const unopened = s.travelers.filter((t) => t.formSentAt && !t.formOpenedAt && !t.fullySigned);
  const ages = unopened.map((t) => dayDiff(day(t.formSentAt)!, s.today));
  const signed = s.paperwork.filter((p) => p.status === "signed");
  return {
    onFile: s.travelers.length,
    expected: Math.max(s.travelers.length, sum(s.groups.map((g) => g.travelersExpected))),
    fullySigned: s.travelers.filter((t) => t.fullySigned).length,
    sentNotOpened: unopened.length, oldestUnopenedDays: ages.length ? Math.max(...ages) : null,
    signedDocs: signed.length, sealedDocs: signed.filter((p) => p.sealed).length,
  };
}

export interface DocCounts { signed: number; pending: number; notSent: number }

/** Every document asked of a traveler: signed, pending (the link went out), or not sent (no link yet). */
export function docStatusCounts(s: Slice): DocCounts {
  const sentTo = new Set(s.travelers.filter((t) => t.formSentAt || t.formSubmittedAt).map((t) => t.id));
  const out: DocCounts = { signed: 0, pending: 0, notSent: 0 };
  for (const p of s.paperwork) {
    if (p.status === "signed") out.signed++;
    else if (sentTo.has(p.travelerId)) out.pending++;
    else out.notSent++;
  }
  return out;
}

export interface Waiting { travelerId: string; name: string; groupName: string; days: number; signed: number; required: number }

/** Travelers who have a link but have not finished, longest wait first. */
export function waitingLongest(s: Slice, n = 8): Waiting[] {
  return s.travelers
    .filter((t) => t.formSentAt && !t.fullySigned)
    .map((t) => ({ travelerId: t.id, name: t.name, groupName: t.groupName, days: Math.max(0, dayDiff(day(t.formSentAt)!, s.today)), signed: t.docsSigned, required: t.docsRequired }))
    .sort((a, b) => b.days - a.days || a.name.localeCompare(b.name))
    .slice(0, n);
}

// ── Cabins page ──────────────────────────────────────────────────────────────

export const CABIN_STATUSES = ["booked", "held", "offered", "released", "cancelled"] as const;

export function cabinStatusCounts(s: Slice): Array<{ status: string; count: number }> {
  const known = new Set<string>(CABIN_STATUSES);
  const extra = [...new Set(s.cabins.map((c) => c.status).filter((x) => !known.has(x)))].sort();
  return [...CABIN_STATUSES, ...extra].map((status) => ({ status, count: s.cabins.filter((c) => c.status === status).length })).filter((r) => r.count > 0);
}

export interface CabinKpis { booked: number; held: number; offered: number; released: number; bookedValue: number }

export function cabinKpis(s: Slice): CabinKpis {
  const n = (st: string) => s.cabins.filter((c) => c.status === st).length;
  return {
    booked: n("booked"), held: n("held"), offered: n("offered"), released: n("released") + n("cancelled"),
    bookedValue: cents(sum(s.cabins.filter((c) => c.status === "booked").map((c) => c.priceTotal ?? 0))),
  };
}

// ── Money, deadlines, journey, leads ─────────────────────────────────────────

export interface MoneyKpis { collected: number; collectedCount: number; due30: number; due30Count: number; overdue: number; overdueCount: number; noDate: number; noDateCount: number }

export function moneyKpis(s: Slice): MoneyKpis {
  const k = computeKpis(s);
  const m = moneyByWeek(s.payments, s.today);
  return { collected: k.collected, collectedCount: k.collectedCount, due30: k.dueNext30, due30Count: k.dueNext30Count, overdue: k.overdue, overdueCount: k.overdueCount, noDate: m.noDate, noDateCount: m.noDateCount };
}

export interface DeadlineKpis { next30: number; missed: number; met: number; nextLabel: string | null; nextDate: string | null }

export function deadlineKpis(s: Slice): DeadlineKpis {
  const open = s.deadlines.filter((d) => !d.done);
  const ahead = open.filter((d) => d.daysOut >= 0).sort((a, b) => a.daysOut - b.daysOut);
  return {
    next30: ahead.filter((d) => d.daysOut <= 30).length,
    missed: open.filter((d) => d.daysOut < 0 && missable(d.kind)).length,
    met: s.deadlines.filter((d) => d.done).length,
    nextLabel: ahead[0] ? `${ahead[0].label} · ${ahead[0].groupName}` : null, nextDate: ahead[0]?.date ?? null,
  };
}

export interface JourneyKpis { sent: number; failed: number; queued: number; planned: number }

export function journeyKpis(s: Slice): JourneyKpis {
  const msgs = s.messages.filter((m) => m.journey);
  return {
    sent: msgs.filter((m) => m.status === "sent").length,
    failed: msgs.filter((m) => m.status === "failed").length,
    queued: msgs.filter((m) => m.status === "queued" || m.status === "approved").length,
    planned: sum(s.journey.map((j) => j.planned)),
  };
}

export interface LeadKpis { newThisWeek: number; total: number; byStatus: Array<{ status: string; count: number }> }

export const LEAD_STATUSES = ["new", "contacted", "booked", "declined"] as const;

export function leadKpis(s: Slice): LeadKpis {
  const known = new Set<string>(LEAD_STATUSES);
  const extra = [...new Set(s.interests.map((i) => i.status).filter((x) => !known.has(x)))].sort();
  return {
    newThisWeek: computeKpis(s).newInterests, total: s.interests.length,
    byStatus: [...LEAD_STATUSES, ...extra].map((status) => ({ status, count: s.interests.filter((i) => i.status === status).length })),
  };
}

// ── Drill-through: everything about one item (read from ALL the data, so a slicer never hides the page you opened) ──

export interface TravelerDetail {
  t: WTraveler; group: WGroup | null; cabin: WCabin | null; mates: WTraveler[];
  docs: WPaperwork[]; messages: WMessage[]; payments: WPayment[];
}
export function travelerDetail(d: WorkspaceData, id: string): TravelerDetail | null {
  const t = d.travelers.find((x) => x.id === id);
  if (!t) return null;
  return {
    t, group: d.groups.find((g) => g.id === t.groupId) ?? null,
    cabin: t.cabinId ? d.cabins.find((c) => c.id === t.cabinId) ?? null : null,
    mates: t.cabinId ? d.travelers.filter((x) => x.cabinId === t.cabinId && x.id !== t.id) : [],
    docs: d.paperwork.filter((p) => p.travelerId === id),
    messages: d.messages.filter((m) => m.travelerId === id),
    payments: t.cabinId ? d.payments.filter((p) => p.cabinId === t.cabinId) : [],
  };
}

export interface GroupDetail { g: WGroup; cabins: WCabin[]; travelers: WTraveler[]; payments: WPayment[]; deadlines: WDeadline[]; interests: WInterest[] }
export function groupDetail(d: WorkspaceData, id: string): GroupDetail | null {
  const g = d.groups.find((x) => x.id === id);
  if (!g) return null;
  const mine = <T extends { groupId: string }>(xs: T[]) => xs.filter((x) => x.groupId === id);
  return {
    g, cabins: mine(d.cabins), travelers: mine(d.travelers), payments: mine(d.payments),
    deadlines: mine(d.deadlines).filter((x) => !x.done).sort((a, b) => a.daysOut - b.daysOut), interests: mine(d.interests),
  };
}

export interface CabinDetail { c: WCabin; group: WGroup | null; travelers: WTraveler[]; payments: WPayment[] }
export function cabinDetail(d: WorkspaceData, id: string): CabinDetail | null {
  const c = d.cabins.find((x) => x.id === id);
  if (!c) return null;
  return { c, group: d.groups.find((g) => g.id === c.groupId) ?? null, travelers: d.travelers.filter((t) => t.cabinId === id), payments: d.payments.filter((p) => p.cabinId === id) };
}

export interface PaymentDetail { p: WPayment; group: WGroup | null; cabin: WCabin | null }
export function paymentDetail(d: WorkspaceData, id: string): PaymentDetail | null {
  const p = d.payments.find((x) => x.id === id);
  if (!p) return null;
  return { p, group: d.groups.find((g) => g.id === p.groupId) ?? null, cabin: p.cabinId ? d.cabins.find((c) => c.id === p.cabinId) ?? null : null };
}

export interface LeadDetail { i: WInterest; group: WGroup | null }
export function leadDetail(d: WorkspaceData, id: string): LeadDetail | null {
  const i = d.interests.find((x) => x.id === id);
  if (!i) return null;
  return { i, group: d.groups.find((g) => g.id === i.groupId) ?? null };
}
