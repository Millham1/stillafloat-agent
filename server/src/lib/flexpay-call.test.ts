// Mark 2026-11-05: "it should bring up a scheduler for a video conference. M-S 10-8 and doesn't conflict with any meetings on my schedule already."
import { test } from "node:test";
import assert from "node:assert/strict";
import { CALL, callWhenText, freeSlots, isRuleSlot, ruleSlots, ruleWindow, zonedTime } from "./flexpay-call";

// Thursday 2026-11-05, 9:00 AM Eastern (EST, UTC-5)
const NOW = new Date("2026-11-05T14:00:00Z");
const et = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });

test("Mark's clock: 10:00 AM Eastern is 15:00 UTC in winter and 14:00 UTC in summer", () => {
  assert.equal(zonedTime(2026, 11, 5, 10, 0).toISOString(), "2026-11-05T15:00:00.000Z");
  assert.equal(zonedTime(2026, 7, 6, 10, 0).toISOString(), "2026-07-06T14:00:00.000Z");
});

test("the rule: Monday to Saturday, 10:00 AM to 8:00 PM Eastern, half-hour appointments, the last one starting 7:30 PM", () => {
  const days = ruleSlots(NOW);
  for (const d of days) {
    const dow = new Date(`${d.date}T12:00:00Z`).getUTCDay();
    assert.notEqual(dow, 0, `${d.date} is a Sunday`);
    for (const s of d.slots) {
      const p = new Date(s).toLocaleTimeString("en-US", { timeZone: CALL.tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
      assert.ok(p >= "10:00" && p <= "19:30", `${s} is ${p} Eastern`);
      assert.ok(p.endsWith(":00") || p.endsWith(":30"));
    }
  }
  const friday = days.find((d) => d.date === "2026-11-06")!;
  assert.equal(friday.slots.length, 20);
  assert.equal(et(friday.slots[0]!), "Fri 10:00 AM");
  assert.equal(et(friday.slots[19]!), "Fri 7:30 PM");
  assert.equal(days.some((d) => d.date === "2026-11-08"), false); // Sunday
  assert.equal(days.some((d) => d.date === "2026-11-07"), true);  // Saturday
});

test("nothing sooner than two hours from now, nothing further out than two weeks", () => {
  const days = ruleSlots(NOW);
  assert.equal(days[0]!.date, "2026-11-05");
  assert.equal(et(days[0]!.slots[0]!), "Thu 11:00 AM"); // 9:00 AM now, so 10:00 and 10:30 are too soon
  assert.equal(days[days.length - 1]!.date, "2026-11-19");
  assert.equal(ruleWindow(NOW).end, "2026-11-20T01:00:00.000Z"); // 8:00 PM Eastern on the last day
  // late in the evening, today has nothing left
  assert.equal(ruleSlots(new Date("2026-11-06T00:30:00Z"))[0]!.date, "2026-11-06");
});

test("a time is offered only when no meeting touches any part of it", () => {
  const busy = [
    { start: "2026-11-06T15:15:00Z", end: "2026-11-06T16:00:00Z" }, // Fri 10:15 to 11:00 AM: takes out 10:00 and 10:30
    { start: "2026-11-06T19:00:00Z", end: "2026-11-06T19:30:00Z" }, // Fri 2:00 to 2:30 PM: takes out exactly 2:00
  ];
  const friday = freeSlots(NOW, busy).find((d) => d.date === "2026-11-06")!;
  const shown = friday.slots.map(et);
  assert.equal(shown.includes("Fri 10:00 AM"), false);
  assert.equal(shown.includes("Fri 10:30 AM"), false);
  assert.equal(shown.includes("Fri 11:00 AM"), true); // a meeting that ends at 11:00 does not block 11:00
  assert.equal(shown.includes("Fri 1:30 PM"), true);  // one that starts at 2:00 does not block 1:30
  assert.equal(shown.includes("Fri 2:00 PM"), false);
  assert.equal(friday.slots.length, 17);
});

test("a day with every time taken is not listed", () => {
  const days = freeSlots(NOW, [{ start: "2026-11-06T14:00:00Z", end: "2026-11-07T02:00:00Z" }]);
  assert.equal(days.some((d) => d.date === "2026-11-06"), false);
});

test("only a time the rule offers can be booked", () => {
  assert.equal(isRuleSlot("2026-11-06T15:00:00.000Z", NOW), true);
  assert.equal(isRuleSlot("2026-11-06T15:10:00.000Z", NOW), false); // not on the half hour
  assert.equal(isRuleSlot("2026-11-08T15:00:00.000Z", NOW), false); // Sunday
  assert.equal(isRuleSlot("2026-11-07T01:00:00.000Z", NOW), false); // 8:00 PM: the day is over
  assert.equal(isRuleSlot("2026-11-05T15:00:00.000Z", NOW), false); // less than two hours away
  assert.equal(isRuleSlot("2026-12-01T15:00:00.000Z", NOW), false); // past two weeks
  assert.equal(isRuleSlot("tomorrow at ten", NOW), false);
  assert.equal(isRuleSlot(undefined, NOW), false);
});

test("the appointment in words, on Mark's clock", () => {
  assert.equal(callWhenText("2026-11-10T19:00:00.000Z", "en"), "Tuesday, November 10 at 2:00 PM Eastern");
  assert.match(callWhenText("2026-11-10T19:00:00.000Z", "es"), /^martes, 10 de noviembre a las 2:00\s?p\.\s?m\., hora del Este$/);
});
