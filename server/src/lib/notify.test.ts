// notify.test.ts — the email floor is a floor for FAULTS, not a fallback for
// everything.
//
// Context (2026-08-26): platform_state's push-subscriptions held ZERO devices, so
// all 14 notifyMark() call sites were delivering nothing and returning "none" to
// nobody. The fix adds an email tier — but ungated, that tier turns 14 routine
// "a draft is ready" nudges into 14 emails a day, which is precisely the noise
// Telegram was retired for. These tests pin the gate.

import { test, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import { notifyMark } from "./notify";

// ntfy is not deployed; make sure the env can't make these tests lie.
beforeEach(() => {
  delete process.env["NTFY_URL"];
  delete process.env["NTFY_TOPIC"];
});

const NO_DEVICES = async () => ({ sent: 0, pruned: 0 });
const ONE_DEVICE = async () => ({ sent: 1, pruned: 0 });

function mailSpy() {
  const calls: unknown[] = [];
  return {
    calls,
    fn: async (opts: unknown) => {
      calls.push(opts);
      return true;
    },
  };
}

test("a normal nudge that reaches no device does NOT email", async () => {
  const mail = mailSpy();
  const channel = await notifyMark(
    { title: "📱 3 social draft(s) ready", body: "Open the brief." },
    { push: NO_DEVICES, mail: mail.fn },
  );

  assert.equal(channel, "none");
  assert.equal(mail.calls.length, 0, "a routine review nudge must never reach email");
});

test("priority:'normal' is explicit-equivalent to the default", async () => {
  const mail = mailSpy();
  const channel = await notifyMark(
    { title: "📨 Newsletter draft ready", body: "b", priority: "normal" },
    { push: NO_DEVICES, mail: mail.fn },
  );

  assert.equal(channel, "none");
  assert.equal(mail.calls.length, 0);
});

test("a high-priority fault that reaches no device DOES email", async () => {
  const mail = mailSpy();
  const channel = await notifyMark(
    { title: "🔕 Push notifications are reaching nobody", body: "Re-subscribe.", priority: "high" },
    { push: NO_DEVICES, mail: mail.fn },
  );

  assert.equal(channel, "email");
  assert.equal(mail.calls.length, 1);
  const sent = mail.calls[0] as { subject: string; text: string };
  assert.match(sent.subject, /reaching nobody/);
  assert.match(sent.text, /Re-subscribe\./);
});

test("email is a FLOOR, not a duplicate — a delivered push never also emails", async () => {
  const mail = mailSpy();
  const channel = await notifyMark(
    { title: "🔕 fault", body: "b", priority: "high" },
    { push: ONE_DEVICE, mail: mail.fn },
  );

  assert.equal(channel, "webpush");
  assert.equal(mail.calls.length, 0, "push succeeded; email would be a second copy");
});

test("a thrown push still falls through to email for a fault", async () => {
  const mail = mailSpy();
  const channel = await notifyMark(
    { title: "🔕 fault", body: "b", priority: "high" },
    {
      push: async () => {
        throw new Error("web-push exploded");
      },
      mail: mail.fn,
    },
  );

  assert.equal(channel, "email");
  assert.equal(mail.calls.length, 1);
});

test("notifyMark never throws, even when every tier throws", async () => {
  const channel = await notifyMark(
    { title: "🔕 fault", body: "b", priority: "high" },
    {
      push: async () => {
        throw new Error("push down");
      },
      mail: async () => {
        throw new Error("mail down");
      },
    },
  );

  assert.equal(channel, "none");
});
