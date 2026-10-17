// group-journey-run.test.ts — the engine on a fake store and a fake mailer: approvals, the allow-list, dedupe, retries,
// one message per traveler per tick, the previews, the simulation and the change notice.
import test from "node:test";
import assert from "node:assert/strict";
import {
  SIM_SEQUENCE, journeySimEnabled, journeyView, pickItem, preview, setApproval, simMailAllowed, simulate, sendChangeNotice, noticeId, noticeRecipients, tick, needsFor,
  type JourneyStore, type RunDeps,
} from "./group-journey-run";
import { JOURNEY_TEMPLATE_VERSION, MAX_ATTEMPTS, dedupeKey, planJourney, type JourneyDefaults, type PlanItem } from "./group-journey";
import { addDays, type Extras, type JourneyInput, type Row } from "./group-journey-facts";
import { deriveHubToken, hashLinkToken } from "./group-secure";
import { fixtureInput, fullExtras, SAIL } from "./group-journey.fixture";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SITE = "https://dev.example.test";
const at = (date: string, hour = 15) => new Date(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
const before = (n: number) => at(addDays(SAIL, -n));

class FakeStore implements JourneyStore {
  msgs: Row[] = [];
  journeySaves: Row[] = [];
  defaultsNow: JourneyDefaults = { approved: {} };
  hubHashes = new Map<string, string>();
  extrasCalls: Array<{ needs: unknown; clock: unknown }> = [];
  seq = 0;
  constructor(public input: JourneyInput, public clock: { now: Date }) {}
  async activeGroupIds() { return [this.input.group.id]; }
  async load(): Promise<JourneyInput> {
    for (const t of this.input.travelers) if (this.hubHashes.has(t.id)) t.hub_token_hash = this.hubHashes.get(t.id);
    return { ...this.input, group: { ...this.input.group, journey: this.journeySaves.at(-1) ?? this.input.group.journey }, messages: this.msgs.map((m) => ({ ...m })) };
  }
  async defaults() { return this.defaultsNow; }
  async saveDefaults(d: JourneyDefaults) { this.defaultsNow = d; }
  async extras(_i: JourneyInput, needs: unknown, clock: unknown): Promise<Extras> { this.extrasCalls.push({ needs, clock }); return fullExtras(); }
  async claim(row: Row) {
    if (this.msgs.some((m) => m.dedupe_key === row.dedupe_key)) return "exists" as const;
    const m = { id: `m${++this.seq}`, created_at: this.clock.now.toISOString(), updated_at: this.clock.now.toISOString(), ...row };
    this.msgs.push(m);
    return { id: m.id };
  }
  async retake(id: string, meta: Row) {
    const m = this.msgs.find((x) => x.id === id);
    if (!m || !["failed", "queued"].includes(m.status)) return false;
    Object.assign(m, { status: "queued", meta, updated_at: this.clock.now.toISOString() });
    return true;
  }
  async finish(id: string, patch: Row) { Object.assign(this.msgs.find((x) => x.id === id)!, patch, { updated_at: this.clock.now.toISOString() }); }
  async setHubHash(id: string, hash: string) { this.hubHashes.set(id, hash); }
  async saveJourney(_g: string, journey: Row) { this.journeySaves.push(journey); }
  async removeSim(_g: string, tid: string | null) { const n = this.msgs.length; this.msgs = this.msgs.filter((m) => !(String(m.dedupe_key).startsWith("sim:") && (!tid || m.traveler_id === tid))); return n - this.msgs.length; }
}

function setup(o: { input?: JourneyInput; now?: Date; allow?: string; linkKey?: string | null; sendOk?: () => boolean } = {}) {
  const clock = { now: o.now ?? before(100) };
  const store = new FakeStore(o.input ?? fixtureInput(), clock);
  const mails: Array<{ to: string; subject: string; html: string; text: string }> = [];
  const requests: Array<{ kind: string; count: number }> = [];
  const cleared: string[][] = [];
  const deps: RunDeps = {
    store, now: () => clock.now, site: SITE, linkKey: o.linkKey === undefined ? KEY : o.linkKey, allow: o.allow,
    send: async (m) => { mails.push(m); return o.sendOk ? o.sendOk() : true; },
    requestApproval: async (a) => { requests.push({ kind: a.kind, count: a.count }); },
    clearApproval: async (_g, kinds) => { cleared.push(kinds); },
    warn: () => undefined,
  };
  return { deps, store, mails, requests, cleared, clock };
}

const approve = (store: FakeStore, kinds: string[]) => {
  const approved: Row = {};
  for (const k of kinds) approved[k] = { approved: true, at: "2026-10-01T00:00:00Z", version: JOURNEY_TEMPLATE_VERSION };
  store.defaultsNow = { approved };
};

// ── the daily tick ─────────────────────────────────────────────────────────────

test("nothing goes out until Mark approves the template; he is asked once, through the dashboard, for each kind that is waiting", async () => {
  const t = setup();
  const r = await tick(t.deps);
  assert.equal(r.sent, 0);
  assert.equal(t.mails.length, 0);
  assert.deepEqual(r.waiting.map((w) => [w.kind, w.count]).sort(), [["confirmation", 4], ["t-120", 4]]);
  assert.deepEqual(t.requests.map((x) => x.kind).sort(), ["confirmation", "t-120"]);
  assert.equal(t.store.msgs.length, 0, "a held message leaves no row behind");
});

test("once approved, each traveler gets one message per tick — the confirmation first, the 120-day message the next day — and never the same one twice", async () => {
  const t = setup();
  approve(t.store, ["confirmation", "t-120"]);
  const first = await tick(t.deps);
  assert.equal(first.sent, 4);                                           // Ann, Bob, Carlos, Dulce; Eve's cabin is only held
  assert.deepEqual(t.store.msgs.map((m) => m.template), ["confirmation", "confirmation", "confirmation", "confirmation"]);
  assert.ok(t.store.msgs.every((m) => m.status === "sent" && m.sent_at && m.audience === "client" && m.to_email));
  assert.ok(t.mails.every((m) => /^(You are booked|Su reserva está confirmada)/.test(m.subject)));
  // the same tick again: the confirmations are sent, the 120-day message is next
  const second = await tick(t.deps);
  assert.equal(second.sent, 4);
  assert.deepEqual(t.store.msgs.slice(4).map((m) => m.template), ["t-120", "t-120", "t-120", "t-120"]);
  // and a third tick has nothing left to send today
  const third = await tick(t.deps);
  assert.equal(third.sent, 0);
  assert.equal(t.mails.length, 8);
  // the Spanish travelers got Spanish
  const spanish = t.mails.filter((m) => m.to === "carlos@example.test" || m.to === "dulce@example.test");
  assert.equal(spanish.length, 4);
  assert.ok(spanish.every((m) => /^(Su reserva|Faltan)/.test(m.subject)));
  // no approval was asked for what was already approved
  assert.equal(t.requests.length, 0);
});

test("the cruise-page link works the moment the email arrives: its hash is stored first and matches the link in the message", async () => {
  const t = setup();
  approve(t.store, ["confirmation"]);
  await tick(t.deps);
  const mail = t.mails.find((m) => m.to === "ann@example.test")!;
  const token = /my-cruise\.html\?t=([A-Za-z0-9_-]{43})/.exec(mail.text)![1]!;
  assert.equal(token, deriveHubToken("t1", KEY));
  assert.equal(t.store.hubHashes.get("t1"), hashLinkToken(token));
});

test("on a box with a test list, only listed addresses are emailed and the others are left for when they are listed", async () => {
  const t = setup({ allow: "ann@example.test, @cruz.test" });
  approve(t.store, ["confirmation"]);
  const r = await tick(t.deps);
  assert.equal(r.sent, 1);
  assert.deepEqual(t.mails.map((m) => m.to), ["ann@example.test"]);
  assert.equal(r.held, 3);
  assert.equal(t.store.msgs.length, 1, "a held address leaves no row, so it is sent when the list changes");
  t.deps.allow = undefined;
  assert.equal((await tick(t.deps)).sent, 3);                           // the other three confirmations (only the confirmation is approved)
});

test("without a link key nothing is sent and the tick says why", async () => {
  const t = setup({ linkKey: null });
  approve(t.store, ["confirmation", "t-120"]);
  const r = await tick(t.deps);
  assert.equal(r.sent, 0);
  assert.match(r.errors[0]!, /GROUP_LINK_KEY/);
  assert.equal(t.store.msgs.length, 0);
});

test("a failed send is tried again next tick, and given up on after the third try", async () => {
  let ok = false;
  const t = setup({ sendOk: () => ok });
  approve(t.store, ["confirmation"]);
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const r = await tick(t.deps);
    assert.equal(r.sent, 0);
    assert.equal(r.failed, i <= 3 ? 4 : 0, `try ${i}`);
  }
  assert.ok(t.store.msgs.every((m) => m.status === "failed" && m.meta.attempts === MAX_ATTEMPTS));
  // out of tries: the plan calls it failed and the tick leaves it alone
  ok = true;
  const after = await tick(t.deps);
  assert.equal(after.failed, 0);
  assert.ok(!t.store.msgs.some((m) => m.template === "confirmation" && m.status === "sent"));
  // a failure that is not the third is recovered
  const u = setup({ sendOk: () => ok });
  ok = false; approve(u.store, ["confirmation"]);
  await tick(u.deps);
  ok = true;
  assert.equal((await tick(u.deps)).sent, 4);
  assert.ok(u.store.msgs.filter((m) => m.template === "confirmation").every((m) => m.status === "sent" && m.meta.attempts === 2));
});

test("a message left queued by a crash is picked up after half an hour, not before", async () => {
  const t = setup();
  approve(t.store, ["confirmation"]);
  t.store.msgs.push({ id: "m0", created_at: t.clock.now.toISOString(), updated_at: t.clock.now.toISOString(), dedupe_key: dedupeKey("confirmation", "t1", SAIL), status: "queued", template: "confirmation", traveler_id: "t1", meta: { attempts: 1 } });
  assert.equal((await tick(t.deps)).sent, 3, "fresh queue entry: someone is sending it");
  t.clock.now = new Date(t.clock.now.getTime() + 31 * 60_000);
  const r = await tick(t.deps);
  assert.ok(t.store.msgs.find((m) => m.id === "m0")!.status === "sent", "the stuck one went out");
  assert.ok(r.sent >= 1);
});

test("a late start sends only the latest milestone, not a backlog", async () => {
  const t = setup({ now: before(40) });
  approve(t.store, ["t-120", "t-90", "t-45"]);
  const r = await tick(t.deps);
  assert.equal(r.sent, 4);
  assert.ok(t.mails.every((m) => /(40 days to go|Faltan 40 días)/.test(m.subject)));
  assert.deepEqual([...new Set(t.store.msgs.map((m) => m.template))], ["t-45"]);
});

test("a payment notice goes to the cabin's lead only, 14 and then 3 days ahead, and not once it is paid", async () => {
  const t = setup({ now: at("2026-12-22") });
  approve(t.store, ["payment-due", "t-90", "t-120", "confirmation"]);
  await tick(t.deps);                                                  // the confirmations go first
  const day1 = await tick(t.deps);
  const pay = t.store.msgs.filter((m) => m.template === "payment-due");
  assert.deepEqual(pay.map((m) => m.traveler_id).sort(), ["t1", "t3"]);
  assert.ok(pay.every((m) => m.dedupe_key.endsWith(":14") && m.meta.stage === 14));
  assert.equal(day1.sent, 4);                                           // the two leads get the payment notice, the other two the 90-day message
  assert.match(t.mails.find((m) => m.to === "ann@example.test" && /Payment due/.test(m.subject))!.subject, /^Payment due January 5, 2027: \$2,800$/);
  // the day after: the 14-day notices are not repeated
  await tick(t.deps);
  assert.equal(t.store.msgs.filter((m) => m.template === "payment-due").length, 2);
  // three days before: the second notice, and only for the unpaid one
  t.clock.now = at("2027-01-02");
  t.store.input.payments.find((p) => p.id === "p4")!.paid_at = "2026-12-30T00:00:00Z";
  await tick(t.deps);
  const stage3 = t.store.msgs.filter((m) => m.template === "payment-due" && m.meta.stage === 3);
  assert.deepEqual(stage3.map((m) => m.traveler_id), ["t1"]);
});

test("a nudge follows an unanswered request by a week", async () => {
  const t = setup({ now: before(90) });
  approve(t.store, ["t-90", "data-needed"]);
  await tick(t.deps);                                                  // the 90-day message
  assert.ok(t.store.msgs.some((m) => m.template === "t-90" && m.traveler_id === "t1"));
  t.clock.now = new Date(t.clock.now.getTime() + 7 * 86_400_000);
  await tick(t.deps);
  const nudge = t.store.msgs.find((m) => m.template === "data-needed" && m.traveler_id === "t1");
  assert.ok(nudge, "Ann is still missing her flight home and four documents");
  assert.equal(nudge!.meta.after, "t-90");
  assert.equal(nudge!.dedupe_key, dedupeKey("data-needed", "t1", SAIL, "t-90"));
  // never twice
  t.clock.now = new Date(t.clock.now.getTime() + 86_400_000);
  await tick(t.deps);
  assert.equal(t.store.msgs.filter((m) => m.template === "data-needed" && m.traveler_id === "t1").length, 1);
});

test("a group that is a draft, or has sailed, is left alone", async () => {
  const t = setup({ input: fixtureInput({ group: { status: "draft" } }) });
  approve(t.store, ["confirmation", "t-120"]);
  assert.equal((await tick(t.deps)).sent, 0);
  const done = setup({ now: at(addDays(SAIL, 5)) });
  approve(done.store, ["t-2"]);
  assert.equal((await tick(done.deps)).sent, 0);
});

test("approving the template for one group does not approve it for another's default, and the site default reaches a group that has not decided", async () => {
  const t = setup();
  const r = (await setApproval(t.deps, "g1", ["confirmation"], true, false))!;
  assert.equal(r.journey["approved"]["confirmation"].approved, true);
  assert.deepEqual(t.store.defaultsNow, { approved: {} });
  assert.deepEqual(t.cleared, [["confirmation"]]);
  assert.equal((await tick(t.deps)).sent, 4);                           // the group's own approval is enough
  // the default: a second group that has made no decision inherits it
  const u = setup();
  await setApproval(u.deps, "g1", ["t-120"], true, true);
  assert.equal(u.store.defaultsNow.approved["t-120"]!.approved, true);
  const other = fixtureInput(); other.group.journey = {};
  const view = await journeyView({ ...u.deps, store: Object.assign(Object.create(Object.getPrototypeOf(u.store)), u.store, { input: other, journeySaves: [] }) }, "g1");
  assert.equal(view!.view.approvals.find((a) => a.kind === "t-120")!.source, "default");
});

test("the plan view lists every kind with its approval and the plan for each traveler", async () => {
  const t = setup();
  approve(t.store, ["confirmation"]);
  const v = (await journeyView(t.deps, "g1"))!;
  assert.equal(v.view.approvals.length, 11);
  assert.deepEqual(v.view.approvals.filter((a) => a.approved).map((a) => a.kind), ["confirmation"]);
  assert.equal(v.view.plan.travelers.length, 5);
  assert.equal(await journeyView(t.deps, "nope").then(() => "x").catch(() => "err"), "x");
});

test("pickItem prefers the confirmation, then a payment, then the countdown message, then a nudge, and ignores what is blocked", () => {
  const mk = (kind: PlanItem["kind"], date: string | null, extra: Partial<PlanItem> = {}): PlanItem => ({ kind, travelerId: "t", key: kind + date, date, status: "due", reason: null, blocked: null, ...extra });
  assert.equal(pickItem([mk("t-120", "a"), mk("data-needed", "b"), mk("payment-due", "c"), mk("confirmation", null)])!.kind, "confirmation");
  assert.equal(pickItem([mk("t-120", "a"), mk("data-needed", "b"), mk("payment-due", "c")])!.kind, "payment-due");
  assert.equal(pickItem([mk("data-needed", "b"), mk("t-120", "a")])!.kind, "t-120");
  assert.equal(pickItem([mk("t-120", "a", { blocked: "the template is not approved yet" })]), null);
  assert.equal(pickItem([mk("t-120", "a", { status: "sent" })]), null);
});

test("each kind asks only for the outside data it uses", () => {
  assert.deepEqual(needsFor("t-5"), { weather: true, storm: true });
  assert.deepEqual(needsFor("t-10"), { videos: true, rating: true });
  assert.deepEqual(needsFor("t-90"), {});
});

// ── previews ───────────────────────────────────────────────────────────────────

test("a preview shows the template for a sample traveler as it would read on its own day, in either language", async () => {
  const t = setup({ now: at("2026-10-17") });
  const input = await t.store.load();
  const en = await preview(t.deps, input, "t-120");
  assert.ok(en.ok);
  if (en.ok) {
    assert.equal(en.traveler.id, "t1");
    assert.match(en.subject, /^120 days to go/);
    assert.match(en.html, /data-cta="1"/);
    assert.deepEqual(en.sections.slice(0, 2), ["sailing", "payments"]);
  }
  const es = await preview(t.deps, input, "t-120", { lang: "es" });
  assert.ok(es.ok && /^Faltan 120 días/.test(es.subject) && es.lang === "es");
  const other = await preview(t.deps, input, "t-90", { travelerId: "t3" });
  assert.ok(other.ok && other.traveler.id === "t3" && other.lang === "es", "a Spanish traveler's preview defaults to Spanish");
  assert.ok(!(await preview(t.deps, input, "t-90", { travelerId: "nobody" })).ok);
});

test("a payment preview needs a payment with an amount and a date; a reminder preview needs something missing", async () => {
  const t = setup();
  const input = await t.store.load();
  const ok = await preview(t.deps, input, "payment-due");
  assert.ok(ok.ok && /^Payment due January 5, 2027/.test(ok.subject));
  input.payments = [];
  const none = await preview(t.deps, input, "payment-due");
  assert.ok(!none.ok && /no unpaid payment/.test(none.error));
});

test("the 5-day preview says when its weather is today's forecast moved onto the sailing", async () => {
  const t = setup({ now: at("2026-10-17") });
  const input = await t.store.load();
  const r = await preview(t.deps, input, "t-5");
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.sections.includes("weather"));
    assert.match(r.notes[0]!, /moved onto the sailing dates/);
  }
  assert.deepEqual(t.store.extrasCalls.at(-1)!.clock, { realToday: "2026-10-17", simToday: addDays(SAIL, -5) });
});

// ── the simulation ─────────────────────────────────────────────────────────────

test("the simulation writes the whole package, each message as of its own day, and sends only to a listed test address", async () => {
  const t = setup({ allow: "dev-test@example.test" });
  const input = await t.store.load();
  const lines = await simulate(t.deps, input, { travelerId: "t1", toEmail: "dev-test@example.test" });
  assert.ok(Array.isArray(lines));
  const l = lines as Exclude<typeof lines, { error: string }>;
  assert.deepEqual(l.map((x) => x.kind), SIM_SEQUENCE);
  assert.deepEqual(l.map((x) => x.status), Array(8).fill("sent"));
  assert.deepEqual(t.mails.map((m) => m.to), Array(8).fill("dev-test@example.test"));
  assert.match(l[1]!.subject, /^120 days to go/);
  assert.match(l[7]!.subject, /^2 days to go/);
  assert.ok(l[6]!.sections.includes("weather"), "the 5-day message has its forecast");
  assert.ok(l.every((x) => x.sections.length >= 1));
  // each is logged under a sim key, so a real send is never blocked
  assert.equal(t.store.msgs.length, 8);
  assert.ok(t.store.msgs.every((m) => /^sim:\d+:/.test(m.dedupe_key) && m.status === "sent" && m.meta.sim === true && m.to_email === "dev-test@example.test"));
  approve(t.store, ["confirmation"]);
  t.deps.allow = undefined;
  assert.equal((await tick(t.deps)).sent, 4, "the real confirmations still go out after a simulation");
  // no blank placeholder in any of them
  for (const m of t.mails) assert.ok(!/undefined|\bnull\b|NaN|\$0(?![\d,.])|\{\{/.test(`${m.subject}\n${m.text}`));
});

test("the simulation sends nothing when the box has no test list, or the address is not on it, and still shows what it would send", async () => {
  for (const allow of [undefined, "someone-else@example.test"]) {
    const t = setup({ allow });
    const lines = (await simulate(t.deps, await t.store.load(), { travelerId: "t3", toEmail: "dev-test@example.test" })) as Array<{ status: string; reason: string | null; subject: string }>;
    assert.equal(t.mails.length, 0, `allow=${allow}`);
    assert.ok(lines.every((x) => x.status === "skipped" && /test addresses/.test(x.reason!)));
    assert.ok(lines.every((x) => x.subject.length > 5));
    assert.equal(t.store.msgs.length, 8, "the skipped ones are logged too");
    assert.ok(t.store.msgs.every((m) => m.status === "skipped"));
  }
  assert.equal(simMailAllowed("a@b.test", undefined), false);
  assert.equal(simMailAllowed("a@b.test", "  "), false);
  assert.equal(simMailAllowed("a@b.test", "@b.test"), true);
});

test("the simulation refuses a group with no sail date or a box with no link key, and can be limited to some kinds", async () => {
  const t = setup({ allow: "x@example.test" });
  const input = await t.store.load();
  assert.deepEqual(await simulate(t.deps, input, { travelerId: "nope", toEmail: "x@example.test" }), { error: "Traveler not found" });
  assert.match(((await simulate({ ...t.deps, linkKey: null }, input, { travelerId: "t1", toEmail: "x@example.test" })) as { error: string }).error, /link key/);
  input.group.sail_date = null;
  assert.match(((await simulate(t.deps, input, { travelerId: "t1", toEmail: "x@example.test" })) as { error: string }).error, /no sail date/);
  const some = (await simulate(setup({ allow: "x@example.test" }).deps, fixtureInput(), { travelerId: "t1", toEmail: "x@example.test", kinds: ["t-5", "t-2"] })) as Array<{ kind: string }>;
  assert.deepEqual(some.map((x) => x.kind), ["t-5", "t-2"]);
});

// ── change notices ─────────────────────────────────────────────────────────────

const NOTICE = { text: "The ship changes.\nWe will confirm the new dates.", fields: [{ label: "Ship", before: "MSC Seaside", after: "MSC Seashore" }] };

test("a change notice reaches everyone booked who has an address, is recorded on the group for the cruise page, and is safe to repeat", async () => {
  const t = setup({ now: before(60) });
  const input = await t.store.load();
  const r = await sendChangeNotice(t.deps, input, NOTICE);
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.equal(r.sent, 4);
  assert.deepEqual(t.mails.map((m) => m.to).sort(), ["ann@example.test", "bob@example.test", "carlos@example.test", "dulce@example.test"]);
  assert.ok(t.mails.every((m) => /^(A change to your cruise|Un cambio en su crucero)/.test(m.subject)));
  const group = t.store.msgs.find((m) => m.template === "change-notice" && m.traveler_id === null)!;
  assert.deepEqual([group.dedupe_key, group.meta.text, group.meta.fields], [`change:${r.noticeId}`, NOTICE.text, NOTICE.fields]);
  assert.equal(t.store.msgs.filter((m) => m.template === "change-notice" && m.traveler_id).length, 4);
  // Eve (held cabin) is not written to, and says why
  assert.deepEqual(r.recipients.find((x) => x.id === "t5"), { id: "t5", name: "Eve Echo", lang: "en", willSend: false, reason: "cabin not booked yet" });
  // again: nobody is mailed twice
  const again = await sendChangeNotice(t.deps, await t.store.load(), NOTICE);
  assert.ok(!("error" in again) && again.sent === 0 && again.alreadySent === 4);
  assert.equal(t.mails.length, 4);
  // a different notice is a different notice
  const second = await sendChangeNotice(t.deps, await t.store.load(), { ...NOTICE, text: "One more thing." });
  assert.ok(!("error" in second) && second.sent === 4);
  assert.notEqual(noticeId("g1", NOTICE), noticeId("g1", { ...NOTICE, text: "One more thing." }));
});

test("a change notice respects the test list, and a failed email is retried when the notice is sent again", async () => {
  const t = setup({ now: before(60), allow: "ann@example.test" });
  const r = (await sendChangeNotice(t.deps, await t.store.load(), NOTICE)) as { sent: number; recipients: Array<{ id: string; reason: string | null }> };
  assert.equal(r.sent, 1);
  assert.equal(r.recipients.find((x) => x.id === "t2")!.reason, "this box only emails its test addresses");
  let ok = false;
  const u = setup({ now: before(60), sendOk: () => ok });
  assert.equal(((await sendChangeNotice(u.deps, await u.store.load(), NOTICE)) as { failed: number }).failed, 4);
  ok = true;
  assert.equal(((await sendChangeNotice(u.deps, await u.store.load(), NOTICE)) as { sent: number }).sent, 4);
  assert.equal(noticeRecipients(fixtureInput(), undefined).filter((x) => x.willSend).length, 4);
});

test("a change notice without a link key sends nothing", async () => {
  const t = setup({ linkKey: null });
  const r = await sendChangeNotice(t.deps, await t.store.load(), NOTICE);
  assert.ok("error" in r && /link key/.test(r.error));
  assert.equal(t.store.msgs.length, 0);
});

test("the plan the dashboard shows agrees with what the tick does", async () => {
  const t = setup();
  approve(t.store, ["confirmation"]);
  const due = planJourney(await t.store.load(), t.clock.now, { isApproved: (k) => k === "confirmation" }).travelers.flatMap((x) => x.items).filter((i) => i.status === "due" && !i.blocked);
  assert.equal(due.length, 4);
  assert.equal((await tick(t.deps)).sent, 4);
});

test("the dry run exists only where the box asks for it and is not the production site", () => {
  assert.equal(journeySimEnabled({}), false);
  assert.equal(journeySimEnabled({ GROUP_JOURNEY_SIM: "1" }), false, "no address, no dry run");
  assert.equal(journeySimEnabled({ GROUP_JOURNEY_SIM: "1", PUBLIC_URL: "https://dev.example.test" }), true);
  assert.equal(journeySimEnabled({ GROUP_JOURNEY_SIM: "0", PUBLIC_URL: "https://dev.example.test" }), false);
  for (const url of ["https://stillafloatcruising.com", "https://www.stillafloatcruising.com/", "http://dashboard.stillafloatcruising.com"]) {
    assert.equal(journeySimEnabled({ GROUP_JOURNEY_SIM: "1", PUBLIC_URL: url }), false, url);
  }
});
