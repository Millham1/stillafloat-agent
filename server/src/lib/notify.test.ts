// notify.test.ts — two shapes on the phone, everything else on the page.
//
// Mark, 2026-10-22: 12 pushes in a day from four agents in eight title styles, "none of them
// tie to each other". These tests pin the decision: a "waiting" call never pushes its own
// words (the live list does, and only when something new joined it); "headsup" and "fault"
// carry fixed prefixes and tags; "activity" never buzzes; and the email floor stays a floor
// for faults and leads only (2026-08-26 / 2026-10-07).

import { test, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import {
  notifyMark, notifyMarkDetailed, shapeNotification, resolveKind, plainTitle,
  WAITING_TAG, HEADSUP_TAG, FAULT_TAG,
} from "./notify";

beforeEach(() => {
  delete process.env["NTFY_URL"];
  delete process.env["NTFY_TOPIC"];
  delete process.env["DISABLE_NOTIFY_EMAIL"];
});

const NO_DEVICES = async () => ({ sent: 0, pruned: 0 });
const ONE_DEVICE = async () => ({ sent: 1, pruned: 0 });
const NO_LOG = async () => true;

function spy<T>() {
  const calls: T[] = [];
  // Typed loosely on purpose: the seams take MailOpts / ActivityItem; the tests read back only
  // the fields they assert on.
  return { calls, fn: async (x: unknown) => { calls.push(x as T); return true; } };
}
function pushSpy(sent: number) {
  const calls: Array<{ title: string; body: string; url: string; tag?: string }> = [];
  return { calls, fn: async (p: { title: string; body: string; url: string; tag?: string }) => { calls.push(p); return { sent, pruned: 0 }; } };
}
const waitingResult = (pushed: boolean, sent: number) => async () =>
  ({ pushed, sent, pruned: 0, total: 3, added: pushed ? 1 : 0, title: "Waiting on you: 3", body: "x" });

// ── shapes ───────────────────────────────────────────────────────────────────
test("headsup: fixed prefix, fixed tag, caller's emoji dropped", () => {
  const s = shapeNotification({ kind: "headsup", title: "⏰ Meeting in ~62 min", body: "One Source webinar at 11:30" });
  assert.equal(s.title, "Heads-up: Meeting in ~62 min");
  assert.equal(s.tag, HEADSUP_TAG);
  assert.equal(s.pushes, true);
  assert.equal(s.priority, "normal");
});

test("fault: Heads-up prefix with the warning mark, its own tag, email-floor priority", () => {
  const s = shapeNotification({ kind: "fault", title: "⚠️ AI unreachable", body: "Triage degraded." });
  assert.equal(s.title, "Heads-up: ⚠️ AI unreachable");
  assert.equal(s.tag, FAULT_TAG);
  assert.notEqual(s.tag, HEADSUP_TAG, "a meeting reminder must never replace a fault on the phone");
  assert.equal(s.priority, "high");
});

test("waiting: always the brief, always the one tag", () => {
  const s = shapeNotification({ kind: "waiting", title: "📰 2 stories ready for review", body: "b", url: "https://x/review" });
  assert.equal(s.tag, WAITING_TAG);
  assert.match(s.url, /brief\.html$/);
});

test("activity: never pushes", () => {
  assert.equal(shapeNotification({ kind: "activity", title: "🧹 cleared 12 promo emails", body: "" }).pushes, false);
});

test("plainTitle strips a leading emoji run and a prefix we add ourselves", () => {
  assert.equal(plainTitle("⚠️ ⚠️ Drift detected"), "Drift detected");
  assert.equal(plainTitle("Heads-up: Meeting"), "Meeting");
  assert.equal(plainTitle("🟡 YouTube optimizer completed DEGRADED"), "YouTube optimizer completed DEGRADED");
  assert.equal(plainTitle(""), "Still Afloat");
});

test("resolveKind: an explicit kind wins; old callers keep their meaning; the rest is activity", () => {
  assert.equal(resolveKind("headsup", "editorial-digest"), "headsup");
  assert.equal(resolveKind(undefined, "editorial-digest"), "waiting", "the news nudge deployed before this change still asks for a decision");
  assert.equal(resolveKind(undefined, "editorial-scan-fault"), "fault");
  assert.equal(resolveKind(undefined, "ops-alert"), "activity", "the ops-manager's catch-all tag stops pushing");
  assert.equal(resolveKind("bogus", undefined), "activity");
});

// ── behaviour ────────────────────────────────────────────────────────────────
test("activity is recorded and never reaches push or mail", async () => {
  const push = pushSpy(1); const mail = spy<unknown>(); const log = spy<{ title: string; pushed: boolean; level: string }>();
  const channel = await notifyMark(
    { kind: "activity", source: "ops", title: "🗓️ Event added", body: "Princess webinar" },
    { push: push.fn, mail: mail.fn, activity: log.fn },
  );
  assert.equal(channel, "activity");
  assert.equal(push.calls.length, 0);
  assert.equal(mail.calls.length, 0);
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0]!.pushed, false);
  assert.equal(log.calls[0]!.title, "Event added");
});

test("headsup pushes the shaped title and is also recorded on the page", async () => {
  const push = pushSpy(1); const log = spy<{ title: string; pushed: boolean }>();
  const channel = await notifyMark(
    { kind: "headsup", source: "calendar", title: "⏰ Meeting in ~60 min", body: "at 11:30" },
    { push: push.fn, mail: spy<unknown>().fn, activity: log.fn },
  );
  assert.equal(channel, "webpush");
  assert.equal(push.calls[0]!.title, "Heads-up: Meeting in ~60 min");
  assert.equal(push.calls[0]!.tag, HEADSUP_TAG);
  assert.equal(log.calls[0]!.pushed, true);
});

test("a heads-up that reaches no device does NOT email (not a fault, not a lead)", async () => {
  const mail = spy<unknown>();
  const channel = await notifyMark(
    { kind: "headsup", title: "Meeting in ~60 min", body: "b" },
    { push: NO_DEVICES, mail: mail.fn, activity: NO_LOG },
  );
  assert.equal(channel, "none");
  assert.equal(mail.calls.length, 0);
});

test("a fault that reaches no device DOES email, with the caller's own subject", async () => {
  const mail = spy<{ subject: string; text: string; fromName: string }>();
  const channel = await notifyMark(
    { kind: "fault", title: "🔕 Push notifications are reaching nobody", body: "Re-subscribe." },
    { push: NO_DEVICES, mail: mail.fn, activity: NO_LOG },
  );
  assert.equal(channel, "email");
  assert.match(mail.calls[0]!.subject, /reaching nobody/);
  assert.match(mail.calls[0]!.text, /Re-subscribe\./);
  assert.equal(mail.calls[0]!.fromName, "Still Afloat Ops");
});

test("email is a FLOOR, not a duplicate — a delivered fault never also emails", async () => {
  const mail = spy<unknown>();
  const channel = await notifyMark({ kind: "fault", title: "fault", body: "b" }, { push: ONE_DEVICE, mail: mail.fn, activity: NO_LOG });
  assert.equal(channel, "webpush");
  assert.equal(mail.calls.length, 0);
});

test("a thrown push still falls through to email for a fault; never throws even when mail dies too", async () => {
  const mail = spy<unknown>();
  const boom = async () => { throw new Error("web-push exploded"); };
  assert.equal(await notifyMark({ kind: "fault", title: "f", body: "b" }, { push: boom, mail: mail.fn, activity: NO_LOG }), "email");
  assert.equal(await notifyMark({ kind: "fault", title: "f", body: "b" }, { push: boom, mail: async () => { throw new Error("mail down"); }, activity: NO_LOG }), "none");
});

test("waiting: the caller's words are NOT pushed — the handler composes the list", async () => {
  const push = pushSpy(1); const handler = spy<string>();
  const out = await notifyMarkDetailed(
    { kind: "waiting", source: "news", title: "📰 2 stories ready for review", body: "1. A\n2. B" },
    { push: push.fn, mail: spy<unknown>().fn, activity: NO_LOG, waiting: async (reason) => { await handler.fn(reason); return (await waitingResult(true, 1)()); } },
  );
  assert.equal(out.channel, "webpush");
  assert.equal(push.calls.length, 0, "notify itself must not push for a waiting trigger");
  assert.equal(handler.calls.length, 1);
  assert.equal(out.waiting?.total, 3);
});

test("waiting: nothing new in the list → quiet, no push, no mail", async () => {
  const mail = spy<unknown>();
  const out = await notifyMarkDetailed(
    { kind: "waiting", title: "📱 3 social drafts ready", body: "b" },
    { push: pushSpy(1).fn, mail: mail.fn, activity: NO_LOG, waiting: waitingResult(false, 0) },
  );
  assert.equal(out.channel, "quiet");
  assert.equal(mail.calls.length, 0);
});

test("waiting: a routine review that reaches no device does NOT email", async () => {
  const mail = spy<unknown>();
  const channel = await notifyMark(
    { kind: "waiting", title: "📨 Newsletter draft ready", body: "b", priority: "normal" },
    { push: NO_DEVICES, mail: mail.fn, activity: NO_LOG, waiting: waitingResult(true, 0) },
  );
  assert.equal(channel, "none");
  assert.equal(mail.calls.length, 0, "a review nudge that lands nowhere is a channel fault, not an email");
});

test("waiting: a customer lead that reaches no device DOES email (Mark, 2026-10-07)", async () => {
  const mail = spy<{ subject: string; fromName: string }>();
  const channel = await notifyMark(
    { kind: "waiting", title: "Group reply: Pat Doe", body: "MSC Seaside — 2 guest(s). Reply within a few hours.", priority: "lead" },
    { push: NO_DEVICES, mail: mail.fn, activity: NO_LOG, waiting: waitingResult(true, 0) },
  );
  assert.equal(channel, "email");
  assert.match(mail.calls[0]!.subject, /Group reply: Pat Doe/);
  assert.equal(mail.calls[0]!.fromName, "Still Afloat Leads");
});

test("waiting: with no handler registered the raw text is pushed under the waiting tag, never dropped", async () => {
  const push = pushSpy(1);
  const channel = await notifyMark({ kind: "waiting", title: "📰 2 stories ready", body: "b" }, { push: push.fn, mail: spy<unknown>().fn, activity: NO_LOG });
  assert.equal(channel, "webpush");
  assert.equal(push.calls[0]!.tag, WAITING_TAG);
  assert.match(push.calls[0]!.title, /^Waiting on you: 2 stories ready/);
});

// Dev box (Mark, 2026-10-12): no phone is subscribed to dev, so without this every fault
// mailed his real inbox a daily false alarm.
test("DISABLE_NOTIFY_EMAIL=1 stops the email floor for faults and leads, push still works", async () => {
  process.env["DISABLE_NOTIFY_EMAIL"] = "1";
  const mail = spy<unknown>();
  assert.equal(await notifyMark({ kind: "fault", title: "reaching nobody", body: "dev" }, { push: NO_DEVICES, mail: mail.fn, activity: NO_LOG }), "none");
  assert.equal(await notifyMark({ kind: "waiting", title: "lead", body: "dev", priority: "lead" }, { push: NO_DEVICES, mail: mail.fn, activity: NO_LOG, waiting: waitingResult(true, 0) }), "none");
  assert.equal(mail.calls.length, 0);
  assert.equal(await notifyMark({ kind: "fault", title: "t", body: "b" }, { push: ONE_DEVICE, mail: mail.fn, activity: NO_LOG }), "webpush");
});
