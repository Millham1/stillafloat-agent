// subscriber-hygiene.test.ts — the bounced-row purge.
//
// Mark, 2026-08-26: "the bounces were subscription confirmations that bounced on
// false emails ... i need a way to move them out of the DB."
//
// The bounce-scanner has been setting status='bounced' / bounced_at since it
// shipped. Nothing ever removed those rows, so they accumulated indefinitely.
// These tests pin the query shape, because the danger here is not that the purge
// fails — it is that it deletes something it shouldn't. Deletion is the one
// operation in this file that cannot be undone.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildPurgeQuery, PURGE_BOUNCED_AFTER_DAYS, remindPending, type PendingRow } from "./subscriber-hygiene";
import { createSendCap } from "./verification-send-cap";

/** Records every filter applied, so the test can assert on the whole query. */
function fakeTable() {
  const calls: { op: string; args: unknown[] }[] = [];
  const q: Record<string, unknown> = {};
  for (const op of ["delete", "eq", "lte", "select", "update", "is", "neq"]) {
    q[op] = (...args: unknown[]) => {
      calls.push({ op, args });
      return q;
    };
  }
  return { q, calls };
}

const NOW = Date.parse("2026-08-27T00:00:00Z");

test("the purge only ever deletes status='bounced'", () => {
  const { q, calls } = fakeTable();

  buildPurgeQuery(q as never, NOW);

  const eq = calls.find((c) => c.op === "eq");
  assert.ok(eq, "must filter on a status");
  assert.deepEqual(eq!.args, ["status", "bounced"]);
});

test("it is a delete, not an update", () => {
  const { q, calls } = fakeTable();

  buildPurgeQuery(q as never, NOW);

  assert.ok(calls.some((c) => c.op === "delete"));
  assert.ok(!calls.some((c) => c.op === "update"), "archiving is the other job");
});

test("a bounce inside the grace period is left alone", () => {
  const { q, calls } = fakeTable();

  buildPurgeQuery(q as never, NOW);

  const lte = calls.find((c) => c.op === "lte");
  assert.ok(lte, "must have a grace-period cutoff");
  assert.equal(lte!.args[0], "bounced_at");

  const cutoff = Date.parse(lte!.args[1] as string);
  const days = (NOW - cutoff) / (24 * 60 * 60 * 1000);
  assert.equal(Math.round(days), PURGE_BOUNCED_AFTER_DAYS);
});

test("the grace period is long enough for a transient bounce to recover", () => {
  // Mailbox-full and greylisting both produce a DSN and both resolve on their own.
  assert.ok(PURGE_BOUNCED_AFTER_DAYS >= 3, "too eager — a full mailbox would be destroyed");
  assert.ok(PURGE_BOUNCED_AFTER_DAYS <= 30, "too slow to be a cleanup");
});

test("it returns the deleted addresses so the log is the surviving record", () => {
  const { q, calls } = fakeTable();

  buildPurgeQuery(q as never, NOW);

  const sel = calls.find((c) => c.op === "select");
  assert.ok(sel, "must select something back");
  assert.equal(sel!.args[0], "email");
});

test("confirmed subscribers can never be caught by this query", () => {
  const { q, calls } = fakeTable();

  buildPurgeQuery(q as never, NOW);

  // Exactly one status filter, and it is 'bounced'. A second status value, or a
  // missing one, would widen the delete to real subscribers.
  const statusFilters = calls.filter((c) => c.op === "eq" && c.args[0] === "status");
  assert.equal(statusFilters.length, 1);
  assert.equal(statusFilters[0]!.args[1], "bounced");
});

// ── Pending reminders stop at the site-wide confirmation cap (2026-10-02) ─────
// Bots created ~49 pending rows on Oct 1–2; three days later this sweep would have sent all of
// them a reminder 500 ms apart. Now it stops at the cap and leaves the rest untouched for the
// next daily sweep.
test("the reminder sweep stops at the confirmation cap and leaves the remaining rows untouched", async () => {
  const pending: PendingRow[] = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `Guest ${i}`, email: `g${i}@example.com`, lang: i === 1 ? "es" : "en" }));
  const marked: string[] = [];
  const sent: [string, string, string][] = [];
  const cap = createSendCap({ limit: 2, now: () => 0 });
  let n = 0;
  const out = await remindPending(pending, {
    markReminded: async (id) => { marked.push(id); return { error: null }; },
    send: async (sub, token, lang) => { sent.push([sub.email, token, lang]); return { success: true }; },
    sendCap: cap,
    newToken: () => `t${++n}`,
    pause: async () => {},
  });
  assert.deepEqual(out, { reminded: 2, failed: 0, deferred: 3 });
  assert.deepEqual(marked, ["p0", "p1"], "rows past the cap keep no reminder_sent_at, so tomorrow's sweep finds them");
  assert.deepEqual(sent, [["g0@example.com", "t1", "en"], ["g1@example.com", "t2", "es"]]);
});

test("a reminder whose row could not be updated sends nothing and hands its cap slot back", async () => {
  const cap = createSendCap({ limit: 1, now: () => 0 });
  const sent: string[] = [];
  const out = await remindPending(
    [{ id: "a", name: "A", email: "a@example.com" }, { id: "b", name: "B", email: "b@example.com" }],
    {
      markReminded: async (id) => ({ error: id === "a" ? new Error("db down") : null }),
      send: async (sub) => { sent.push(sub.email); return { success: true }; },
      sendCap: cap,
      newToken: () => "t",
      pause: async () => {},
    },
  );
  assert.deepEqual(out, { reminded: 1, failed: 1, deferred: 0 });
  assert.deepEqual(sent, ["b@example.com"]);
});
