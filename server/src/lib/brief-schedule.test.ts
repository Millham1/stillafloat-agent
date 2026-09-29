// brief-schedule.test.ts — the brief fires at each configured hour, once a day.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { DEFAULT_BRIEF_HOURS, parseBriefHours, dueBriefHour, slotKey } from "./brief-schedule";

test("default is three work-day slots: 7am, noon, 4pm", () => {
  assert.deepEqual(DEFAULT_BRIEF_HOURS, [7, 12, 16]);
  assert.deepEqual(parseBriefHours(undefined), [7, 12, 16]);
  assert.deepEqual(parseBriefHours(""), [7, 12, 16]);
});

test("parses, sorts, dedupes and drops bad hours", () => {
  assert.deepEqual(parseBriefHours("16, 7,12,7"), [7, 12, 16]);
  assert.deepEqual(parseBriefHours("8,25,x,-1,13"), [8, 13]);
  assert.deepEqual(parseBriefHours("nope"), [7, 12, 16]);
});

test("each slot fires once per date, and only in its hour", () => {
  const hours = [7, 12, 16];
  const sent = new Set<string>();
  assert.equal(dueBriefHour(6, "2026-09-29", hours, sent), null);
  assert.equal(dueBriefHour(7, "2026-09-29", hours, sent), 7);
  sent.add(slotKey("2026-09-29", 7));
  assert.equal(dueBriefHour(7, "2026-09-29", hours, sent), null);   // 5-minute ticks in the same hour
  assert.equal(dueBriefHour(12, "2026-09-29", hours, sent), 12);    // noon still due
  sent.add(slotKey("2026-09-29", 12));
  assert.equal(dueBriefHour(16, "2026-09-29", hours, sent), 16);
  assert.equal(dueBriefHour(7, "2026-09-30", hours, sent), 7);      // next day starts over
  assert.equal(dueBriefHour(20, "2026-09-29", hours, sent), null);
});
