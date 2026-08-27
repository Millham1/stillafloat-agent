// push-health.test.ts — a notification channel with no listeners must announce
// itself.
//
// The 2026-08-26 finding: push-subscriptions held zero devices and had for an
// unknown stretch. sendPush correctly prunes subscriptions that 403 under a
// rotated VAPID keypair — but pruning the LAST device left the system unable to
// reach Mark and unable to say so. These tests pin the announcement.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { checkPushHealth } from "./push-health";

type RaiseArgs = { title: string; body?: string; source_ref?: string; priority?: string };

function raiseSpy(created = true) {
  const calls: RaiseArgs[] = [];
  return {
    calls,
    fn: (async (a: RaiseArgs) => {
      calls.push(a);
      return { created, id: "act-1" };
    }) as never,
  };
}

const VAPID_SET = () => "BFDB7HTn-public-key";
const NO_NTFY = () => false;

test("zero devices raises a high-priority action", async () => {
  const raise = raiseSpy();
  const out = await checkPushHealth({
    count: async () => 0,
    vapid: VAPID_SET,
    ntfyLive: NO_NTFY,
    raise: raise.fn,
  });

  assert.equal(out.devices, 0);
  assert.equal(out.raised, true);
  assert.equal(raise.calls.length, 1);
  // high is what unlocks the email floor — without it this fault is as silent
  // as the one it exists to report.
  assert.equal(raise.calls[0]!.priority, "high");
});

test("the raised action tells Mark how to fix it", async () => {
  const raise = raiseSpy();
  await checkPushHealth({
    count: async () => 0,
    vapid: VAPID_SET,
    ntfyLive: NO_NTFY,
    raise: raise.fn,
  });

  assert.match(raise.calls[0]!.body!, /Alerts/, "must name where to re-subscribe");
});

test("a healthy channel raises nothing", async () => {
  const raise = raiseSpy();
  const out = await checkPushHealth({
    count: async () => 2,
    vapid: VAPID_SET,
    ntfyLive: NO_NTFY,
    raise: raise.fn,
  });

  assert.equal(out.devices, 2);
  assert.equal(out.raised, false);
  assert.equal(raise.calls.length, 0);
});

test("missing VAPID keys change the remedy, not the alarm", async () => {
  const raise = raiseSpy();
  const out = await checkPushHealth({
    count: async () => 0,
    vapid: () => null,
    ntfyLive: NO_NTFY,
    raise: raise.fn,
  });

  assert.equal(out.vapidConfigured, false);
  assert.equal(raise.calls.length, 1);
  assert.match(raise.calls[0]!.body!, /VAPID_PUBLIC_KEY/);
});

test("zero devices is not a fault when ntfy is configured", async () => {
  const raise = raiseSpy();
  const out = await checkPushHealth({
    count: async () => 0,
    vapid: VAPID_SET,
    ntfyLive: () => true,
    raise: raise.fn,
  });

  assert.equal(out.raised, false);
  assert.equal(raise.calls.length, 0, "ntfy is an independent path — not an outage");
});

test("a deduped (already pending) action reports raised:false", async () => {
  const raise = raiseSpy(false); // createAction dedups on (type, source_ref)
  const out = await checkPushHealth({
    count: async () => 0,
    vapid: VAPID_SET,
    ntfyLive: NO_NTFY,
    raise: raise.fn,
  });

  assert.equal(out.raised, false, "one open fault, not a daily drip");
  assert.equal(raise.calls.length, 1);
});

test("the check never throws when its dependencies do", async () => {
  const out = await checkPushHealth({
    count: async () => {
      throw new Error("supabase down");
    },
    vapid: VAPID_SET,
    ntfyLive: NO_NTFY,
    raise: raiseSpy().fn,
  });

  assert.equal(out.raised, false);
});
