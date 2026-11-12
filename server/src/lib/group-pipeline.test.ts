// group-pipeline.test.ts — every person of a group has one level, one status and one next step (Mark 2026-11-11: "i cannot see currently what the
// status is and what the next step is after the client says Book it").

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { pipelineStage, type PipelineInput } from "./group-pipeline";

const NO_PRICE = { sent: null, sent_at: null, approved_at: null, approved_how: null, changes_open: false } as const;
const base: PipelineInput = { status: "new", choice: null, call_when: null, quote_requested_at: null, booking_completed_at: null, price: { ...NO_PRICE }, paperwork: null, signed: null };
const at = (over: Partial<PipelineInput>) => pipelineStage({ ...base, ...over });
const CHOSEN = "2026-11-10T15:00:00.000Z";

test("a reply whose choices are not in is a lead, and the call is Mark's move", () => {
  assert.deepEqual(at({}), { level: "lead", key: "saved-spot", status: "Saved a spot", next: "Waiting on the guest: the form or a call", on: "guest", since: null });
  const call = at({ choice: "call", call_when: "2026-11-12T20:00:00.000Z" });
  assert.deepEqual([call.level, call.key, call.on, call.since], ["lead", "call-booked", "mark", "2026-11-12T20:00:00.000Z"]);
  assert.match(call.next, /ring them/i);
  const talked = at({ choice: "call", status: "contacted" });
  assert.deepEqual([talked.level, talked.key, talked.on], ["lead", "talked", "guest"]);
  assert.deepEqual([at({ choice: "finish" }).key, at({ choice: "finish" }).on], ["hold-asked", "mark"]);
});

test("a reply Mark closed is on no level", () => {
  for (const status of ["declined", "spam"]) {
    const s = at({ status, quote_requested_at: CHOSEN, price: { ...NO_PRICE, approved_at: CHOSEN, approved_how: "guest" } });
    assert.deepEqual([s.level, s.on], ["closed", "done"], `${status} stays closed whatever else is on the record`);
  }
});

test("choices in: a quote, with Mark's move until the quote is emailed and after the guest asks for changes", () => {
  const q = { quote_requested_at: CHOSEN, paperwork: "booking" };
  assert.deepEqual([at(q).level, at(q).key, at(q).on, at(q).since], ["quote", "choices-in", "mark", CHOSEN]);
  assert.match(at(q).next, /re-quote.*email the quote/i);
  const sent = at({ ...q, price: { ...NO_PRICE, sent: "sent", sent_at: "2026-11-11T01:00:00.000Z" } });
  assert.deepEqual([sent.level, sent.key, sent.on], ["quote", "quote-sent", "guest"]);
  for (const how of ["held", "no-email", "failed"]) {
    const bad = at({ ...q, price: { ...NO_PRICE, sent: how, sent_at: "2026-11-11T01:00:00.000Z" } });
    assert.deepEqual([bad.key, bad.on], ["quote-not-sent", "mark"], `a quote that did not go out (${how}) is Mark's to send again`);
    assert.match(bad.status, /did not go out/);
  }
  const changes = at({ ...q, price: { ...NO_PRICE, sent: "sent", sent_at: "2026-11-11T01:00:00.000Z", changes_open: true } });
  assert.deepEqual([changes.level, changes.key, changes.on], ["quote", "changes", "mark"]);
});

test("Book It: booked, and the next step is Mark's (book it, confirmation numbers, paperwork)", () => {
  const yes = at({ quote_requested_at: CHOSEN, paperwork: "booking", price: { sent: "sent", sent_at: CHOSEN, approved_at: "2026-11-11T02:00:00.000Z", approved_how: "guest", changes_open: false } });
  assert.deepEqual([yes.level, yes.key, yes.status, yes.on, yes.since], ["booked", "book-it", "Said Book It", "mark", "2026-11-11T02:00:00.000Z"]);
  assert.match(yes.next, /book it with the cruise line.*confirmation numbers.*send the paperwork/i);
  const byMark = at({ quote_requested_at: CHOSEN, paperwork: "booking", price: { ...NO_PRICE, approved_at: CHOSEN, approved_how: "mark" } });
  assert.equal(byMark.status, "Said yes (you recorded it)");
});

test("paperwork out: waiting on signatures, then Mark confirms, then done", () => {
  const out = { quote_requested_at: CHOSEN, paperwork: "sent", price: { ...NO_PRICE, approved_at: CHOSEN, approved_how: "guest" as const } };
  const signing = at({ ...out, signed: { required: 5, signed: 2, complete: false } });
  assert.deepEqual([signing.level, signing.key, signing.status, signing.on], ["booked", "signing", "Paperwork is out: 2 of 5 signed", "guest"]);
  assert.equal(at({ ...out, signed: null }).status, "Paperwork is out: nothing signed yet");
  const signed = at({ ...out, signed: { required: 5, signed: 5, complete: true } });
  assert.deepEqual([signed.key, signed.on], ["signed", "mark"]);
  assert.match(signed.next, /confirm the booking/i);
  const done = at({ ...out, signed: { required: 5, signed: 5, complete: true }, booking_completed_at: "2026-11-13T00:00:00.000Z" });
  assert.deepEqual([done.level, done.key, done.on, done.since], ["booked", "confirmed", "done", "2026-11-13T00:00:00.000Z"]);
  for (const how of ["held", "no-email", "failed"]) {
    const bad = at({ ...out, paperwork: how });
    assert.deepEqual([bad.level, bad.key, bad.on], ["booked", "paperwork-not-sent", "mark"], `paperwork that did not go out (${how}) is Mark's to send again`);
  }
});

test("every stage names a status and a next step in words", () => {
  const cases: Array<Partial<PipelineInput>> = [{}, { choice: "call" }, { status: "declined" }, { quote_requested_at: CHOSEN }, { quote_requested_at: CHOSEN, paperwork: "sent" }, { status: "booked" }];
  for (const c of cases) {
    const s = at(c);
    assert.ok(s.status.length > 3 && s.next.length > 3, JSON.stringify(s));
    assert.ok(["mark", "guest", "done"].includes(s.on));
  }
});
