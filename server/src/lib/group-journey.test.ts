// group-journey.test.ts — the plan, the approvals and every rendered message, in both languages, against a synthetic file.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ALL_KINDS, APPROVABLE_KINDS, DAY_MILESTONES, JOURNEY_TEMPLATE_VERSION, approvalFor, dayKind, dedupeKey, planJourney, renderEmail, renderHub,
  summarizePlan, validateDetails, mergeJourneyAnswers, withApproval, withChecklistTick, videoSourcesFor, type MilestoneKind,
} from "./group-journey";
import { addDays, ctxFor, localToday, ymd, dayDiff, pickVideos, videoFitOf, videoFitsGroup, type Extras, type JourneyInput, type Row } from "./group-journey-facts";
import { SITE_PAGES } from "./group-journey-sections";
import { strings } from "./group-journey-strings";
import { looksLikeCardNumber } from "./group-file";
import { HOUSE_BANNED } from "./group-marketing";
import { fixtureInput, fullExtras, SAIL, VIDEOS } from "./group-journey.fixture";

const TOKEN = "T".repeat(43);
const SITE = "https://dev.example.test";
const at = (date: string) => new Date(`${date}T15:00:00Z`);
const before = (n: number) => at(addDays(SAIL, -n));

function ctx(input: JourneyInput, id: string, now: Date, extras: Extras = fullExtras(), lang?: "en" | "es") {
  const c = ctxFor(input, id, { now, token: TOKEN, site: SITE, extras, ...(lang ? { lang } : {}) });
  assert.ok(c, `no traveler ${id}`);
  return c!;
}

const approvedAll = () => true;
const item = (plan: ReturnType<typeof planJourney>, tid: string, kind: string, extra?: string) =>
  plan.travelers.find((t) => t.id === tid)!.items.find((i) => i.kind === kind && (!extra || i.key.endsWith(extra)));

// ── keys and approvals ─────────────────────────────────────────────────────────

test("the dedupe key carries the kind, the traveler, the sail date and any extra", () => {
  assert.equal(dedupeKey("t-120", "t1", "2027-03-06"), "journey:t-120:t1:2027-03-06");
  assert.equal(dedupeKey("payment-due", "t1", "2027-03-06", "p2:14"), "journey:payment-due:t1:2027-03-06:p2:14");
  assert.equal(dedupeKey("t-120", "t1", null), "journey:t-120:t1:no-date");
});

test("a template is approved by the group, or by the site default, and only at the current words", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  assert.deepEqual(approvalFor("t-120", {}, null), { approved: false, source: "none", at: null, stale: false });
  const def = { approved: { "t-120": { approved: true, at: "2026-10-01T00:00:00Z", version: JOURNEY_TEMPLATE_VERSION } } };
  assert.equal(approvalFor("t-120", {}, def).approved, true);
  assert.equal(approvalFor("t-120", {}, def).source, "default");
  assert.equal(approvalFor("t-90", {}, def).approved, false);
  // the group's own decision wins over the default, in both directions
  const own = withApproval({}, ["t-120"], false, now);
  assert.deepEqual([approvalFor("t-120", own, def).approved, approvalFor("t-120", own, def).source], [false, "group"]);
  assert.equal(approvalFor("t-90", withApproval({}, ["t-90"], true, now), null).approved, true);
  // older words are not an approval
  const old = { approved: { "t-120": { approved: true, at: "2026-09-01T00:00:00Z", version: "2026-01-01.0" } } };
  assert.deepEqual(approvalFor("t-120", old, null), { approved: false, source: "group", at: "2026-09-01T00:00:00Z", stale: true });
  assert.deepEqual(approvalFor("t-120", {}, old), { approved: false, source: "default", at: "2026-09-01T00:00:00Z", stale: true });
  // taking the group's own decision away makes it follow the default again
  const cleared = withApproval(own, ["t-120"], null, now);
  assert.deepEqual([approvalFor("t-120", cleared, def).approved, approvalFor("t-120", cleared, def).source], [true, "default"]);
  assert.deepEqual(withApproval({}, ["t-120"], null, now), { approved: {} });
  // only real kinds are stored
  assert.deepEqual(Object.keys(withApproval({}, ["t-120", "change-notice", "nonsense"], true, now)["approved"]), ["t-120"]);
});

test("video sources default to Mark's own channel only", () => {
  assert.deepEqual(videoSourcesFor({}, null), ["own"]);
  assert.deepEqual(videoSourcesFor({}, { approved: {}, videoSources: ["own", "x"] }), ["own", "x"]);
  assert.deepEqual(videoSourcesFor({ videoSources: ["own"] }, { approved: {}, videoSources: ["x"] }), ["own"]);
});

// ── the plan ───────────────────────────────────────────────────────────────────

test("100 days out: the confirmation and the 120-day message are due; nothing is sent until the template is approved", () => {
  const input = fixtureInput();
  const plan = planJourney(input, before(100));
  assert.equal(plan.daysToSail, 100);
  assert.equal(plan.live, true);
  const a = item(plan, "t1", "confirmation")!;
  assert.deepEqual([a.status, a.blocked], ["due", "the template is not approved yet"]);
  assert.equal(item(plan, "t1", "t-120")!.status, "due");
  assert.equal(item(plan, "t1", "t-90")!.status, "planned");
  assert.equal(item(plan, "t1", "t-90")!.date, addDays(SAIL, -90));
  // once approved nothing is blocked
  const ok = planJourney(input, before(100), { isApproved: approvedAll });
  assert.equal(item(ok, "t1", "t-120")!.blocked, null);
  // a held cabin is not booked, and a traveler without an address cannot be written to
  assert.deepEqual([item(plan, "t5", "t-120")!.status, item(plan, "t5", "t-120")!.reason], ["skipped", "cabin not booked yet"]);
  const noMail = planJourney(fixtureInput({ noEmailFor: ["t2"] }), before(100));
  assert.deepEqual([item(noMail, "t2", "t-120")!.status, item(noMail, "t2", "t-120")!.reason], ["skipped", "no email address on file"]);
  assert.equal(noMail.travelers.find((t) => t.id === "t2")!.hasEmail, false);
});

test("a late start sends only the latest milestone that has come due; the earlier ones are skipped as superseded", () => {
  const plan = planJourney(fixtureInput(), before(40), { isApproved: approvedAll });
  assert.equal(item(plan, "t3", "t-45")!.status, "due");
  for (const k of ["t-120", "t-90"]) {
    const i = item(plan, "t3", k)!;
    assert.deepEqual([i.status, i.reason], ["skipped", "superseded by the 45-day message"]);
  }
  assert.equal(item(plan, "t3", "t-20")!.status, "planned");
  const late = planJourney(fixtureInput(), before(1), { isApproved: approvedAll });
  assert.equal(item(late, "t3", "t-2")!.status, "due");
  assert.equal(item(late, "t3", "t-5")!.status, "skipped");
});

test("on the day of sailing and after it, nothing more is sent", () => {
  const day = planJourney(fixtureInput(), before(0), { isApproved: approvedAll });
  assert.equal(item(day, "t1", "t-2")!.status, "skipped");
  assert.equal(day.live, true);
  const after = planJourney(fixtureInput(), at(addDays(SAIL, 3)), { isApproved: approvedAll });
  assert.equal(after.live, false);
  assert.match(after.liveReason!, /passed/);
  assert.ok(after.travelers.every((t) => t.items.every((i) => i.status !== "due")));
});

test("what has gone out is remembered: a sent key is sent, a failure is retried until the third time", () => {
  const sentMsg = (k: string, o: Row = {}) => ({ dedupe_key: k, status: "sent", sent_at: "2026-11-27T15:00:00Z", ...o });
  const input = fixtureInput({ extraMessages: [
    sentMsg(dedupeKey("confirmation", "t1", SAIL)), sentMsg(dedupeKey("t-120", "t1", SAIL)),
    { dedupe_key: dedupeKey("t-120", "t3", SAIL), status: "failed", meta: { attempts: 1 }, created_at: "2026-11-27T15:00:00Z" },
    { dedupe_key: dedupeKey("t-120", "t4", SAIL), status: "failed", meta: { attempts: 3 }, created_at: "2026-11-27T15:00:00Z" },
    { dedupe_key: "sim:1700000000000:t-120:t2", status: "sent", sent_at: "2026-11-27T15:00:00Z" },
  ] });
  const plan = planJourney(input, before(100), { isApproved: approvedAll });
  assert.equal(item(plan, "t1", "confirmation")!.status, "sent");
  assert.equal(item(plan, "t1", "t-120")!.status, "sent");
  assert.equal(item(plan, "t3", "t-120")!.status, "due");               // one failure: try again
  assert.deepEqual([item(plan, "t4", "t-120")!.status, item(plan, "t4", "t-120")!.reason], ["failed", "failed 3 times"]);
  assert.equal(item(plan, "t2", "t-120")!.status, "due");               // a simulated send never counts
});

test("a payment is announced to the cabin's lead 14 days and 3 days before it is due, once each, until it is paid", () => {
  const input = fixtureInput();
  const stage = (now: Date, tid: string, n: number) => item(planJourney(input, now, { isApproved: approvedAll }), tid, "payment-due", `p2:${n}`);
  assert.equal(stage(at("2026-12-20"), "t1", 14)!.status, "planned");
  assert.equal(stage(at("2026-12-22"), "t1", 14)!.status, "due");
  assert.equal(stage(at("2026-12-22"), "t1", 3)!.status, "planned");
  assert.deepEqual([stage(at("2027-01-03"), "t1", 14)!.status, stage(at("2027-01-03"), "t1", 14)!.reason], ["skipped", "superseded by the 3-day message"]);
  assert.equal(stage(at("2027-01-03"), "t1", 3)!.status, "due");
  assert.equal(stage(at("2027-01-05"), "t1", 3)!.status, "due");        // the day itself still counts
  assert.equal(stage(at("2027-01-06"), "t1", 3)!.reason, "the date has passed");
  // the other traveler in the cabin is not written to
  assert.equal(stage(at("2027-01-03"), "t2", 3), undefined);
  // a paid row has no notice, and a row with no amount is skipped with its reason
  const paid = fixtureInput(); paid.payments.find((p) => p.id === "p2")!.paid_at = "2026-12-30T00:00:00Z";
  assert.equal(item(planJourney(paid, at("2027-01-03")), "t1", "payment-due", "p2:3"), undefined);
  const nul = fixtureInput(); nul.payments.find((p) => p.id === "p2")!.amount = null;
  assert.equal(item(planJourney(nul, at("2027-01-03")), "t1", "payment-due", "p2:3")!.reason, "no amount on file for this payment");
});

test("seven days after a request that went out, a nudge follows if something is still missing", () => {
  const sent = { dedupe_key: dedupeKey("t-90", "t1", SAIL), status: "sent", sent_at: "2026-12-06T15:00:00Z" };
  const input = fixtureInput({ extraMessages: [sent] });
  const day = (d: string) => item(planJourney(input, at(d), { isApproved: approvedAll }), "t1", "data-needed")!;
  assert.deepEqual([day("2026-12-10").status, day("2026-12-10").date], ["planned", "2026-12-13"]);
  assert.equal(day("2026-12-13").status, "due");                        // Ann still has no flight out and no paperwork complete
  assert.equal(day("2026-12-13").after, "t-90");
  // everything in: nothing to chase
  const done = fixtureInput({ extraMessages: [sent] });
  done.signatures = ["15-emergency-contact-form", "01-terms-and-conditions", "05-liability-waiver", "07-travel-insurance-declination", "16-passport-document-checklist", "12-cruise-booking-agreement"].map((k) => ({ traveler_id: "t1", doc_key: k, signer_role: "traveler", signed_at: "2026-11-01T00:00:00Z" }));
  done.travelers[0]!.form_data = { journey: { getting_there: "driving" } };
  const quiet = item(planJourney(done, at("2026-12-13"), { isApproved: approvedAll }), "t1", "data-needed")!;
  assert.deepEqual([quiet.status, quiet.reason], ["skipped", "nothing is missing"]);
  // no request sent, no nudge
  assert.equal(item(planJourney(fixtureInput(), at("2026-12-13")), "t1", "data-needed"), undefined);
});

test("a group that is not live (draft, or past) blocks every due message with the reason", () => {
  const draft = planJourney(fixtureInput({ group: { status: "draft" } }), before(100), { isApproved: approvedAll });
  assert.equal(draft.live, false);
  assert.match(draft.liveReason!, /"draft"/);
  const i = item(draft, "t1", "t-120")!;
  assert.deepEqual([i.status, !!i.blocked], ["due", true]);
});

test("the summary has a line per kind with counts and the day each countdown message goes out", () => {
  const input = fixtureInput();
  const rows = summarizePlan(planJourney(input, before(100), { isApproved: approvedAll }), input.group);
  assert.deepEqual(rows.map((r) => r.kind), ALL_KINDS);
  const m = rows.find((r) => r.kind === "t-90")!;
  assert.equal(m.date, addDays(SAIL, -90));
  assert.equal(m.counts.planned, 4);
  assert.equal(rows.find((r) => r.kind === "t-120")!.counts.due, 4);
  assert.equal(rows.find((r) => r.kind === "t-120")!.sampleTravelerId, "t1");
});

// ── the messages ───────────────────────────────────────────────────────────────

const COUNTDOWN = DAY_MILESTONES.map((n) => dayKind(n));

function renderAll(lang: "en" | "es") {
  const input = fixtureInput();
  const out: Array<{ kind: MilestoneKind; who: string; r: NonNullable<ReturnType<typeof renderEmail>> }> = [];
  for (const who of ["t1", "t3"]) {
    for (const kind of [...APPROVABLE_KINDS, "change-notice"] as MilestoneKind[]) {
      const n = DAY_MILESTONES.find((d) => dayKind(d) === kind);
      const c = ctx(input, who, n ? before(n) : before(100), fullExtras(), lang);
      const payment = input.payments.find((p) => p.id === (who === "t1" ? "p2" : "p4"))!;
      const r = renderEmail(kind, c, { payment, notice: { text: "The ship changes.\nWe will confirm the new dates.", fields: [{ label: "Ship", before: "MSC Seaside", after: "MSC Seashore" }] } });
      assert.ok(r, `${kind} for ${who} in ${lang} rendered nothing`);
      out.push({ kind, who, r: r! });
    }
  }
  return out;
}

const EMOJI = /\p{Extended_Pictographic}/u;
const BAD_TEXT = /undefined|\bnull\b|NaN|\$0(?![\d,.])|\{\{|\[object|\bNaN\b/;

for (const lang of ["en", "es"] as const) {
  test(`every message in ${lang === "en" ? "English" : "Spanish"} keeps the house rules: one button, Mark's line, the signoff, no hype, no blanks`, () => {
    for (const { kind, who, r } of renderAll(lang)) {
      const where = `${kind} / ${who} / ${lang}`;
      const all = `${r.subject}\n${r.text}`;
      const words = all.replace(/https?:\/\/\S+/g, " ");
      assert.equal((r.html.match(/data-cta="1"/g) || []).length, 1, `${where}: exactly one primary button`);
      assert.ok(r.html.includes(`href="${SITE}/my-cruise.html?t=${TOKEN}"`), `${where}: the button goes to the cruise page`);
      assert.ok(r.text.includes(`${SITE}/my-cruise.html?t=${TOKEN}`), `${where}: the plain link is in the text`);
      assert.match(r.text, lang === "en" ? /Questions\? Mark Millham · 919-346-6127 · mark@stillafloatcruising\.com/ : /¿Preguntas\? Mark Millham · 919-346-6127 · mark@stillafloatcruising\.com/, `${where}: Mark's contact line`);
      assert.equal(r.text.trimEnd().split("\n").pop(), "Still Afloat Cruising", `${where}: ends with the signoff on its own line`);
      assert.ok(!r.html.includes("data-cta=\"1\"") || r.html.indexOf("data-cta") < r.html.indexOf("Still Afloat Cruising</p>"), `${where}: the button comes before the signoff`);
      assert.ok(!BAD_TEXT.test(all), `${where}: has a blank placeholder (${BAD_TEXT.exec(all)?.[0]})`);
      assert.ok(!EMOJI.test(all), `${where}: has an emoji`);
      assert.ok(!/!/.test(all), `${where}: has an exclamation mark`);
      assert.ok(!/\bactually\b/i.test(all) && !/\bcheap(er|est)?\b/i.test(all) && !/\bbarat[oa]s?\b/i.test(all), `${where}: a banned word`);
      for (const b of HOUSE_BANNED[lang]) assert.ok(!b.re.test(all), `${where}: ${b.problem}`);
      if (lang === "en" && kind !== "change-notice") assert.ok(!/\b(I|I'm|I'll|I've|my)\b/.test(words), `${where}: Mark must never speak in the first person`);
      assert.ok(!/Join Mark/i.test(all), `${where}: Join Mark`);
      assert.ok(r.sections.length >= 1 && r.sections.every((k) => /^[a-z-]+$/.test(k)), `${where}: section names`);
      assert.ok(r.html.length < 40_000, `${where}: oversized`);
    }
  });
}

test("the Spanish twin is Spanish: greeting, subject, button and contact line all speak Spanish", () => {
  for (const { kind, r } of renderAll("es")) {
    assert.match(r.text, /^Hola /, `${kind}: greeting`);
    assert.ok(!/\bHello\b/.test(r.text), `${kind}: an English greeting in the Spanish message`);
    assert.ok(r.text.includes("Abrir la página de su crucero"), `${kind}: button`);
  }
  const t1 = renderAll("es").find((x) => x.kind === "t-120" && x.who === "t1")!.r;
  assert.match(t1.subject, /^Faltan 120 días: pagos/);
});

test("a traveler whose language is Spanish gets the Spanish message without being asked", () => {
  const input = fixtureInput();
  const c = ctx(input, "t3", before(100), fullExtras(), undefined);
  assert.equal(c.lang, "es");
  assert.match(renderEmail("t-120", c)!.subject, /^Faltan 100 días/);
  assert.match(renderEmail("t-120", ctx(input, "t1", before(100)))!.subject, /^100 days to go/);
});

test("the subject counts the days that are really left", () => {
  const input = fixtureInput();
  assert.equal(renderEmail("t-45", ctx(input, "t1", before(44)))!.subject, "44 days to go: excursions, dining and what is still open");
  assert.equal(renderEmail("t-2", ctx(input, "t1", before(1)))!.subject, "1 day to go: check-in, boarding and what to bring");
});

test("the 120-day message: sailing, payment schedule, paperwork, passport, insurance and the first checklist items", () => {
  const input = fixtureInput();
  const r = renderEmail("t-120", ctx(input, "t1", before(120)))!;
  assert.deepEqual(r.sections, ["sailing", "payments", "paperwork", "passport", "insurance", "checklist"]);
  assert.match(r.text, /MSC Seaside, sailing March 6, 2027, from Miami, Florida\./);
  assert.match(r.text, /7 nights, back on March 13, 2027\./);
  assert.match(r.text, /120 days to go\./);
  assert.match(r.text, /Deposit: \$400, paid on October 20, 2026\./);
  assert.match(r.text, /Final payment: \$2,800, due January 5, 2027\./);
  assert.match(r.text, /These amounts are for cabin 8123\./);
  assert.match(r.text, /Payments are made directly to the cruise line or supplier by the client\./);
  assert.match(r.text, /You have signed 2 of 6 documents\./);
  assert.match(r.text, /- Liability Waiver/i);
  assert.match(r.text, /passport on your file expires June 1, 2027, less than six months after you return/);
  assert.match(r.text, /Mark offers Allianz plans/);
  assert.match(r.text, /Check your passport/);
  assert.ok(!/Book your flights/.test(r.text), "a task due after the next milestone is for a later message");
  assert.ok(!/Print your boarding passes/.test(r.text), "a task due after the next milestone is not in this message yet");
  assert.ok(!/Chase the line/.test(r.text), "Mark's own to-dos never reach a client");
  // the insurance video from Mark's channel
  assert.match(r.text, /Cruise Travel Insurance: Is It Worth It\? \(https:\/\/www\.youtube\.com\/watch\?v=AAAAAAAAAA1\)/);
});

test("the 90-day message: what is open, the line's dates before the 45-day mark, and how the traveler is getting there", () => {
  const input = fixtureInput();
  const r = renderEmail("t-90", ctx(input, "t1", before(90)))!;
  assert.deepEqual(r.sections, ["sailing", "payments", "deadlines", "travel", "travel-needed", "checklist"]);
  assert.match(r.text, /Final payment: \$2,800, due January 5, 2027\./);
  assert.ok(!/Deposit:/.test(r.text), "the paid deposit is not repeated in the open list");
  assert.match(r.text, /passenger names by December 15, 2026/);
  assert.match(r.text, /December 20, 2026: Specialty dining reservations/);
  assert.ok(!/Name changes carry a fee/.test(r.text), "a date after the 45-day mark is for the next message");
  assert.match(r.text, /Flight to the port city: American AA 1234, RDU → MIA, March 5, 2027, confirmation ABC123/);
  assert.match(r.text, /Hotel before the cruise: Hotel Example Miami, March 5, 2027 – March 6, 2027, confirmation HX99/);
  assert.match(r.text, /Your flight home, or a note that you are driving/);
  assert.match(r.text, /Book your flights \(by December 15, 2026\) — Fly in the day before\./);
  assert.match(r.text, new RegExp(`${SITE}/my-cruise\\.html\\?t=${TOKEN}#details`));
  assert.ok(!/Group offer hotel/.test(r.text), "the group's own offer is not a booking");
  assert.match(r.text, /On file for you:\n- Flight to the port city: American/, "a list's label sits right above the list");
  assert.match(r.text, /Your flight home, or a note[^\n]*\nIf you have a hotel before the cruise|Your flight home, or a note[^\n]*\n\nIf you have a hotel before the cruise/, "the note about hotels comes after the list, not before it");
});

test("the 45-day message: excursions, dining and change windows, and what is still missing", () => {
  const input = fixtureInput();
  const r = renderEmail("t-45", ctx(input, "t1", before(45)))!;
  assert.deepEqual(r.sections, ["sailing", "excursions", "dining", "missing", "checklist"]);
  assert.match(r.text, /Nassau: Junkanoo walking tour — Two hours\. \(https:\/\/example\.test\/nassau\)/);
  assert.match(r.text, /Dining on file for your cabin: Late seating\./);
  assert.match(r.text, /January 20, 2027: Name changes carry a fee after this date\./);
  assert.match(r.text, /Paperwork: 4 documents still to sign/);
  assert.match(r.text, /How you are getting home/);
});

test("the 45-day subject and opening line name only the sections the message really has", () => {
  const sayOf = (input: JourneyInput, id = "t1") => { const r = renderEmail("t-45", ctx(input, id, before(45)))!; return { r, subject: r.subject.replace(/^[^:]*: /, "") }; };
  const intro = (r: { text: string }) => r.text.split("\n\n")[1];
  // the file has excursions, dining and open items: all three are promised, and all three are there
  const both = sayOf(fixtureInput());
  assert.equal(both.subject, "excursions, dining and what is still open");
  assert.equal(intro(both.r), "This is the time to settle excursions and dining, and to send us anything still missing.");
  // no excursion rows on the file: the message does not promise any
  const noEx = fixtureInput(); noEx.checklist = noEx.checklist.filter((r) => r.kind !== "excursion");
  const a = sayOf(noEx);
  assert.ok(!a.r.sections.includes("excursions"));
  assert.equal(a.subject, "dining and what is still open");
  assert.equal(intro(a.r), "This is the time to settle dining, and to send us anything still missing.");
  assert.ok(!/excursion/i.test(a.r.subject + intro(a.r)));
  // no dining on the file (no seating, and none of the line's dates is about dining or name changes): no promise of dining
  const noDin = fixtureInput(); noDin.cabins[0]!.dining = null; (noDin.group["terms"] as Row)["deadlines"] = [];
  const b = sayOf(noDin);
  assert.ok(!b.r.sections.includes("dining"));
  assert.equal(b.subject, "excursions and what is still open");
  assert.equal(intro(b.r), "This is the time to settle excursions, and to send us anything still missing.");
  // neither: only the open items are promised
  const neither = fixtureInput(); neither.checklist = neither.checklist.filter((r) => r.kind !== "excursion"); neither.cabins[0]!.dining = null; (neither.group["terms"] as Row)["deadlines"] = [];
  const c = sayOf(neither);
  assert.deepEqual(c.r.sections, ["sailing", "missing", "checklist"]);
  assert.equal(c.subject, "what is still open");
  assert.equal(intro(c.r), "This is the time to send us anything still missing.");
  assert.ok(!/excursion|dining/i.test(c.r.subject + c.r.text));
  // the Spanish twin says the same things
  const es = sayOf(noEx, "t3");
  assert.equal(es.subject, "comidas y lo que sigue pendiente");
  assert.equal(intro(es.r), "Este es el momento de decidir las comidas, y de enviarnos lo que todavía falta.");
  // and with nothing but the sailing, no promise at all
  const E = strings("en"), S = strings("es");
  assert.equal(E.topicFor("t-45", () => false), "where your cruise stands");
  assert.equal(E.introFor("t-45", () => false), "Here is where your cruise stands.");
  assert.equal(S.topicFor("t-45", () => false), "cómo va su crucero");
  assert.equal(S.introFor("t-45", () => false), "Aquí está cómo va su crucero.");
  // a kind whose words do not depend on its sections keeps its fixed words
  assert.equal(E.topicFor("t-2", () => true), null);
  assert.equal(E.introFor("t-2", () => true), null);
});

test("the other countdown messages also name only the sections they have, in both languages", () => {
  const E = strings("en"), S = strings("es");
  const has = (...keys: string[]) => (k: string) => keys.includes(k);
  assert.equal(E.topicFor("t-120", has("payments", "paperwork")), "payments, paperwork and what to do first");
  assert.equal(E.topicFor("t-120", has("paperwork")), "paperwork and what to do first");
  assert.equal(E.topicFor("t-120", has()), "what to do first");
  assert.equal(E.topicFor("t-90", has("payments", "deadlines", "travel")), "final payment, line deadlines and getting to the ship");
  assert.equal(E.topicFor("t-90", has("travel-needed")), "getting to the ship");
  assert.equal(E.topicFor("t-90", has()), "what is open on your file");
  assert.equal(E.introFor("t-90", has("deadlines", "travel")), "This is when the dates that matter start to show up: deadlines from the cruise line and how you are getting to the ship.");
  assert.equal(E.introFor("t-90", has()), "Here is where your cruise stands.");
  assert.equal(E.topicFor("t-10", has("ship")), "your ship and how boarding day works");
  assert.equal(E.topicFor("t-10", has()), "how boarding day works");
  assert.equal(E.introFor("t-10", has()), "Here is how boarding day works.");
  assert.equal(E.topicFor("t-5", has("weather", "pack-tweaks")), "the forecast for your cruise");
  assert.equal(E.topicFor("t-5", has("storm")), "Storm Watch and your cruise");
  assert.equal(E.topicFor("t-5", has()), "a last note before you sail");
  assert.equal(E.introFor("t-5", has("weather")), "The forecast for your cruise.");
  assert.equal(S.topicFor("t-120", has("payments", "paperwork")), "pagos, documentos y qué hacer primero");
  assert.equal(S.topicFor("t-90", has("payments", "deadlines", "travel")), "pago final, fechas de la naviera y cómo llegar al barco");
  assert.equal(S.topicFor("t-45", has("excursions", "dining", "missing")), "excursiones, comidas y lo que sigue pendiente");
  assert.equal(S.topicFor("t-10", has("ship")), "su barco y cómo funciona el día de embarque");
  assert.equal(S.introFor("t-5", has()), "Una última nota antes de zarpar.");
  // the 5-day message in the file that cannot give a forecast no longer promises one
  const none = renderEmail("t-5", ctx(fixtureInput(), "t1", before(5), fullExtras({ weather: null })))!;
  assert.deepEqual(none.sections, ["sailing"]);
  assert.equal(none.subject, "5 days to go: a last note before you sail");
  assert.ok(!/forecast/i.test(none.subject + none.text.split("\n\n")[1]));
  // and a message with its ship and the forecast keeps the words it always had
  assert.equal(renderEmail("t-5", ctx(fixtureInput(), "t1", before(5)))!.subject, "5 days to go: the forecast for your cruise");
  assert.equal(renderEmail("t-10", ctx(fixtureInput(), "t1", before(10)))!.subject, "10 days to go: your ship and how boarding day works");
});

test("a deposit with no date is due when the paperwork is completed (Mark 2026-10-26), never 'date to be confirmed'; other payments with no date keep that wording", () => {
  const input = fixtureInput({ group: { deposit_due: null, terms: { deposit_timing: "at_booking", deadlines: [] } } });
  const dep = input.payments.find((p) => p.id === "p3")!; dep.paid_at = null; dep.due_date = null;       // Carlos and Dulce's cabin: deposit due at booking
  const fin = input.payments.find((p) => p.id === "p4")!; fin.due_date = null;                           // and a final payment with no date yet
  const en = renderEmail("t-120", ctx(input, "t3", before(120), fullExtras(), "en"))!;
  assert.match(en.text, /Deposit: \$400, due when your paperwork is completed \(either through me or on the cruise line's website\)\./);
  assert.match(en.text, /Final payment: \$2,200, date to be confirmed\./);
  assert.ok(!/Deposit: \$400, date to be confirmed/.test(en.text));
  const es = renderEmail("t-120", ctx(input, "t3", before(120)))!;
  assert.match(es.text, /Depósito: \$400, se paga cuando complete su documentación \(conmigo o en el sitio web de la naviera\)\./);
  assert.match(es.text, /Pago final: \$2,200, fecha por confirmar\./);
  assert.ok(!/Depósito: \$400, fecha por confirmar/.test(es.text));
  // the cruise page says the same
  const hub = renderHub(ctx(input, "t3", before(120), fullExtras(), "en"));
  assert.ok(hub.sections.find((x) => x.key === "payments")!.lines.includes("Deposit: $400, due when your paperwork is completed (either through me or on the cruise line's website)."));
  // a deposit that has a date, or is paid, is unchanged
  assert.match(renderEmail("t-120", ctx(fixtureInput(), "t1", before(120)))!.text, /Deposit: \$400, paid on October 20, 2026\./);
});

test("the 20-day message: web check-in from the terms, documents, packing from the checklist and the site, and the packing video", () => {
  const input = fixtureInput();
  const r = renderEmail("t-20", ctx(input, "t1", before(20)))!;
  assert.deepEqual(r.sections, ["sailing", "checkin", "documents", "packing", "videos", "checklist"]);
  assert.match(r.text, /Web check-in opens February 14, 2027\./);
  assert.match(r.text, /Your booking number: 7781234/);
  assert.match(r.text, /Hotel before the cruise: Hotel Example Miami/);
  assert.match(r.text, /Power strip without surge protection — Ships ban the surge kind\. \(https:\/\/example\.test\/strip\)/);
  assert.match(r.text, /From your list:\n- Power strip/, "a list's label sits right above the list");
  assert.match(r.text, new RegExp(`What to wear: ${SITE}/affiliate/clothing\\.html`));
  assert.match(r.text, /What to Pack for a Cruise/);
  assert.match(r.text, /Print your boarding passes \(by February 20, 2027\)/);
  // the Spanish one links the Spanish pages and says the line's sentence is in English
  const es = renderEmail("t-20", ctx(input, "t3", before(20)))!;
  assert.match(es.text, new RegExp(`${SITE}/es/affiliate/clothing\\.html`));
  assert.match(es.text, /El registro en línea abre el 14 de febrero de 2027\./);
  assert.match(es.text, /\(en inglés\)/);
});

test("the 10-day message: ship facts, the Conga Line score and note, the cabin, and boarding day part one", () => {
  const input = fixtureInput();
  const r = renderEmail("t-10", ctx(input, "t1", before(10)))!;
  assert.deepEqual(r.sections, ["sailing", "ship", "embark", "videos"]);
  assert.match(r.text, /MSC Seaside is a Seaside class ship\./);
  assert.match(r.text, /Our Conga Line score for MSC Seaside: 4\.2 out of 5\./);
  assert.match(r.text, /The buffet queue has its own weather system\./);
  assert.match(r.text, /Your cabin: Balcony, cabin 8123, deck 8\./);
  assert.match(r.text, /Bed setup on file: Two twin beds\./);
  assert.match(r.text, new RegExp(`Follow MSC Seaside on our ship tracker: ${SITE}/wheres-my-ship\\.html\\?ship=MSC%20Seaside`));
  assert.match(r.text, /You board at Miami, Florida on March 6, 2027\./);
  assert.match(r.text, /The ship is scheduled to leave at 4:30 PM\./);
  assert.match(r.text, /luggage tags/);
  assert.match(r.text, /safety drill \(the muster\)/);
  assert.match(r.text, /Your First Cruise: Embarkation Day Step by Step/);
  assert.match(r.text, /Cruise Cabin Types Explained/);
});

test("the 5-day message: a stubbed forecast becomes a table of the embark port and the ports of call inside the horizon, then packing notes", () => {
  const input = fixtureInput();
  const r = renderEmail("t-5", ctx(input, "t1", before(5)))!;
  assert.deepEqual(r.sections, ["sailing", "weather", "pack-tweaks"]);
  const table = r.blocks.find((b) => b.key === "weather")!.table!;
  assert.deepEqual(table.head, ["Day", "Place", "High / Low", "Sky"]);
  assert.deepEqual(table.rows, [
    ["Sat, Mar 6", "Miami", "82° / 70°F", "mainly clear"],
    ["Mon, Mar 8", "Nassau", "80° / 71°F", "light showers"],
    ["Tue, Mar 9", "Cozumel", "84° / 52°F", "clear sky"],
  ]);
  assert.match(r.text, /Forecast as of March 1, 2027\./);
  assert.match(r.text, /Weather data by Open-Meteo\.com\./);
  assert.match(r.text, /Showers show up in the forecast/);
  assert.match(r.text, /Evenings may run cool/);
  assert.ok(!/It will be warm/.test(r.text), "no day reaches 85");
  assert.ok(!/Ocean Cay/.test(r.text) && !/Mar 11/.test(r.text), "a port of call beyond the forecast horizon is left out");
  const es = renderEmail("t-5", ctx(input, "t3", before(5)))!;
  assert.deepEqual(es.blocks.find((b) => b.key === "weather")!.table!.rows[1], ["lun, 8 mar", "Nassau", "80° / 71°F", "chubascos ligeros"]);
  assert.deepEqual(es.blocks.find((b) => b.key === "weather")!.table!.head, ["Día", "Lugar", "Máx. / Mín.", "Cielo"]);
});

test("the 5-day message names an active storm that lists the ship, and says so plainly when the forecast cannot be had", () => {
  const input = fixtureInput();
  const storm = { name: "Gonzalo", classification: "Tropical Storm", headline: "x" };
  const r = renderEmail("t-5", ctx(input, "t1", before(5), fullExtras({ storm })))!;
  assert.deepEqual(r.sections, ["sailing", "storm", "weather", "pack-tweaks"]);
  assert.match(r.text, /Our Storm Watch lists MSC Seaside among the ships to watch for Tropical Storm Gonzalo\. A listed ship is one to watch, not one that has changed course\./);
  assert.match(r.text, new RegExp(`See Storm Watch: ${SITE}/storm-watch\\.html`));
  const es = renderEmail("t-5", ctx(input, "t3", before(5), fullExtras({ storm })))!;
  assert.match(es.text, /por la tormenta tropical Gonzalo/);
  // no forecast: the weather and the packing notes are left out, never left blank
  const none = renderEmail("t-5", ctx(input, "t1", before(5), fullExtras({ weather: null })))!;
  assert.deepEqual(none.sections, ["sailing"]);
});

test("a preview far from the sailing moves today's real forecast onto the sailing dates and says so", () => {
  const input = fixtureInput();
  // real today = 2026-10-17; the sailing is at 2027-03-06, so the real forecast covers 2026-10-17..26
  const real = (d: string, h: number, l: number, code: number) => ({ day: d, high: h, low: l, code });
  const shift = 140; // sail day − real today
  const ex = fullExtras({ weather: { shiftDays: shift, sample: true, places: { miami: [real("2026-10-17", 88, 76, 2)], nassau: [real("2026-10-19", 86, 75, 0)], cozumel: [real("2026-10-20", 87, 74, 3)] } } });
  const r = renderEmail("t-5", ctx(input, "t1", before(5), ex))!;
  const rows = r.blocks.find((b) => b.key === "weather")!.table!.rows;
  assert.deepEqual(rows.map((x) => x[1]), ["Miami", "Nassau", "Cozumel"]);
  assert.match(r.text, /Preview only: this table uses today's real forecast/);
  assert.match(r.text, /It will be warm/);
});

test("the 2-day message: when check-in closes, boarding, documents, the emergency contact on file, and the farewell", () => {
  const input = fixtureInput();
  const r = renderEmail("t-2", ctx(input, "t1", before(2)))!;
  assert.deepEqual(r.sections, ["sailing", "checkin", "boarding", "documents", "emergency", "videos"]);
  assert.match(r.text, /Check-in closes March 4, 2027\./);
  assert.match(r.text, /Web check-in closes 48 hours prior to sailing/);
  assert.match(r.text, /We have on file: Sam Alpha, 919-555-0100\./);
  assert.match(r.text, new RegExp(`Check it, or change it, on your cruise page: ${SITE}/my-cruise\\.html\\?t=${TOKEN}#details`));
  assert.match(r.text, /See you aboard\.\n\nOpen your cruise page/);
  // Bob has no emergency contact on file: the message says so
  assert.match(renderEmail("t-2", ctx(input, "t2", before(2)))!.text, /We do not have an emergency contact on file for you\./);
  // what he told us about arriving is used
  const told = fixtureInput(); told.travelers.find((t) => t.id === "t2")!.form_data = { journey: { port_arrival_time: "11:30" } };
  assert.match(renderEmail("t-2", ctx(told, "t2", before(2)))!.text, /around 11:30 AM/);
});

test("the booking confirmation: what is booked, what was signed, the payment schedule and the dates of what comes next", () => {
  const input = fixtureInput();
  const r = renderEmail("confirmation", ctx(input, "t1", before(100)))!;
  assert.deepEqual(r.sections, ["booked", "signed", "paperwork", "payments", "next"]);
  assert.equal(r.subject, "You are booked: MSC Seaside, sailing March 6, 2027");
  assert.match(r.text, /Booking number: 7781234\./);
  assert.match(r.text, /Sharing the cabin with Bob\./);
  assert.match(r.text, /Terms and Conditions of Travel Services, October 25, 2026/);
  assert.match(r.text, /Still to sign:/);
  assert.match(r.text, /December 6, 2026: final payment and travel plans/);
  assert.match(r.text, /January 5, 2027: final payment due/, "the real final payment date is on the list (Mark 2026-10-26)");
  assert.match(r.text, /March 4, 2027: check-in and last details/);
  // a final payment due BEFORE the 90-day message: that day is not called "final payment" any more, and the list stays in date order
  const early = fixtureInput(); early.payments.find((p) => p.id === "p2")!.due_date = "2026-11-20";
  const e = renderEmail("confirmation", ctx(early, "t1", before(120)))!.text;
  assert.match(e, /November 20, 2026: final payment due\n- December 6, 2026: travel plans/);
  assert.ok(!/final payment and travel plans/.test(e));
  const ee = renderEmail("confirmation", ctx(early, "t1", before(120), undefined, "es"))!.text;
  assert.match(ee, /vence el pago final/);
  assert.ok(!/days to go/.test(r.text), "the confirmation is about the booking, not a countdown");
  // 90 days later the early milestones are no longer listed as coming
  assert.ok(!/payments and paperwork/.test(renderEmail("confirmation", ctx(input, "t1", before(60)))!.text));
});

test("a payment notice carries one amount and one date, how to pay, and only the note Mark marked for the client", () => {
  const input = fixtureInput();
  const p = input.payments.find((x) => x.id === "p2")!;
  const r = renderEmail("payment-due", ctx(input, "t1", at("2026-12-22")), { payment: p })!;
  assert.equal(r.subject, "Payment due January 5, 2027: $2,800");
  assert.deepEqual(r.sections, ["payment", "how-to-pay"]);
  assert.match(r.text, /Final payment: \$2,800 is due on January 5, 2027 for cabin 8123\./);
  assert.match(r.text, /Payments are made directly to the cruise line/);
  assert.match(r.text, /Note on file: Pay the cruise line directly with the booking number/);
  assert.ok(!/Internal note|Legion chair/.test(r.text), "Mark's own notes stay his");
  const es = renderEmail("payment-due", ctx(input, "t3", at("2026-12-22")), { payment: input.payments.find((x) => x.id === "p4")! })!;
  assert.equal(es.subject, "Pago con vencimiento el 5 de enero de 2027: $2,200");
  assert.match(es.text, /vence el 5 de enero de 2027 para la cabina 9201/);
  // no amount or no date: nothing to say, nothing sent
  assert.equal(renderEmail("payment-due", ctx(input, "t1", at("2026-12-22")), { payment: { ...p, amount: null } }), null);
  assert.equal(renderEmail("payment-due", ctx(input, "t1", at("2026-12-22")), { payment: { ...p, due_date: null } }), null);
});

test("a change notice is Mark's text with the changed items before and after; a Spanish traveler is told it is in English unless Mark wrote Spanish", () => {
  const input = fixtureInput();
  const notice = { text: "The ship changes.\nWe will confirm the new dates.", fields: [{ label: "Ship", before: "MSC Seaside", after: "MSC Seashore" }] };
  const en = renderEmail("change-notice", ctx(input, "t1", before(100)), { notice })!;
  assert.equal(en.subject, "A change to your cruise: Post 116 Cruise");
  assert.deepEqual(en.sections, ["notice", "change"]);
  assert.match(en.text, /The ship changes\.\nWe will confirm the new dates\./);
  assert.match(en.text, /Item \| Was \| Now\nShip \| MSC Seaside \| MSC Seashore/);
  const es = renderEmail("change-notice", ctx(input, "t3", before(100)), { notice })!;
  assert.match(es.text, /El mensaje de Mark está en inglés\./);
  const es2 = renderEmail("change-notice", ctx(input, "t3", before(100)), { notice: { ...notice, text_es: "El barco cambia." } })!;
  assert.match(es2.text, /El barco cambia\./);
  assert.ok(!/El mensaje de Mark está en inglés/.test(es2.text));
  // a notice with no fields is just the text
  assert.deepEqual(renderEmail("change-notice", ctx(input, "t1", before(100)), { notice: { text: "Hello there.", fields: [] } })!.sections, ["notice"]);
});

test("a missing-details message lists what is still missing, and is not written when nothing is", () => {
  const input = fixtureInput();
  const r = renderEmail("data-needed", ctx(input, "t1", before(80)))!;
  assert.equal(r.subject, "A few details we still need for your MSC Seaside cruise");
  assert.deepEqual(r.sections, ["missing"]);
  assert.match(r.text, /Paperwork: 4 documents still to sign/);
  assert.match(r.text, /How you are getting home/);
  assert.ok(!/How you are getting to the port/.test(r.text), "Ann's flight in is on file");
  assert.ok(!/emergency contact/.test(r.text), "Ann's emergency contact is on file");
  const done = fixtureInput(); done.travelers[0]!.form_data = { journey: { getting_there: "driving" } };
  done.signatures = ["15-emergency-contact-form", "01-terms-and-conditions", "05-liability-waiver", "07-travel-insurance-declination", "16-passport-document-checklist", "12-cruise-booking-agreement"].map((k) => ({ traveler_id: "t1", doc_key: k, signer_role: "traveler", signed_at: "2026-11-01T00:00:00Z" }));
  assert.equal(renderEmail("data-needed", ctx(done, "t1", before(80))), null);
});

// ── sections are left out when the file lacks the data ───────────────────────

test("a section the file cannot support is left out, not printed blank", () => {
  const bare = fixtureInput({ group: { terms: {}, itinerary: [], embark_port: null, names_due: null, final_payment_due: null, deposit_due: null, nights: null, return_date: null, cruise_line: null } });
  bare.payments = []; bare.travel = []; bare.checklist = [];
  const c = (n: number, id = "t1") => ctx(bare, id, before(n), { videos: [], rating: null, shipInfo: null, storm: null, weather: null });
  assert.deepEqual(renderEmail("t-120", c(120))!.sections, ["sailing", "paperwork", "passport", "insurance"]);
  assert.deepEqual(renderEmail("t-90", c(90))!.sections, ["sailing", "travel"]);   // nothing on file: one list, what is needed
  assert.deepEqual(renderEmail("t-45", c(45))!.sections, ["sailing", "dining", "missing"]);
  assert.deepEqual(renderEmail("t-20", c(20))!.sections, ["sailing", "checkin", "documents", "packing"]);
  assert.deepEqual(renderEmail("t-10", c(10))!.sections, ["sailing", "ship", "embark"]);
  assert.deepEqual(renderEmail("t-5", c(5))!.sections, ["sailing"]);
  assert.deepEqual(renderEmail("t-2", c(2))!.sections, ["sailing", "boarding", "documents", "emergency"]);
  // no terms: the web check-in line is the line's own to name, so only the general pointer remains
  assert.match(renderEmail("t-20", c(20))!.text, /The line sets the dates, and they appear on your booking\./);
  // an unpublished rating never shows
  const draft = { ...fullExtras(), rating: { ...fullExtras().rating, status: "draft" } };
  assert.ok(!/Conga Line/.test(renderEmail("t-10", ctx(fixtureInput(), "t1", before(10), draft))!.text));
  const unapproved = { ...fullExtras(), rating: { ...fullExtras().rating, comment_status: "draft" } };
  const t10 = renderEmail("t-10", ctx(fixtureInput(), "t1", before(10), unapproved))!.text;
  assert.match(t10, /Conga Line score for MSC Seaside: 4\.2/);
  assert.ok(!/buffet queue|Cruisers like the layout/.test(t10), "words Mark has not approved are not shown");
});

test("the insurance line stays quiet for a traveler whose cabin declined, and confirms one that accepted", () => {
  const input = fixtureInput();
  input.cabins.find((c) => c.id === "c1")!.insurance = "declined";
  assert.ok(!renderEmail("t-120", ctx(input, "t1", before(120)))!.sections.includes("insurance"));
  assert.match(renderEmail("t-120", ctx(input, "t3", before(120), fullExtras(), "en"))!.text, /Travel insurance is on file for your cabin as accepted\./);
});

test("the passport line is careful: general guidance, and a warning only when the file's own expiry date calls for one", () => {
  const input = fixtureInput();
  const text = (exp: string | null) => { input.travelers.find((t) => t.id === "t1")!.passport_expiry = exp; return renderEmail("t-120", ctx(input, "t1", before(120)))!.text; };
  assert.match(text(null), /Check with the cruise line and your government's travel website/);
  assert.ok(!/expires/.test(text(null)));
  assert.match(text("2027-03-10"), /expires March 10, 2027, before your cruise ends\. Please check with the cruise line and renew it if you need to\./);
  assert.match(text("2027-07-01"), /less than six months after you return/);
  assert.match(text("2029-01-01"), /expires January 1, 2029\./);
  assert.ok(!/entitled|guarantee|you must have/i.test(text(null)), "explain, never promise an entitlement");
});

test("videos: Mark's own channel only, the right language, long-form first, nothing when the scan is empty", () => {
  const input = fixtureInput();
  const r = renderEmail("t-2", ctx(input, "t1", before(2)))!;
  assert.ok(!/youtube\.com\/watch\?v=BBBBBBBBBB/.test(r.text), "an English traveler is not sent the Spanish upload");
  const es = renderEmail("t-2", ctx(input, "t3", before(2)))!;
  assert.match(es.text, /Día de embarque: qué esperar en su primer crucero \(https:\/\/www\.youtube\.com\/watch\?v=BBBBBBBBBB2\)/);
  assert.ok(!/Embarkation Day Step by Step/.test(es.text));
  // a Spanish traveler with only English uploads on the topic gets them, marked
  const onlyEn = { ...fullExtras(), videos: VIDEOS.filter((v) => !/^B/.test(v.id)) };
  assert.match(renderEmail("t-2", ctx(input, "t3", before(2), onlyEn))!.text, /Embarkation Day Step by Step \(en inglés\)/);
  // another source allowed in the setting is still not built: it adds nothing
  const other = ctxFor(input, "t1", { now: before(2), token: TOKEN, site: SITE, extras: fullExtras(), videoSources: ["UCsomeoneelse"] })!;
  assert.ok(!renderEmail("t-2", other)!.sections.includes("videos"));
  assert.ok(!renderEmail("t-2", ctx(input, "t1", before(2), { ...fullExtras(), videos: [] }))!.sections.includes("videos"));
  // a Short is never chosen over a long video on the same topic
  const seaDay = ctx(input, "t1", before(10), { ...fullExtras(), videos: [VIDEOS[6]!] });
  assert.ok(!renderEmail("t-10", seaDay)!.sections.includes("videos"), "no topic match, no video");
});

test("videos: a title that names a cruise line or a ship is shown only to a group on that line or ship; a line-neutral topic video fits everyone; nothing that fits, no section", () => {
  const v = (id: string, title: string, views = 1000) => ({ id, title, views, published: "2026-01-01T00:00:00Z", lang: "en" as const });
  const NCL = v("NNNNNNNNN01", "Norwegian Bliss Cabin Tour: Balcony vs Mini-Suite", 90000);
  const MSC = v("MMMMMMMMM01", "MSC Seaside Balcony Cabin Tour", 2000);
  const ROYAL = v("RRRRRRRRR01", "Wonder of the Seas Cabin Tour", 80000);
  const MARDI = v("CCCCCCCCC01", "Mardi Gras Cabin Tour: Is the Balcony Worth It?", 70000);
  const BOTH = v("BBBBBBBBB01", "MSC vs Norwegian: Which Cabin Is Better?", 60000);
  const NEUTRAL = v("NEUTRALCAB1", "Cruise Cabin Types Explained: Inside, Ocean View, Balcony", 3000);
  const fleet = [{ ship: "Mardi Gras", line: "Carnival Cruise Line" }, { ship: "Joy", line: "Carnival Cruise Line" }, { ship: "Wonder of the Seas", line: "Royal Caribbean International" }];
  const all = [NCL, MSC, ROYAL, MARDI, BOTH, NEUTRAL];
  const ids = (group: Row) => pickVideos(all, "cabin", "en", ["own"], 9, videoFitOf(group, fleet)).map((x) => x.id);

  // an MSC group (MSC Seaside / MSC Cruises, as the file prints them) gets its own line's video and the neutral one, never the NCL, Royal or Carnival tours
  assert.deepEqual(ids({ cruise_line: "MSC Cruises", ship_name: "MSC SEASIDE" }).sort(), [MSC.id, NEUTRAL.id].sort());
  assert.deepEqual(ids({ cruise_line: "MSC CRUISES", ship_name: "MSC SEASHORE" }).sort(), [MSC.id, NEUTRAL.id].sort(), "another MSC ship still gets an MSC line video");
  // an NCL group gets the NCL tour; a Carnival group gets the Carnival hull's tour (named without its line); nobody gets the video that names two lines
  assert.deepEqual(ids({ cruise_line: "Norwegian Cruise Line", ship_name: "Norwegian Bliss" }).sort(), [NCL.id, NEUTRAL.id].sort());
  assert.deepEqual(ids({ cruise_line: "Carnival Cruise Line", ship_name: "Mardi Gras" }).sort(), [MARDI.id, NEUTRAL.id].sort());
  assert.deepEqual(ids({ cruise_line: "Royal Caribbean International", ship_name: "Wonder of the Seas" }).sort(), [NEUTRAL.id, ROYAL.id].sort());
  // a group whose line cannot be read is shown only the line-neutral videos
  assert.deepEqual(ids({ cruise_line: "", ship_name: "" }), [NEUTRAL.id]);
  assert.deepEqual(ids({ cruise_line: "Some Small Line", ship_name: "Nobody" }), [NEUTRAL.id]);
  // the group's own ship named in a title is a match even when the line is not on the file; "Virgin Islands" is a place, not a line; "Joy" alone is not a ship
  assert.equal(videoFitsGroup("Mardi Gras Cabin Tour", { line: null, ship: "Mardi Gras" }), true);
  assert.equal(videoFitsGroup("A Week in the US Virgin Islands: What to Pack", { line: "MSC Cruises", ship: "MSC Seaside" }), true);
  assert.equal(videoFitsGroup("The Joy of Your First Cruise", { line: "MSC Cruises", ship: "MSC Seaside", fleet }), true);
  assert.equal(videoFitsGroup("Virgin Voyages Cabin Tour", { line: "MSC Cruises", ship: "MSC Seaside" }), false);
  assert.equal(videoFitsGroup("Princess Cruises Cabin Tour", { line: "MSC Cruises", ship: "MSC Seaside" }), false);
  assert.equal(videoFitsGroup("Celebrity Edge Cabin Tour", { line: "MSC Cruises", ship: "MSC Seaside" }), false);
  assert.equal(videoFitsGroup("Holland America Cabin Tour", { line: "MSC Cruises", ship: "MSC Seaside" }), false);
  assert.equal(videoFitsGroup("Disney Cruise Line Cabin Tour", { line: "MSC Cruises", ship: "MSC Seaside" }), false);
  assert.equal(videoFitsGroup("Margaritaville at Sea Cabin Tour", { line: "MSC Cruises", ship: "MSC Seaside" }), false);

  // in the messages: the NCL tour that used to show for an MSC Seashore group is gone from the 10-day email, the cruise page and the insurance box
  const input = fixtureInput({ group: { ship_name: "MSC SEASHORE", cruise_line: "MSC CRUISES" } });
  const ncl = { ...fullExtras(), videos: [NCL], fleet };
  const ten = renderEmail("t-10", ctx(input, "t1", before(10), ncl))!;
  assert.ok(!/NNNNNNNNN01|Norwegian Bliss/.test(ten.text + ten.html), "the NCL cabin tour is not in the 10-day email");
  assert.ok(!ten.sections.includes("videos"));
  const hub = renderHub(ctx(input, "t1", before(10), ncl));
  assert.ok(!JSON.stringify(hub).includes("NNNNNNNNN01"), "the NCL cabin tour is not on the cruise page");
  assert.ok(!hub.sections.some((x) => x.key === "videos"), "nothing fits: the videos section is omitted");
  const insurance = ctx(input, "t3", before(120), { ...fullExtras(), videos: [v("IIIIIIIII01", "Norwegian Cruise Line Travel Insurance: Is It Worth It?")], fleet });
  assert.ok(!renderEmail("t-120", insurance)!.text.includes("IIIIIIIII01"));
  // the same video does reach an NCL group
  const nclInput = fixtureInput({ group: { ship_name: "NORWEGIAN BLISS", cruise_line: "Norwegian Cruise Line" } });
  assert.match(renderEmail("t-10", ctx(nclInput, "t1", before(10), { ...fullExtras(), videos: [v("NNNNNNNNN02", "Norwegian Bliss Embarkation Day, Start to Finish")], fleet }))!.text, /Norwegian Bliss Embarkation Day, Start to Finish \(https:\/\/www\.youtube\.com\/watch\?v=NNNNNNNNN02\)/);
});

test("no message carries a link that is not http(s) and every link goes to our site, YouTube or a row Mark entered", () => {
  const input = fixtureInput();
  input.checklist[0]!.link_url = "javascript:alert(1)";
  for (const n of [120, 90, 45, 20, 10, 5, 2]) {
    const r = renderEmail(dayKind(n), ctx(input, "t1", before(n)))!;
    assert.ok(!/href="javascript:/i.test(r.html), `${n}: a script link`);
    for (const m of r.html.matchAll(/href="([^"]+)"/g)) assert.match(m[1]!, /^(https?:\/\/|#)/, `${n}: ${m[1]}`);
    assert.ok(!/<script/i.test(r.html));
  }
});

test("the insurance box on the cruise page says 'Call or text Mark at 919-346-6127' with a link that dials; the email keeps 'reply to this email'", () => {
  const input = fixtureInput();
  const sec = (lang: "en" | "es", id = "t1") => renderHub(ctx(input, id, before(100), fullExtras(), lang)).sections.find((x) => x.key === "insurance")!;
  const en = sec("en");
  assert.ok(!/reply|this email/i.test(en.lines.join(" ")), "a web page has no email to reply to");
  assert.match(en.lines.join(" "), /Travel insurance is optional\. Mark offers Allianz plans\./);
  assert.deepEqual(en.links, [{ label: "Call or text Mark at 919-346-6127", url: "tel:+19193466127" }]);
  const es = sec("es");
  assert.ok(!/correo|responda/i.test(es.lines.join(" ")));
  assert.deepEqual(es.links, [{ label: "Llame o envíe un mensaje de texto a Mark al 919-346-6127", url: "tel:+19193466127" }]);
  // a cabin that already has insurance, and one that declined it, get no call to action
  assert.equal(sec("en", "t3").links, undefined);
  const declined = fixtureInput(); declined.cabins[0]!.insurance = "declined";
  assert.ok(!renderHub(ctx(declined, "t1", before(100))).sections.some((x) => x.key === "insurance"));
  // the email is unchanged: it can be replied to
  const mail = renderEmail("t-120", ctx(input, "t1", before(120)))!;
  assert.match(mail.text, /Reply to this email or call 919-346-6127 if you would like a quote/);
  assert.ok(!mail.html.includes("tel:"));
  // the page's script lets a tel: link through and nothing else odd
  const root = [path.join(process.cwd(), "public"), path.join(process.cwd(), "server", "public")].find((d) => existsSync(path.join(d, "index.html")));
  assert.ok(root, "the site's public folder");
  const js = readFileSync(path.join(root!, "js", "my-cruise.js"), "utf8");
  assert.match(js, /function safe\(u\) \{[^\n]*\^tel:/, "the cruise page's script lets a tel: link through");
  const stamp = Number((/my-cruise\.js\?v=(\d{8})/.exec(readFileSync(path.join(root!, "my-cruise.html"), "utf8")) ?? [])[1]);
  assert.ok(stamp >= 20261019, "the script's cache stamp moved with the change (and with every later one)");
});

test("text from the file is escaped in the html", () => {
  const input = fixtureInput();
  input.checklist[1]!.title = "<b>Book</b> & go";
  const r = renderEmail("t-120", ctx(input, "t1", before(120)))!;
  assert.ok(r.html.includes("&lt;b&gt;Book&lt;/b&gt; &amp; go"));
  assert.ok(!r.html.includes("<b>Book"));
});

// ── the cruise page ────────────────────────────────────────────────────────────

test("the cruise page carries every part of the journey for the traveler, in their language", () => {
  const input = fixtureInput();
  const notices = [{ sent_at: "2026-11-02T12:00:00Z", meta: { text: "The ship changes.", fields: [{ label: "Ship", before: "A", after: "B" }] } }];
  const h = renderHub(ctx(input, "t1", before(5), fullExtras({ notices })));
  assert.equal(h.lang, "en");
  assert.equal(h.hello, "Hello Ann.");
  assert.deepEqual(h.countdown, { days: 5, text: "5 days to go." });
  assert.deepEqual(h.sections.map((s) => s.key), ["notice", "sailing", "cabin", "missing", "details", "paperwork", "payments", "checklist", "travel", "travel-needed", "ship", "weather", "pack-tweaks", "embark", "documents", "passport", "insurance", "videos"]);
  assert.equal(h.sections[0]!.title, "November 2, 2026");
  assert.deepEqual(h.sections.find((s) => s.key === "cabin")!.lines, ["Your cabin: Balcony, cabin 8123, deck 8.", "Booking number: 7781234.", "Sharing the cabin with Bob."]);
  assert.equal(h.sections.find((s) => s.key === "details")!.form, "details");
  assert.equal(h.sections.find((s) => s.key === "checklist")!.checklist!.length, 5);
  assert.deepEqual(h.details.values["emergency_name"], "Sam Alpha");
  assert.equal(h.details.fields.find((f) => f.name === "getting_there")!.optionLabels!["driving"], "Driving");
  assert.equal(h.otherLang, "es");
  const es = renderHub(ctx(input, "t3", before(5), fullExtras()));
  assert.equal(es.lang, "es");
  assert.equal(es.hello, "Hola Carlos.");
  assert.equal(es.ui["save"], "Guardar");
  assert.equal(es.details.fields.find((f) => f.name === "flight_in_date")!.label, "Fecha de llegada");
  const forced = renderHub(ctx(input, "t3", before(5), fullExtras(), "en"));
  assert.equal(forced.lang, "en");
  assert.ok(!JSON.stringify(h).includes(`my-cruise.html?t=`), "on the page, the link to the form is an anchor, not a second copy of the page address");
  assert.ok(!/passport_enc|form_token_hash|hub_token_hash/.test(JSON.stringify(h)));
});

test("the cruise page leaves out the weather outside the forecast horizon and shows a done checklist as done", () => {
  const input = fixtureInput();
  const far = renderHub(ctx(input, "t1", before(60), { ...fullExtras(), weather: null }));
  assert.ok(!far.sections.some((s) => s.key === "weather"));
  input.travelers.find((t) => t.id === "t1")!.form_data = withChecklistTick({}, "k1", true, new Date("2026-11-01T00:00:00Z"));
  const h = renderHub(ctx(input, "t1", before(60), fullExtras()));
  const list = h.sections.find((s) => s.key === "checklist")!.checklist!;
  assert.deepEqual(list.map((e) => [e.id, e.done]).slice(0, 2), [["k1", true], ["k2", false]]);
  // a cabin-level row marked done on the file counts for the whole cabin
  input.checklist.push({ id: "k7", group_id: "g1", cabin_id: "c1", audience: "client", kind: "task", title: "Pick your dining time", due_date: null, done_at: "2026-11-02T00:00:00Z", sort: 7 });
  assert.equal(renderHub(ctx(input, "t2", before(60), fullExtras())).sections.find((s) => s.key === "checklist")!.checklist!.find((e) => e.id === "k7")!.done, true);
  assert.equal(renderHub(ctx(input, "t3", before(60), fullExtras())).sections.find((s) => s.key === "checklist")!.checklist!.some((e) => e.id === "k7"), false);
});

test("the details form takes only its own fields, checks them, refuses a card number, and needs both parts of an emergency contact", () => {
  const ok = validateDetails({
    getting_there: "flying", flight_in_flight: "AA 1234", flight_in_date: "2027-03-05", flight_in_time: "14:30", port_arrival_time: "11:00",
    emergency_name: "Sam Alpha", emergency_phone: "919-555-0100", hotel_name: "", passport_number: "X123456789", __proto__: { x: 1 },
  }, "en", looksLikeCardNumber);
  assert.deepEqual(ok, { ok: true, journey: { getting_there: "flying", flight_in_flight: "AA 1234", flight_in_date: "2027-03-05", flight_in_time: "14:30", port_arrival_time: "11:00", hotel_name: null }, emergency: { name: "Sam Alpha", phone: "919-555-0100" } });
  const bad = validateDetails({ getting_there: "teleport", flight_in_date: "2027-02-30", flight_in_time: "25:00", transfer_note: "4111 1111 1111 1111", emergency_name: "Sam", emergency_phone: "12" }, "en", looksLikeCardNumber);
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.deepEqual(Object.keys(bad.errors).sort(), ["emergency_phone", "flight_in_date", "flight_in_time", "getting_there", "transfer_note"]);
    assert.match(bad.errors["transfer_note"]!, /Card numbers are never collected here/);
  }
  const half = validateDetails({ emergency_name: "Sam" }, "es", looksLikeCardNumber);
  assert.deepEqual(half, { ok: false, errors: { emergency_phone: "Indique el teléfono del contacto de emergencia." } });
  assert.equal(validateDetails({ flight_in_flight: "x".repeat(81) }, "en", looksLikeCardNumber).ok, false);
  assert.deepEqual(validateDetails(null, "en", looksLikeCardNumber), { ok: true, journey: {}, emergency: null });
  // the merge replaces only the form's keys, drops blanks, and leaves the signed answers alone
  const merged = mergeJourneyAnswers({ address: { city: "Raleigh" }, journey: { hotel_name: "Old", getting_there: "flying" } }, { hotel_name: null, flight_in_flight: "AA 1" }, new Date("2026-11-01T00:00:00Z"));
  assert.deepEqual(merged, { address: { city: "Raleigh" }, journey: { getting_there: "flying", flight_in_flight: "AA 1", updated_at: "2026-11-01T00:00:00.000Z" } });
});

test("the cruise page's tick is kept per traveler and can be taken back", () => {
  const a = withChecklistTick({ journey: { getting_there: "flying" } }, "k1", true, new Date("2026-11-01T00:00:00Z"));
  assert.deepEqual(a, { journey: { getting_there: "flying", checklist_done: { k1: "2026-11-01T00:00:00.000Z" } } });
  assert.deepEqual(withChecklistTick(a, "k1", false, new Date())["journey"]["checklist_done"], {});
});

// ── odds and ends the whole thing leans on ────────────────────────────────────

test("every page of our own site the journey links to exists, in both languages", () => {
  const root = [path.join(process.cwd(), "public"), path.join(process.cwd(), "server", "public")].find((d) => existsSync(path.join(d, "index.html")));
  assert.ok(root, "server/public not found from the test's working directory");
  for (const [name, p] of Object.entries(SITE_PAGES)) for (const lang of ["en", "es"] as const) assert.ok(existsSync(path.join(root!, p[lang])), `${name} (${lang}): ${p[lang]} is not a page of the site`);
});

test("'today' is the business's calendar day, not the server's", () => {
  assert.equal(localToday(new Date("2027-03-01T03:30:00Z"), "America/New_York"), "2027-02-28");
  assert.equal(localToday(new Date("2027-03-01T15:00:00Z"), "America/New_York"), "2027-03-01");
  assert.equal(localToday(new Date("2027-03-01T03:30:00Z"), "UTC"), "2027-03-01");
  assert.equal(ymd("2027-02-30"), null);
  assert.equal(ymd("2027-03-01T10:00:00Z"), "2027-03-01");
  assert.equal(dayDiff("2027-02-27", "2027-03-02"), 3);
});
