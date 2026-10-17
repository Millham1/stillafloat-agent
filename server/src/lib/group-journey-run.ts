// group-journey-run.ts — the engine: plan every live group, send what is due and approved, log every message.
//
// All I/O comes in through RunDeps / JourneyStore, so every rule here is unit-tested on a fake store with a fake mailer
// (group-journey-run.test.ts). The Supabase wiring is group-journey-store.ts; the routes and the daily job call this.
//
// THE RULES THIS FILE ENFORCES
//   * Only an approved template is sent (Mark 2026-10-02: approved once). A due message that is waiting on approval
//     asks Mark for it, once, through the dashboard's action queue (Mark 2026-10-08), never by a file.
//   * Dev never emails real people (Mark 2026-10-08): every client email goes through the same allow-list as the
//     paperwork links (GROUP_FORMS_MAIL_ALLOW; set = only those addresses, unset = the traveler's own address).
//     The simulation is stricter: it sends nothing at all unless the list is set and names the address.
//   * One message per traveler per tick, and the same dedupe key is never sent twice: the key is claimed with a unique
//     insert before the mail goes out, so a second tick, a second process or a double click cannot send it again.
//   * A failed send is tried again on the next tick, up to MAX_ATTEMPTS; a message left "queued" by a crash is retried too.

import { BUSINESS, deriveHubToken, hashLinkToken } from "./group-secure";
import { mailAllowed } from "./group-forms";
import {
  addDays, cabinIsBooked, ctxFor, emailOf, localToday, personName, plain, ymd,
  type Extras, type JourneyInput, type Row,
} from "./group-journey-facts";
import {
  ACTIVE_GROUP_STATUSES, ALL_KINDS, DAY_MILESTONES, KIND_LABEL, MAX_ATTEMPTS, approvalFor, dayKind, dedupeKey, kindDays, planJourney, renderEmail, videoSourcesFor,
  withApproval, type ChangeNotice, type JourneyDefaults, type JourneyPlan, type MilestoneKind, type PlanItem, type Rendered,
} from "./group-journey";
import { sha256Hex } from "./group-secure";
import type { Lang } from "./group-journey-strings";

export const MAX_SENDS_PER_TICK = 150;
export const SIM_PREFIX = "sim:";

/** What a message needs from outside the file. Only what the kind uses is fetched. */
export interface Needs { videos?: boolean; rating?: boolean; weather?: boolean; storm?: boolean; notices?: boolean }

export function needsFor(kind: MilestoneKind): Needs {
  switch (kind) {
    case "t-120": case "t-20": case "t-2": return { videos: true };
    case "t-10": return { videos: true, rating: true };
    case "t-5": return { weather: true, storm: true };
    default: return {};
  }
}

/** The clock a message is written on. A preview or a simulation runs ahead of the real day (simToday); the real forecast is moved onto it. */
export interface Clock { realToday: string; simToday: string }

export interface JourneyStore {
  /** ids of groups that could be live today (status and sail date); the plan makes the final call. */
  activeGroupIds(today: string): Promise<string[]>;
  load(groupId: string): Promise<JourneyInput | null>;
  defaults(): Promise<JourneyDefaults>;
  saveDefaults(d: JourneyDefaults): Promise<void>;
  extras(input: JourneyInput, needs: Needs, clock: Clock): Promise<Extras>;
  /** Insert a log row; "exists" when its dedupe key is already taken. */
  claim(row: Row): Promise<{ id: string } | "exists">;
  /** Take a failed or stuck row back for another try. false when it is not (or no longer) retryable. */
  retake(id: string, meta: Row): Promise<boolean>;
  finish(id: string, patch: Row): Promise<void>;
  setHubHash(travelerId: string, hash: string): Promise<void>;
  saveJourney(groupId: string, journey: Row): Promise<void>;
  /** Remove the simulated messages (dedupe key "sim:…") of a group, optionally one traveler's. */
  removeSim(groupId: string, travelerId: string | null): Promise<number>;
}

export interface RunDeps {
  store: JourneyStore;
  now: () => Date;
  tz?: string;
  /** The public address of this box (PUBLIC_URL). */
  site: string;
  /** GROUP_LINK_KEY / GROUP_PII_KEY. Without it no link can be written and nothing is sent. */
  linkKey: string | null;
  /** GROUP_FORMS_MAIL_ALLOW. */
  allow: string | undefined;
  send: (m: { to: string; subject: string; html: string; text: string }) => Promise<boolean>;
  requestApproval: (a: { groupId: string; groupName: string; kind: MilestoneKind; count: number }) => Promise<void>;
  clearApproval: (groupId: string, kinds: string[]) => Promise<void>;
  warn: (obj: Row, msg: string) => void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function clockFor(deps: RunDeps, simNow?: Date): { now: Date; clock: Clock } {
  const real = deps.now();
  const now = simNow ?? real;
  return { now, clock: { realToday: localToday(real, deps.tz), simToday: localToday(now, deps.tz) } };
}

/** The moment a countdown message is written "as of": 15:00 UTC (late morning in the business's time zone) on its day. */
export function milestoneNow(sailDate: string, days: number): Date {
  return new Date(`${addDays(sailDate, -days)}T15:00:00Z`);
}

// ── Rendering for one traveler ────────────────────────────────────────────────

export interface PreparedMessage {
  rendered: Rendered;
  to: string | null;
  travelerId: string;
  token: string;
}

interface PrepareOpts { lang?: Lang; simNow?: Date; payment?: Row; notice?: ChangeNotice; defaults?: JourneyDefaults; extras?: Extras }

/** Render one kind for one traveler. null when the file cannot support the message. */
export async function prepare(deps: RunDeps, input: JourneyInput, travelerId: string, kind: MilestoneKind, o: PrepareOpts = {}): Promise<PreparedMessage | null> {
  const { now, clock } = clockFor(deps, o.simNow);
  const traveler = input.travelers.find((t) => t.id === travelerId);
  if (!traveler) return null;
  const extras = o.extras ?? (await deps.store.extras(input, needsFor(kind), clock));
  const token = deps.linkKey ? deriveHubToken(travelerId, deps.linkKey) : "";
  const ctx = ctxFor(input, travelerId, {
    now, tz: deps.tz, site: deps.site, token: token || "x".repeat(43), extras,
    ...(o.lang ? { lang: o.lang } : {}), videoSources: videoSourcesFor(input.group.journey, o.defaults),
  });
  if (!ctx) return null;
  const rendered = renderEmail(kind, ctx, { payment: o.payment, notice: o.notice });
  return rendered ? { rendered, to: emailOf(traveler), travelerId, token } : null;
}

// ── Sending one message ───────────────────────────────────────────────────────

export type SendOutcome = "sent" | "failed" | "held" | "exists" | "no-link-key" | "nothing-to-say" | "no-address";

interface SendJob {
  input: JourneyInput;
  travelerId: string;
  kind: MilestoneKind;
  key: string;
  payment?: Row;
  notice?: ChangeNotice;
  meta?: Row;
  /** Existing log row for this key (a failed or stuck one), if any. */
  existing?: Row | null;
  template?: string;
  defaults?: JourneyDefaults;
  extras?: Extras;
}

async function deliver(deps: RunDeps, job: SendJob): Promise<{ outcome: SendOutcome; id?: string; rendered?: Rendered }> {
  const traveler = job.input.travelers.find((t) => t.id === job.travelerId);
  const to = emailOf(traveler);
  if (!traveler || !to) return { outcome: "no-address" };
  if (!deps.linkKey) return { outcome: "no-link-key" };
  if (!mailAllowed(to, deps.allow)) return { outcome: "held" };
  const prepared = await prepare(deps, job.input, job.travelerId, job.kind, { payment: job.payment, notice: job.notice, defaults: job.defaults, extras: job.extras });
  if (!prepared) return { outcome: "nothing-to-say" };
  const { rendered } = prepared;
  const now = deps.now();

  // Claim the key first. A taken key is a message that already went out, is being sent, or failed: only the last two can be retried.
  const attempts = (Number(job.existing?.meta?.attempts) || 0) + 1;
  const meta = { ...(job.meta ?? {}), attempts, lang: rendered.lang, sections: rendered.sections };
  let id: string;
  if (job.existing) {
    if (!(await deps.store.retake(String(job.existing.id), meta))) return { outcome: "exists" };
    id = String(job.existing.id);
  } else {
    const claimed = await deps.store.claim({
      group_id: job.input.group.id, cabin_id: traveler.cabin_id ?? null, traveler_id: traveler.id, audience: "client",
      template: job.template ?? job.kind, to_email: to, subject: rendered.subject, body_html: rendered.html, status: "queued",
      scheduled_for: now.toISOString(), dedupe_key: job.key, meta,
    });
    if (claimed === "exists") return { outcome: "exists" };
    id = claimed.id;
  }

  try {
    // The link works the moment the email arrives: its hash is stored before the mail goes out.
    const hash = hashLinkToken(prepared.token);
    if (traveler.hub_token_hash !== hash) { await deps.store.setHubHash(traveler.id, hash); traveler.hub_token_hash = hash; }
    const ok = await deps.send({ to, subject: rendered.subject, html: rendered.html, text: rendered.text });
    await deps.store.finish(id, ok
      ? { status: "sent", sent_at: deps.now().toISOString(), error: null, subject: rendered.subject, body_html: rendered.html }
      : { status: "failed", error: "mail sender refused or was unreachable" });
    return { outcome: ok ? "sent" : "failed", id, rendered };
  } catch (err) {
    deps.warn({ err: errText(err), group: job.input.group.id, kind: job.kind }, "group journey: sending failed");
    await deps.store.finish(id, { status: "failed", error: errText(err).slice(0, 300) }).catch(() => undefined);
    return { outcome: "failed", id, rendered };
  }
}

// ── The daily tick ────────────────────────────────────────────────────────────

export interface TickResult {
  groups: number;
  sent: number;
  failed: number;
  /** Due messages that cannot go yet, by group and kind. */
  waiting: Array<{ group: string; kind: MilestoneKind; reason: string; count: number }>;
  held: number;
  errors: string[];
}

const rank = (i: PlanItem): number => (i.kind === "confirmation" ? 0 : i.kind === "payment-due" ? 1 : i.kind === "data-needed" ? 3 : 2);

/** Of a traveler's sendable items, the one to send now: confirmation, then a payment notice, then the countdown message, then a nudge. */
export function pickItem(items: readonly PlanItem[]): PlanItem | null {
  const ready = items.filter((i) => i.status === "due" && !i.blocked);
  ready.sort((a, b) => rank(a) - rank(b) || String(a.date ?? "").localeCompare(String(b.date ?? "")));
  return ready[0] ?? null;
}

export async function tick(deps: RunDeps, only?: { groupId: string }): Promise<TickResult> {
  const now = deps.now();
  const today = localToday(now, deps.tz);
  const out: TickResult = { groups: 0, sent: 0, failed: 0, waiting: [], held: 0, errors: [] };
  const defaults = await deps.store.defaults();
  const ids = only ? [only.groupId] : await deps.store.activeGroupIds(today);
  let budget = MAX_SENDS_PER_TICK;
  for (const id of ids) {
    try {
      const input = await deps.store.load(id);
      if (!input) continue;
      const plan = planJourney(input, now, { tz: deps.tz, isApproved: (k) => approvalFor(k, input.group.journey, defaults).approved });
      if (!plan.live) continue;
      out.groups++;

      // What is due but waiting on Mark: ask once, through the dashboard.
      const waiting = new Map<MilestoneKind, { reason: string; count: number }>();
      for (const t of plan.travelers) for (const i of t.items) if (i.status === "due" && i.blocked) {
        const w = waiting.get(i.kind) ?? { reason: i.blocked, count: 0 };
        w.count++; waiting.set(i.kind, w);
      }
      for (const [kind, w] of waiting) {
        out.waiting.push({ group: String(input.group.name ?? id), kind, reason: w.reason, count: w.count });
        if (w.reason.includes("not approved")) {
          await deps.requestApproval({ groupId: id, groupName: String(input.group.name ?? ""), kind, count: w.count })
            .catch((e: unknown) => deps.warn({ err: errText(e) }, "group journey: the approval request could not be filed"));
        }
      }

      const byKey = new Map<string, Row>((input.messages ?? []).map((m) => [String(m.dedupe_key), m] as [string, Row]));
      for (const t of plan.travelers) {
        if (budget <= 0) break;
        const item = pickItem(t.items);
        if (!item) continue;
        const payment = item.paymentId ? input.payments.find((p) => String(p.id) === item.paymentId) : undefined;
        const r = await deliver(deps, {
          input, travelerId: t.id, kind: item.kind, key: item.key, payment, defaults,
          meta: { ...(item.stage ? { stage: item.stage } : {}), ...(item.paymentId ? { payment_id: item.paymentId } : {}), ...(item.after ? { after: item.after } : {}) },
          existing: byKey.get(item.key) ?? null,
        });
        if (r.outcome === "sent") { out.sent++; budget--; }
        else if (r.outcome === "failed") { out.failed++; budget--; }
        else if (r.outcome === "held") out.held++;
        else if (r.outcome === "no-link-key") { out.errors.push("no link key: set GROUP_LINK_KEY (or GROUP_PII_KEY) on this box; nothing was sent"); budget = 0; }
      }
    } catch (err) {
      out.errors.push(`${id}: ${errText(err)}`);
      deps.warn({ err: errText(err), group: id }, "group journey: a group's tick failed");
    }
  }
  return out;
}

// ── Mark's side: the plan with approvals, previews, approving ────────────────

export interface ApprovalView { kind: MilestoneKind; approved: boolean; source: "group" | "default" | "none"; at: string | null; stale: boolean }

export interface JourneyView {
  plan: JourneyPlan;
  approvals: ApprovalView[];
  defaults: JourneyDefaults;
}

export async function journeyView(deps: RunDeps, groupId: string): Promise<{ input: JourneyInput; view: JourneyView } | null> {
  const input = await deps.store.load(groupId);
  if (!input) return null;
  const defaults = await deps.store.defaults();
  const approvals = ALL_KINDS.map((kind) => ({ kind, ...approvalFor(kind, input.group.journey, defaults) }));
  const plan = planJourney(input, deps.now(), { tz: deps.tz, isApproved: (k) => approvalFor(k, input.group.journey, defaults).approved });
  return { input, view: { plan, approvals, defaults } };
}

export interface PreviewResult {
  ok: true;
  kind: MilestoneKind;
  lang: Lang;
  traveler: { id: string; name: string; lang: Lang };
  subject: string;
  html: string;
  text: string;
  sections: string[];
  notes: string[];
}

/** Pick the traveler a preview is shown for: the one asked for, else a lead in a booked cabin, else anyone with a cabin. */
export function sampleTraveler(input: JourneyInput, asked?: string | null): Row | null {
  if (asked) return input.travelers.find((t) => t.id === asked) ?? null;
  const booked = input.travelers.filter((t) => cabinIsBooked(input.cabins.find((c) => c.id === t.cabin_id)));
  return booked.find((t) => t.is_lead) ?? booked[0] ?? input.travelers.find((t) => t.cabin_id) ?? input.travelers[0] ?? null;
}

/** The first unpaid payment of the traveler's cabin that has an amount and a date: the one a payment notice would be about. */
export function samplePayment(input: JourneyInput, traveler: Row): Row | null {
  return input.payments.find((p) => p.cabin_id === traveler.cabin_id && !p.paid_at && ymd(p.due_date) && Number(p.amount) > 0) ?? null;
}

export async function preview(deps: RunDeps, input: JourneyInput, kind: MilestoneKind, o: { travelerId?: string | null; lang?: Lang; notice?: ChangeNotice } = {}): Promise<PreviewResult | { ok: false; error: string }> {
  const traveler = sampleTraveler(input, o.travelerId);
  if (!traveler) return { ok: false, error: "This group has no travelers to show the email for yet." };
  const sail = ymd(input.group.sail_date);
  const n = kindDays(kind);
  // A countdown message is shown as it would read on its own day, so "120 days to go" is true in the preview.
  const simNow = n !== null && sail ? milestoneNow(sail, n) : undefined;
  const payment = kind === "payment-due" ? samplePayment(input, traveler) : undefined;
  if (kind === "payment-due" && !payment) return { ok: false, error: `${personName(traveler) || "This traveler"} has no unpaid payment with both an amount and a date, so there is no payment email to show.` };
  const defaults = await deps.store.defaults();
  const p = await prepare(deps, input, traveler.id, kind, { simNow, lang: o.lang, payment: payment ?? undefined, notice: o.notice, defaults });
  if (!p) return { ok: false, error: kind === "data-needed" ? `${personName(traveler) || "This traveler"} is missing nothing, so there is no reminder to show. Pick someone else.` : "The file does not hold enough to write this email yet." };
  const { clock } = clockFor(deps, simNow);
  const notes: string[] = [];
  if (kind === "t-5" && clock.simToday !== clock.realToday && p.rendered.sections.includes("weather")) notes.push("The weather table uses today's real forecast, moved onto the sailing dates, because the sailing is more than ten days away. On the day it uses the real forecast for those dates.");
  if (kind === "t-5" && !p.rendered.sections.includes("weather")) notes.push("No weather table: none of the ports on the itinerary could be matched to a forecast. Check the port names on the group.");
  return {
    ok: true, kind, lang: p.rendered.lang, traveler: { id: traveler.id, name: personName(traveler), lang: p.rendered.lang },
    subject: p.rendered.subject, html: p.rendered.html, text: p.rendered.text, sections: p.rendered.sections, notes,
  };
}

/** Approve (or withdraw) kinds for the group, and for the whole site when asked. */
export async function setApproval(deps: RunDeps, groupId: string, kinds: readonly string[], approved: boolean, asDefault: boolean): Promise<{ journey: Row; defaults: JourneyDefaults } | null> {
  const input = await deps.store.load(groupId);
  if (!input) return null;
  const now = deps.now();
  const journey = withApproval(input.group.journey, kinds, approved, now);
  await deps.store.saveJourney(groupId, journey);
  let defaults = await deps.store.defaults();
  if (asDefault) {
    const next = withApproval({ approved: defaults.approved }, kinds, approved, now);
    defaults = { ...defaults, approved: next["approved"] };
    await deps.store.saveDefaults(defaults);
  }
  if (approved) await deps.clearApproval(groupId, [...kinds]).catch(() => undefined);
  return { journey, defaults };
}

// ── The dry run ───────────────────────────────────────────────────────────────

export interface SimLine { kind: MilestoneKind; subject: string; sections: string[]; status: "sent" | "failed" | "skipped"; reason: string | null }

/** The simulation sends only to a test address the box has been told about. */
export function simMailAllowed(to: string, allow: string | undefined): boolean {
  return !!allow && allow.trim().length > 0 && mailAllowed(to, allow);
}

export const SIM_SEQUENCE: MilestoneKind[] = ["confirmation", ...DAY_MILESTONES.map(dayKind)];

/**
 * Run the whole journey for one traveler NOW, in order, to a test address: confirmation, then 120 … 2. Each message is written
 * as of its own day, logged under a "sim:" key (so no real send is ever blocked by it), and sent only if the box's allow-list
 * names the address. Approvals are not consulted: this is Mark looking at the package, not the package going out.
 */
export async function simulate(deps: RunDeps, input: JourneyInput, o: { travelerId: string; toEmail: string; lang?: Lang; kinds?: MilestoneKind[] }): Promise<SimLine[] | { error: string }> {
  const traveler = input.travelers.find((t) => t.id === o.travelerId);
  if (!traveler) return { error: "Traveler not found" };
  const sail = ymd(input.group.sail_date);
  if (!sail) return { error: "The group has no sail date, so the countdown cannot be run." };
  if (!deps.linkKey) return { error: "No link key on this box (GROUP_LINK_KEY or GROUP_PII_KEY), so the emails would have no working link." };
  const stamp = deps.now().getTime();
  const defaults = await deps.store.defaults();
  const lines: SimLine[] = [];
  for (const kind of (o.kinds?.length ? SIM_SEQUENCE.filter((k) => o.kinds!.includes(k)) : SIM_SEQUENCE)) {
    const n = kindDays(kind);
    const p = await prepare(deps, input, traveler.id, kind, { simNow: n !== null ? milestoneNow(sail, n) : undefined, lang: o.lang, defaults });
    if (!p) { lines.push({ kind, subject: "(not written)", sections: [], status: "skipped", reason: "the file does not hold enough to write this one" }); continue; }
    const allowed = simMailAllowed(o.toEmail, deps.allow);
    let status: SimLine["status"] = "skipped";
    let reason: string | null = allowed ? null : "this box only emails its test addresses, and that address is not on the list (nothing was sent)";
    let error: string | null = null;
    if (allowed) {
      try {
        const ok = await deps.send({ to: o.toEmail, subject: p.rendered.subject, html: p.rendered.html, text: p.rendered.text });
        status = ok ? "sent" : "failed";
        if (!ok) { reason = "the mail sender refused it"; error = reason; }
      } catch (err) { status = "failed"; reason = errText(err); error = reason.slice(0, 300); }
    }
    await deps.store.claim({
      group_id: input.group.id, cabin_id: traveler.cabin_id ?? null, traveler_id: traveler.id, audience: "client", template: kind,
      to_email: o.toEmail, subject: p.rendered.subject, body_html: p.rendered.html,
      status, sent_at: status === "sent" ? deps.now().toISOString() : null, error: error ?? reason,
      dedupe_key: `${SIM_PREFIX}${stamp}:${kind}:${traveler.id}`, meta: { sim: true, sections: p.rendered.sections, lang: p.rendered.lang },
    });
    lines.push({ kind, subject: p.rendered.subject, sections: p.rendered.sections, status, reason });
  }
  return lines;
}

// ── Change notices ────────────────────────────────────────────────────────────

export const noticeId = (groupId: string, n: ChangeNotice): string =>
  sha256Hex(JSON.stringify([groupId, n.text, n.text_es ?? "", n.fields])).slice(0, 16);

export interface NoticeRecipient { id: string; name: string; lang: Lang; willSend: boolean; reason: string | null }

export function noticeRecipients(input: JourneyInput, allow: string | undefined): NoticeRecipient[] {
  return input.travelers.map((t) => {
    const cabin = input.cabins.find((c) => c.id === t.cabin_id) ?? null;
    const to = emailOf(t);
    const reason = !cabinIsBooked(cabin) ? "cabin not booked yet" : !to ? "no email address on file" : !mailAllowed(to, allow) ? "this box only emails its test addresses" : null;
    return { id: t.id, name: personName(t) || "Unnamed traveler", lang: t.lang === "es" ? "es" : "en", willSend: reason === null, reason };
  });
}

export interface NoticeResult { noticeId: string; recipients: NoticeRecipient[]; sent: number; failed: number; alreadySent: number }

/** Send a change notice to everyone booked, record it on the group (the cruise page shows it), and log each email. Safe to repeat: whoever already has it is skipped. */
export async function sendChangeNotice(deps: RunDeps, input: JourneyInput, notice: ChangeNotice): Promise<NoticeResult | { error: string }> {
  if (!deps.linkKey) return { error: "No link key on this box (GROUP_LINK_KEY or GROUP_PII_KEY), so the emails would have no working link. Nothing was sent." };
  const id = noticeId(input.group.id, notice);
  const now = deps.now();
  const recipients = noticeRecipients(input, deps.allow);
  const fields = notice.fields.map((f) => ({ label: f.label, before: f.before, after: f.after }));
  // The group-level record: the cruise page reads it, so a traveler with no email address still sees the change.
  await deps.store.claim({
    group_id: input.group.id, cabin_id: null, traveler_id: null, audience: "client", template: "change-notice", to_email: null,
    subject: plain(notice.text, 90), status: "sent", sent_at: now.toISOString(), dedupe_key: `change:${id}`,
    meta: { notice_id: id, text: notice.text, text_es: notice.text_es ?? null, fields },
  });
  let sent = 0, failed = 0, already = 0;
  const byKey = new Map<string, Row>((input.messages ?? []).map((m) => [String(m.dedupe_key), m] as [string, Row]));
  for (const r of recipients) {
    if (!r.willSend) continue;
    const key = `change:${id}:${r.id}`;
    const existing = byKey.get(key) ?? null;
    const spent = existing && (existing.status === "sent" || (existing.status === "failed" && (Number(existing.meta?.attempts) || 1) >= MAX_ATTEMPTS));
    if (spent) { already++; continue; }
    const res = await deliver(deps, { input, travelerId: r.id, kind: "change-notice", key, notice, meta: { notice_id: id }, existing });
    if (res.outcome === "sent") sent++;
    else if (res.outcome === "failed") failed++;
  }
  return { noticeId: id, recipients, sent, failed, alreadySent: already };
}

export { KIND_LABEL };
