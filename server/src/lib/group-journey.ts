// group-journey.ts — the journey after the paperwork: who is told what, and when, and the words of every message.
// Mark 2026-10-16: "simulate the entire process from entering a group to building the marketing and a customer
// CTA, adding info and the confirmation process, then the follow up emails for 120, 90, 45, 20, 10, 5 and 2 days
// before, checklists, follow up data needed, change notifications, ship info, weather (5 day prior report),
// embarkation what to know (with links to youtube videos) ... the whole package top to bottom."
//
// PURE: rows in, plans and rendered messages out. Nothing here sends, reads a database or calls the network; the
// engine that does is group-journey-run.ts, wired to Supabase by group-journey-store.ts.
//
// THE RULES THIS FILE ENFORCES
//   * A template is approved ONCE (Mark 2026-10-02): the plan marks a due message "blocked" until its kind is approved
//     for the group, or by the site default, at the CURRENT template version. Changing the words here bumps
//     JOURNEY_TEMPLATE_VERSION, which makes every earlier approval stale on purpose.
//   * Nobody is mailed a backlog. Of the milestones that have come due and not gone out, only the latest is sent; the
//     earlier ones are skipped as superseded. One message per traveler per tick.
//   * Every message is one primary button to the traveler's cruise page, then the plain link, then Mark's contact
//     line, then "Still Afloat Cruising" on its own line.
//   * Every fact comes from the group file; a section whose data is missing is left out (group-journey-sections.ts).

import { BUSINESS } from "./group-secure";
import {
  addDays, cabinIsBooked, cabinOf, cabinPayments, clientChecklist, ctxFor, dayDiff, displayName, emailOf, fmtDate, fmtMoney, journeyAnswers,
  langOf, localToday, matesOf, missingItems, payee, personName, plain, ymd,
  type Ctx, type JourneyInput, type Row, type Section,
} from "./group-journey-facts";
import * as sec from "./group-journey-sections";
import { DAY_MILESTONES, dayKind, kindDays, milestoneDate, type ChangeNotice } from "./group-journey-sections";
import { strings, type Lang, type MilestoneKind } from "./group-journey-strings";

export { DAY_MILESTONES, dayKind, kindDays };
export type { ChangeNotice, MilestoneKind };

// ── Constants ─────────────────────────────────────────────────────────────────

/** Bump this whenever the words of any template change: every earlier approval then needs Mark's eye again. */
export const JOURNEY_TEMPLATE_VERSION = "2026-10-17.1";

/** Group statuses the journey writes to. 'booked' is not a status in migration 0041; final-paid is the booked-and-paid state. */
export const ACTIVE_GROUP_STATUSES = ["marketing", "booking", "final-paid"] as const;

/** The kinds Mark approves. A change notice is composed and previewed by Mark himself, so sending it is its approval. */
export const APPROVABLE_KINDS: MilestoneKind[] = ["confirmation", "t-120", "t-90", "t-45", "t-20", "t-10", "t-5", "t-2", "payment-due", "data-needed"];
export const ALL_KINDS: MilestoneKind[] = [...APPROVABLE_KINDS, "change-notice"];

/** The milestones that ask the traveler for something; a nudge follows one that went unanswered. */
export const ASKING_KINDS: MilestoneKind[] = ["t-120", "t-90", "t-45"];
export const NUDGE_AFTER_DAYS = 7;
export const PAYMENT_STAGES = [14, 3] as const;
export const MAX_ATTEMPTS = 3;
/** A message left "queued" this long never went out (a crash between the insert and the send). */
export const STUCK_QUEUE_MS = 30 * 60_000;

export const KIND_LABEL: Record<MilestoneKind, string> = {
  confirmation: "Booking confirmed", "t-120": "120 days before", "t-90": "90 days before", "t-45": "45 days before", "t-20": "20 days before",
  "t-10": "10 days before", "t-5": "5 days before (weather)", "t-2": "2 days before", "payment-due": "Payment due (14 and 3 days ahead)",
  "data-needed": "Missing details (7 days after a request)", "change-notice": "Change notice (from you)",
};

export const dedupeKey = (kind: string, travelerId: string, sailDate: string | null, extra?: string): string =>
  `journey:${kind}:${travelerId}:${sailDate ?? "no-date"}${extra ? `:${extra}` : ""}`;

// ── Approvals ─────────────────────────────────────────────────────────────────

export interface ApprovalEntry { approved: boolean; at: string; version: string }
export interface JourneyDefaults { approved: Record<string, ApprovalEntry>; videoSources?: string[] }
export interface ApprovalState { approved: boolean; source: "group" | "default" | "none"; at: string | null; stale: boolean }

const entryOf = (src: unknown, kind: string): ApprovalEntry | null => {
  const e = (src as Row | null | undefined)?.approved?.[kind];
  return e && typeof e === "object" && typeof e.approved === "boolean" ? (e as ApprovalEntry) : null;
};

/** Is this kind approved for the group? The group's own decision wins; otherwise the site default; an approval of older words is stale, which is not an approval. */
export function approvalFor(kind: MilestoneKind, groupJourney: unknown, defaults: JourneyDefaults | null | undefined, version = JOURNEY_TEMPLATE_VERSION): ApprovalState {
  const own = entryOf(groupJourney, kind);
  const e = own ?? entryOf(defaults, kind);
  if (!e) return { approved: false, source: "none", at: null, stale: false };
  const stale = e.version !== version;
  return { approved: e.approved && !stale, source: own ? "group" : "default", at: e.at ?? null, stale: e.approved && stale };
}

/** The group's journey object with these kinds approved (or withdrawn). */
export function withApproval(journey: unknown, kinds: readonly string[], approved: boolean, now: Date, version = JOURNEY_TEMPLATE_VERSION): Row {
  const base: Row = journey && typeof journey === "object" && !Array.isArray(journey) ? { ...(journey as Row) } : {};
  const map: Row = { ...(base["approved"] ?? {}) };
  for (const k of kinds) if ((APPROVABLE_KINDS as string[]).includes(k)) map[k] = { approved, at: now.toISOString(), version };
  base["approved"] = map;
  return base;
}

export const videoSourcesFor = (journey: unknown, defaults: JourneyDefaults | null | undefined): string[] => {
  const pick = (x: unknown) => (Array.isArray((x as Row | null)?.videoSources) ? ((x as Row).videoSources as unknown[]).filter((v): v is string => typeof v === "string") : null);
  return pick(journey) ?? pick(defaults) ?? ["own"];
};

// ── The plan ──────────────────────────────────────────────────────────────────

export type ItemStatus = "planned" | "due" | "sent" | "failed" | "skipped";

export interface PlanItem {
  kind: MilestoneKind;
  travelerId: string;
  key: string;
  /** The day it goes out (null for an event, like a booking number appearing). */
  date: string | null;
  status: ItemStatus;
  /** Why it was skipped, or why a due message cannot go yet. */
  reason: string | null;
  /** Set on a due item that must not be sent right now (template not approved, group not live). */
  blocked: string | null;
  paymentId?: string;
  stage?: number;
  after?: MilestoneKind;
}

export interface TravelerPlan { id: string; name: string; lang: Lang; hasEmail: boolean; items: PlanItem[] }

export interface JourneyPlan {
  today: string;
  sailDate: string | null;
  daysToSail: number | null;
  /** False when nothing may be sent for this group right now, and why. */
  live: boolean;
  liveReason: string | null;
  travelers: TravelerPlan[];
}

export interface PlanOptions {
  tz?: string;
  /** Is the template approved for this group? Defaults to "no". */
  isApproved?: (kind: MilestoneKind) => boolean;
}

interface Sent { status: string; sentAt: string | null; attempts: number; stuck: boolean }

function messageIndex(messages: readonly Row[], now: Date): Map<string, Sent> {
  const out = new Map<string, Sent>();
  for (const m of messages) {
    if (typeof m.dedupe_key !== "string" || !m.dedupe_key.startsWith("journey:")) continue;
    const at = Date.parse(String(m.updated_at ?? m.created_at ?? ""));
    out.set(m.dedupe_key, {
      status: String(m.status), sentAt: m.sent_at ?? null, attempts: Number(m.meta?.attempts) || (m.status === "failed" ? 1 : 0),
      stuck: m.status === "queued" && Number.isFinite(at) && now.getTime() - at > STUCK_QUEUE_MS,
    });
  }
  return out;
}

export function planJourney(input: JourneyInput, now: Date, opts: PlanOptions = {}): JourneyPlan {
  const today = localToday(now, opts.tz);
  const g = input.group;
  const sail = ymd(g.sail_date);
  const days = sail ? dayDiff(today, sail) : null;
  const approved = opts.isApproved ?? (() => false);
  const sent = messageIndex(input.messages, now);
  let liveReason: string | null = null;
  if (!(ACTIVE_GROUP_STATUSES as readonly string[]).includes(g.status)) liveReason = `The group is "${g.status}"; the journey writes to groups that are marketing, booking or final-paid.`;
  else if (!sail) liveReason = "The group has no sail date.";
  else if (days! < 0) liveReason = "The sailing has passed.";
  const live = liveReason === null;

  const travelers: TravelerPlan[] = input.travelers.map((t) => {
    const cabin = cabinOf(input, t);
    const email = emailOf(t);
    const base: string | null = !sail ? "no sail date on the group" : days! < 0 ? "the sailing has passed" : !cabinIsBooked(cabin) ? "cabin not booked yet" : !email ? "no email address on file" : null;
    const items: PlanItem[] = [];
    const add = (i: Omit<PlanItem, "travelerId" | "blocked" | "reason"> & { reason?: string | null }) => {
      const blocked = i.status === "due" ? (!live ? liveReason : !approved(i.kind) ? "the template is not approved yet" : null) : null;
      items.push({ travelerId: t.id, blocked, reason: i.reason ?? null, ...i });
    };
    /** Look the key up in the log: sent, out of retries, or free to send. */
    const history = (kind: MilestoneKind, extra?: string) => {
      const key = dedupeKey(kind, t.id, sail, extra);
      const m = sent.get(key);
      if (m?.status === "sent") return { key, status: "sent" as ItemStatus, reason: null as string | null };
      if (m?.status === "skipped") return { key, status: "skipped" as ItemStatus, reason: "skipped" };
      if (m?.status === "failed" && m.attempts >= MAX_ATTEMPTS) return { key, status: "failed" as ItemStatus, reason: `failed ${m.attempts} times` };
      if (m && m.status === "queued" && !m.stuck) return { key, status: "sent" as ItemStatus, reason: "being sent" };
      return { key, status: null as ItemStatus | null, reason: null as string | null };
    };

    // The booking confirmation: when the cabin has a booking number.
    {
      const h = history("confirmation");
      if (h.status) add({ kind: "confirmation", key: h.key, date: null, status: h.status, reason: h.reason });
      else if (base) add({ kind: "confirmation", key: h.key, date: null, status: "skipped", reason: base });
      else if (!plain(cabin?.booking_number)) add({ kind: "confirmation", key: h.key, date: null, status: "planned", reason: "waiting for a booking number" });
      else add({ kind: "confirmation", key: h.key, date: null, status: "due" });
    }

    // The countdown milestones: only the latest one that has come due goes out.
    const dated = DAY_MILESTONES.map((n) => ({ n, kind: dayKind(n), date: sail ? addDays(sail, -n) : null }));
    const latestDue = [...dated].reverse().find((m) => m.date !== null && m.date <= today);
    for (const m of dated) {
      const h = history(m.kind);
      if (h.status) { add({ kind: m.kind, key: h.key, date: m.date, status: h.status, reason: h.reason }); continue; }
      if (base) { add({ kind: m.kind, key: h.key, date: m.date, status: "skipped", reason: base }); continue; }
      if (!m.date || m.date > today) { add({ kind: m.kind, key: h.key, date: m.date, status: "planned" }); continue; }
      if (days! < 1) { add({ kind: m.kind, key: h.key, date: m.date, status: "skipped", reason: "sailing day: too late for this one" }); continue; }
      if (latestDue && m.n !== latestDue.n) { add({ kind: m.kind, key: h.key, date: m.date, status: "skipped", reason: `superseded by the ${latestDue.n}-day message` }); continue; }
      add({ kind: m.kind, key: h.key, date: m.date, status: "due" });
    }

    // Payments: one message to the cabin's payee, 14 and 3 days before each unpaid date.
    if (cabin && payee(input, cabin)?.id === t.id) {
      for (const p of cabinPayments(input, cabin)) {
        const due = ymd(p.due_date);
        if (p.paid_at || !due) continue;
        for (const stage of PAYMENT_STAGES) {
          const date = addDays(due, -stage);
          const extra = `${p.id}:${stage}`;
          const h = history("payment-due", extra);
          const common = { kind: "payment-due" as MilestoneKind, key: h.key, date, paymentId: String(p.id), stage };
          if (h.status) { add({ ...common, status: h.status, reason: h.reason }); continue; }
          if (!(Number(p.amount) > 0)) { add({ ...common, status: "skipped", reason: "no amount on file for this payment" }); continue; }
          if (base) { add({ ...common, status: "skipped", reason: base }); continue; }
          if (date > today) { add({ ...common, status: "planned" }); continue; }
          if (today > due) { add({ ...common, status: "skipped", reason: "the date has passed" }); continue; }
          if (stage === 14 && today >= addDays(due, -3)) { add({ ...common, status: "skipped", reason: "superseded by the 3-day message" }); continue; }
          add({ ...common, status: "due" });
        }
      }
    }

    // A nudge, 7 days after the latest request that went out, if something is still missing.
    const askSent = [...ASKING_KINDS].reverse().find((k) => sent.get(dedupeKey(k, t.id, sail))?.status === "sent");
    if (askSent) {
      const at = ymd(sent.get(dedupeKey(askSent, t.id, sail))!.sentAt);
      const date = at ? addDays(at, NUDGE_AFTER_DAYS) : null;
      const h = history("data-needed", askSent);
      const common = { kind: "data-needed" as MilestoneKind, key: h.key, date, after: askSent };
      if (h.status) add({ ...common, status: h.status, reason: h.reason });
      else if (base) add({ ...common, status: "skipped", reason: base });
      else if (!date || date > today) add({ ...common, status: "planned" });
      else if (!missingItems(input, t, cabin).length) add({ ...common, status: "skipped", reason: "nothing is missing" });
      else if (days! < 3) add({ ...common, status: "skipped", reason: "too close to sailing" });
      else add({ ...common, status: "due" });
    }

    return { id: t.id, name: personName(t) || "Unnamed traveler", lang: langOf(t), hasEmail: !!email, items };
  });

  return { today, sailDate: sail, daysToSail: days, live, liveReason, travelers };
}

export interface MilestoneSummary {
  kind: MilestoneKind;
  label: string;
  /** The day it goes out for the day milestones; null for events. */
  date: string | null;
  counts: Record<ItemStatus, number> & { blocked: number };
  /** A traveler id to preview the template with (first one with the most data). */
  sampleTravelerId: string | null;
}

/** One line per kind, with how many travelers are in each state. */
export function summarizePlan(plan: JourneyPlan, group: Row): MilestoneSummary[] {
  return ALL_KINDS.map((kind) => {
    const counts = { planned: 0, due: 0, sent: 0, failed: 0, skipped: 0, blocked: 0 };
    let sample: string | null = null;
    for (const t of plan.travelers) {
      const mine = t.items.filter((i) => i.kind === kind);
      for (const i of mine) { counts[i.status]++; if (i.blocked) counts.blocked++; }
      if (!sample && mine.length && mine.some((i) => i.status !== "skipped")) sample = t.id;
    }
    const n = kindDays(kind);
    return { kind, label: KIND_LABEL[kind], date: n !== null ? milestoneDate(group, n) : null, counts, sampleTravelerId: sample ?? plan.travelers[0]?.id ?? null };
  });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const NAVY = "#07183f";
const GOLD = "#ffca4f";
const RULE = "#9db1cf";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const httpUrl = (u: string): string => (/^https?:\/\//i.test(u) ? u : "#");

function sectionHtml(sx: Section): string {
  const out: string[] = [];
  if (sx.title) out.push(`<h2 style="font-family:Georgia,'Times New Roman',serif;font-weight:normal;font-size:22px;line-height:1.25;color:${NAVY};margin:26px 0 8px">${esc(sx.title)}</h2>`);
  for (const l of sx.lines) out.push(`<p style="margin:0 0 12px">${esc(l)}</p>`);
  if (sx.items?.length) {
    out.push(`<ul style="margin:0 0 14px;padding-left:24px">${sx.items.map((i) => `<li style="margin:0 0 6px">${i.url ? `<a href="${esc(httpUrl(i.url))}" style="color:${NAVY}">${esc(i.text)}</a>` : esc(i.text)}</li>`).join("")}</ul>`);
  }
  if (sx.table) {
    const cell = (tag: "th" | "td", v: string) => `<${tag} style="border:1px solid ${RULE};padding:7px 9px;text-align:left;vertical-align:top;font-size:17px${tag === "th" ? ";background:#eaf3ff" : ""}">${esc(v)}</${tag}>`;
    out.push(`<table role="presentation" style="border-collapse:collapse;width:100%;margin:0 0 14px"><tr>${sx.table.head.map((h) => cell("th", h)).join("")}</tr>${sx.table.rows.map((r) => `<tr>${r.map((c) => cell("td", c)).join("")}</tr>`).join("")}</table>`);
  }
  for (const l of sx.links ?? []) out.push(`<p style="margin:0 0 12px"><a href="${esc(httpUrl(l.url))}" style="color:${NAVY};font-weight:bold">${esc(l.label)}</a></p>`);
  return out.join("");
}

function sectionText(sx: Section): string {
  const out: string[] = [];
  if (sx.title) out.push(sx.title.toUpperCase());
  out.push(...sx.lines);
  for (const i of sx.items ?? []) out.push(`- ${i.text}${i.url ? ` (${i.url})` : ""}`);
  if (sx.table) { out.push(sx.table.head.join(" | ")); for (const r of sx.table.rows) out.push(r.join(" | ")); }
  for (const l of sx.links ?? []) out.push(`${l.label}: ${l.url}`);
  return out.join("\n");
}

export interface Rendered {
  kind: MilestoneKind;
  lang: Lang;
  subject: string;
  html: string;
  text: string;
  /** The keys of the sections that made it into the message, in order. */
  sections: string[];
  blocks: Section[];
}

export interface RenderOptions { payment?: Row; notice?: ChangeNotice }

function intoSections(list: Array<Section | Section[] | null | undefined>): Section[] {
  return list.flat().filter((x): x is Section => !!x && (x.lines.length > 0 || !!x.items?.length || !!x.table || !!x.links?.length || !!x.checklist?.length || !!x.form));
}

/** The sections of each message, in order. A builder that returns null is a section the file cannot support. */
export function sectionsFor(kind: MilestoneKind, ctx: Ctx, o: RenderOptions = {}): Section[] {
  const g = ctx.group;
  const to = (n: number) => milestoneDate(g, n);
  switch (kind) {
    case "confirmation": return intoSections([sec.booked(ctx), sec.signed(ctx), sec.paperwork(ctx), sec.payments(ctx, { mode: "schedule", howTo: true }), sec.next(ctx)]);
    case "t-120": return intoSections([
      sec.sailing(ctx), sec.payments(ctx, { mode: "schedule", howTo: true }), sec.paperwork(ctx), sec.passport(ctx), sec.insurance(ctx, { video: true }),
      sec.checklist(ctx, { kinds: ["task"], to: to(90), includeUndated: true }),
    ]);
    case "t-90": return intoSections([
      sec.sailing(ctx), sec.payments(ctx, { mode: "open" }), sec.deadlines(ctx), sec.travel(ctx),
      sec.checklist(ctx, { kinds: ["task"], to: to(45), includeUndated: false }),
    ]);
    case "t-45": return intoSections([
      sec.sailing(ctx), sec.excursions(ctx), sec.dining(ctx), sec.missing(ctx),
      sec.checklist(ctx, { kinds: ["task"], to: to(20), includeUndated: false }),
    ]);
    case "t-20": return intoSections([
      sec.sailing(ctx), sec.checkin(ctx, "opens"), sec.documents(ctx), sec.packing(ctx), sec.videos(ctx, ["packing"]),
      sec.checklist(ctx, { kinds: ["task"], to: to(10), includeUndated: false }),
    ]);
    case "t-10": return intoSections([sec.sailing(ctx), sec.ship(ctx), sec.embark1(ctx), sec.videos(ctx, ["embark"])]);
    case "t-5": return intoSections([sec.sailing(ctx), sec.storm(ctx), sec.weather(ctx), sec.packTweaks(ctx)]);
    case "t-2": return intoSections([sec.sailing(ctx), sec.checkin(ctx, "closes"), sec.embark2(ctx), sec.documents(ctx), sec.emergency(ctx), sec.videos(ctx, ["embark"])]);
    case "payment-due": {
      // no amount or no date on the payment means there is nothing to announce
      const one = o.payment ? sec.paymentOne(ctx, o.payment) : null;
      return one && o.payment ? intoSections([one, sec.howToPay(ctx, o.payment)]) : [];
    }
    case "data-needed": return intoSections([sec.missing(ctx)]);
    case "change-notice": return o.notice ? intoSections([sec.changeNotice(ctx, o.notice)]) : [];
  }
}

function subjectFor(kind: MilestoneKind, ctx: Ctx, o: RenderOptions): string {
  const S = strings(ctx.lang);
  const g = ctx.group;
  const ship = displayName(g.ship_name);
  switch (kind) {
    case "confirmation": return S.subject.confirmation({ ship, date: fmtDate(g.sail_date, ctx.lang) });
    case "payment-due": return S.subject.paymentDue({ date: fmtDate(o.payment?.due_date, ctx.lang), amount: fmtMoney(o.payment?.amount) });
    case "change-notice": return S.subject.change({ group: plain(g.name, 80) });
    case "data-needed": return S.subject.dataNeeded({ ship });
    default: {
      const n = kindDays(kind) ?? 0;
      return S.subject.days({ days: ctx.daysToSail !== null && ctx.daysToSail >= 0 ? ctx.daysToSail : n, topic: S.topic[kind] ?? "" });
    }
  }
}

/** The whole message for one traveler in one language. null when the file cannot support it (no payment to speak of, nothing to say). */
export function renderEmail(kind: MilestoneKind, ctx: Ctx, o: RenderOptions = {}): Rendered | null {
  const S = strings(ctx.lang);
  const blocks = sectionsFor(kind, ctx, o);
  if (!blocks.length) return null;
  const hello = S.hello(plain(ctx.traveler.first_name, 60));
  const intro = S.intro[kind] ?? "";
  const closing = S.closing[kind] ?? "";
  const subject = subjectFor(kind, ctx, o);

  const p = (t: string) => `<p style="margin:0 0 14px">${esc(t)}</p>`;
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:1.55;color:${NAVY};max-width:600px;margin:0 auto;padding:8px 4px">` +
    p(hello) + (intro ? p(intro) : "") +
    blocks.map(sectionHtml).join("") +
    (closing ? p(closing) : "") +
    `<p style="margin:26px 0 14px"><a data-cta="1" href="${esc(ctx.hubUrl)}" style="display:inline-block;background:${GOLD};color:${NAVY};font-weight:bold;font-size:20px;padding:14px 26px;border:2px solid ${NAVY};border-radius:12px;text-decoration:none">${esc(S.button)}</a></p>` +
    `<p style="margin:0 0 14px;font-size:16px">${esc(S.pasteLink)}<br><a href="${esc(ctx.hubUrl)}" style="color:${NAVY}">${esc(ctx.hubUrl)}</a></p>` +
    p(S.contact) +
    `<p style="margin:0">${esc(S.signoff)}</p>` +
    `</div>`;

  const text = [hello, intro, ...blocks.map(sectionText), closing, `${S.button}: ${ctx.hubUrl}`, S.contact, S.signoff].filter(Boolean).join("\n\n") + "\n";
  return { kind, lang: ctx.lang, subject, html, text, sections: blocks.map((b) => b.key), blocks };
}

// ── The traveler's cruise page ───────────────────────────────────────────────

export interface DetailField { name: string; kind: "choice" | "text" | "date" | "time" | "tel"; max: number; options?: string[] }

/** What the cruise page's form takes (written to group_travelers.form_data.journey; the emergency contact goes to its own columns). */
export const DETAIL_FIELDS: DetailField[] = [
  { name: "getting_there", kind: "choice", max: 10, options: ["flying", "driving", "other"] },
  { name: "flight_in_flight", kind: "text", max: 80 }, { name: "flight_in_date", kind: "date", max: 10 }, { name: "flight_in_time", kind: "time", max: 5 },
  { name: "flight_out_flight", kind: "text", max: 80 }, { name: "flight_out_date", kind: "date", max: 10 }, { name: "flight_out_time", kind: "time", max: 5 },
  { name: "hotel_name", kind: "text", max: 120 }, { name: "hotel_confirmation", kind: "text", max: 60 },
  { name: "transfer_note", kind: "text", max: 160 }, { name: "transfer_confirmation", kind: "text", max: 60 },
  { name: "port_arrival_time", kind: "time", max: 5 },
  { name: "emergency_name", kind: "text", max: 100 }, { name: "emergency_phone", kind: "tel", max: 40 },
];

export interface HubView {
  success: true;
  lang: Lang;
  otherLang: Lang;
  hello: string;
  title: string;
  countdown: { days: number; text: string } | null;
  ui: Record<string, string>;
  business: { name: string; email: string; phone: string; contact: string };
  sections: Section[];
  details: { fields: Array<DetailField & { label: string; optionLabels?: Record<string, string> }>; values: Record<string, string> };
  paperworkUrl: string | null;
}

/** The values the form starts with: what the traveler told us, and the emergency contact on file. */
export function detailValues(traveler: Row): Record<string, string> {
  const a = journeyAnswers(traveler);
  const out: Record<string, string> = {};
  for (const f of DETAIL_FIELDS) {
    const v = f.name === "emergency_name" ? traveler.emergency_name : f.name === "emergency_phone" ? traveler.emergency_phone : a[f.name];
    out[f.name] = typeof v === "string" ? v : "";
  }
  return out;
}

export function renderHub(page: Ctx): HubView {
  // on the page itself the link to the form is an in-page anchor, not the address of the page
  const ctx: Ctx = { ...page, hubUrl: "" };
  const S = strings(ctx.lang);
  const H = S.hub;
  const pw = sec.paperwork(ctx, { showDone: true });
  const sections = intoSections([
    sec.noticeSections(ctx),
    sec.sailing(ctx),
    sec.missing(ctx),
    sec.detailsSection(ctx),
    pw,
    sec.payments(ctx, { mode: "schedule", howTo: true }),
    sec.checklistAll(ctx),
    sec.travel(ctx),
    sec.ship(ctx),
    sec.storm(ctx),
    sec.weather(ctx),
    sec.packTweaks(ctx),
    sec.embark1(ctx),
    sec.documents(ctx),
    sec.passport(ctx),
    sec.insurance(ctx, { video: true }),
    sec.videos(ctx, ["embark", "packing"]),
  ]);
  const order = ["notice", "sailing", "missing", "details", "paperwork", "payments", "checklist", "travel", "ship", "storm", "weather", "pack-tweaks", "embark", "documents", "passport", "insurance", "videos"];
  sections.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  const first = plain(ctx.traveler.first_name, 60);
  const days = ctx.daysToSail;
  return {
    success: true, lang: ctx.lang, otherLang: ctx.lang === "es" ? "en" : "es",
    hello: H.helloLead(first), title: H.title,
    countdown: days !== null && days >= 0 ? { days, text: S.s.daysToGo(days) } : null,
    ui: { save: H.save, saved: H.saved, saveFailed: H.saveFailed, langSwitch: H.langSwitch, tick: H.tick, openPaperwork: H.openPaperwork, contactTitle: H.contactTitle, footer: H.footer, badLink: H.badLink },
    business: { name: BUSINESS.legalName, email: BUSINESS.email, phone: BUSINESS.phone, contact: S.contact },
    sections,
    details: {
      fields: DETAIL_FIELDS.map((f) => ({
        ...f, label: H.fields[f.name] ?? f.name,
        ...(f.options ? { optionLabels: Object.fromEntries(f.options.map((o) => [o, H.fields[`${f.name}_${o}`] ?? o])) } : {}),
      })),
      values: detailValues(ctx.traveler),
    },
    paperworkUrl: pw && pw.links?.length ? ctx.formsUrl : null,
  };
}

// ── What the form may change ─────────────────────────────────────────────────

export type DetailsResult =
  | { ok: true; journey: Record<string, string | null>; emergency: { name: string; phone: string } | null }
  | { ok: false; errors: Record<string, string> };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Check what the cruise page's form sent. Only the known fields are read; a blank clears a field; a card number is refused
 * in every text field; the emergency contact needs both a name and a phone number when either is given.
 */
export function validateDetails(body: unknown, lang: Lang, looksLikeCard: (s: string) => boolean): DetailsResult {
  const E = strings(lang).err;
  const input = body && typeof body === "object" && !Array.isArray(body) ? (body as Row) : {};
  const errors: Record<string, string> = {};
  const journey: Record<string, string | null> = {};
  let emName: string | undefined, emPhone: string | undefined;
  for (const f of DETAIL_FIELDS) {
    if (!(f.name in input)) continue;
    const raw = input[f.name];
    if (raw !== null && typeof raw !== "string") { errors[f.name] = E.badField; continue; }
    const v = (raw ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
    if (v.length > f.max) { errors[f.name] = E.tooLong; continue; }
    if (v && f.kind !== "date" && f.kind !== "time" && looksLikeCard(v)) { errors[f.name] = E.card; continue; }
    if (v && f.kind === "choice" && !f.options!.includes(v)) { errors[f.name] = E.badField; continue; }
    if (v && f.kind === "date" && ymd(v) !== v) { errors[f.name] = E.badDate; continue; }
    if (v && f.kind === "time" && !TIME.test(v)) { errors[f.name] = E.badTime; continue; }
    if (v && f.kind === "tel" && !(v.replace(/\D/g, "").length >= 7 && v.replace(/\D/g, "").length <= 15 && /^[0-9+()\-.\s xX#]+$/.test(v))) { errors[f.name] = E.badPhone; continue; }
    if (f.name === "emergency_name") emName = v;
    else if (f.name === "emergency_phone") emPhone = v;
    else journey[f.name] = v || null;
  }
  const hasEm = !!(emName || emPhone);
  if (hasEm && !emName && !errors["emergency_name"]) errors["emergency_name"] = E.needName;
  if (hasEm && !emPhone && !errors["emergency_phone"]) errors["emergency_phone"] = E.needPhone;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, journey, emergency: hasEm ? { name: emName!, phone: emPhone! } : null };
}

/** The traveler's form_data after a details save: the form's keys replaced, the rest left alone. */
export function mergeJourneyAnswers(formData: unknown, changes: Record<string, string | null>, now: Date, extra: Row = {}): Row {
  const fd: Row = formData && typeof formData === "object" && !Array.isArray(formData) ? { ...(formData as Row) } : {};
  const j: Row = { ...(fd["journey"] ?? {}) };
  for (const [k, v] of Object.entries(changes)) { if (v === null) delete j[k]; else j[k] = v; }
  Object.assign(j, extra);
  j["updated_at"] = now.toISOString();
  fd["journey"] = j;
  return fd;
}

/** A tick (or untick) on a checklist row, kept per traveler. */
export function withChecklistTick(formData: unknown, rowId: string, done: boolean, now: Date): Row {
  const fd: Row = formData && typeof formData === "object" && !Array.isArray(formData) ? { ...(formData as Row) } : {};
  const j: Row = { ...(fd["journey"] ?? {}) };
  const ticks: Row = { ...(j["checklist_done"] ?? {}) };
  if (done) ticks[rowId] = now.toISOString(); else delete ticks[rowId];
  j["checklist_done"] = ticks;
  fd["journey"] = j;
  return fd;
}

/** The client checklist rows a traveler may tick (their own group's, for their cabin or the whole group). */
export function tickableRow(input: JourneyInput, traveler: Row, rowId: string): Row | null {
  const cabin = cabinOf(input, traveler);
  return clientChecklist(input, traveler, cabin).find((r) => String(r.id) === rowId) ?? null;
}

export { ctxFor, matesOf };
