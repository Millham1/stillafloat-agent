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
import { buildPurgeQuery, PURGE_BOUNCED_AFTER_DAYS } from "./subscriber-hygiene";

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
