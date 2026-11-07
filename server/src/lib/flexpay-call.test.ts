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
  const thursday = days.find((d) => d.date === "2026-11-05")!;
  assert.equal(thursday.slots.length, 20);
  assert.equal(et(thursday.slots[0]!), "Thu 10:00 AM");
  assert.equal(et(thursday.slots[19]!), "Thu 7:30 PM");
  const satNight = ruleSlots(new Date("2026-11-08T00:10:00Z")); // Saturday 7:10 PM: Sunday is closed
  assert.equal(satNight.some((d) => d.date === "2026-11-08"), false);
});

test("Mark 2026-11-07: the call happens within 24 hours of the request; half an hour's notice", () => {
  const days = ruleSlots(NOW); // Thursday 9:00 AM Eastern: the 24 hours end at 9:00 AM Friday, before Friday opens
  assert.deepEqual(days.map((d) => d.date), ["2026-11-05"]);
  assert.equal(et(days[0]!.slots[0]!), "Thu 10:00 AM"); // 9:00 AM now: the day's first time is an hour off, enough notice
  assert.equal(et(days[0]!.slots.slice(-1)[0]!), "Thu 7:30 PM");
  assert.equal(ruleWindow(NOW).end, "2026-11-06T01:00:00.000Z", "the window ends when the last offered time would end (8:00 PM Eastern)");
  // 10:10 AM: 10:30 is twenty minutes off, too soon; 11:00 is the first
  assert.equal(et(ruleSlots(new Date("2026-11-05T15:10:00Z"))[0]!.slots[0]!), "Thu 11:00 AM");
  // 2:00 PM: the rest of today, and tomorrow up to 2:00 PM
  const mid = ruleSlots(new Date("2026-11-05T19:00:00Z"));
  assert.deepEqual(mid.map((d) => [d.date, d.slots.length]), [["2026-11-05", 11], ["2026-11-06", 9]]);
  assert.equal(et(mid[0]!.slots[0]!), "Thu 2:30 PM");
  assert.equal(et(mid[1]!.slots.slice(-1)[0]!), "Fri 2:00 PM"); // 24 hours after the request: the last time offered
  assert.ok(mid.flatMap((d) => d.slots).every((s) => new Date(s).getTime() <= Date.parse("2026-11-05T19:00:00Z") + 24 * 3600_000));
  // late in the evening, today has nothing left: tomorrow's times up to the same hour
  const late = ruleSlots(new Date("2026-11-06T00:30:00Z")); // Thursday 7:30 PM
  assert.deepEqual(late.map((d) => d.date), ["2026-11-06"]);
  assert.equal(et(late[0]!.slots.slice(-1)[0]!), "Fri 7:30 PM"); // exactly 24 hours on
});

test("a request with no open time in its 24 hours (Saturday evening) is offered the first open day after them, and only that day", () => {
  const sat = ruleSlots(new Date("2026-11-08T00:10:00Z")); // Saturday 7:10 PM Eastern: 7:30 is twenty minutes off, too soon; Sunday is closed
  assert.deepEqual(sat.map((d) => d.date), ["2026-11-09"]);
  assert.equal(sat[0]!.slots.length, 20);
  assert.equal(et(sat[0]!.slots[0]!), "Mon 10:00 AM");
});

test("a time is offered only when no meeting touches any part of it", () => {
  const busy = [
    { start: "2026-11-06T15:15:00Z", end: "2026-11-06T16:00:00Z" }, // Fri 10:15 to 11:00 AM: takes out 10:00 and 10:30
    { start: "2026-11-06T19:00:00Z", end: "2026-11-06T19:30:00Z" }, // Fri 2:00 to 2:30 PM: takes out exactly 2:00
  ];
  const friday = freeSlots(new Date("2026-11-06T01:00:00Z"), busy).find((d) => d.date === "2026-11-06")!; // asked Thursday 8:00 PM: all of Friday is inside the 24 hours
  const shown = friday.slots.map(et);
  assert.equal(shown.includes("Fri 10:00 AM"), false);
  assert.equal(shown.includes("Fri 10:30 AM"), false);
  assert.equal(shown.includes("Fri 11:00 AM"), true); // a meeting that ends at 11:00 does not block 11:00
  assert.equal(shown.includes("Fri 1:30 PM"), true);  // one that starts at 2:00 does not block 1:30
  assert.equal(shown.includes("Fri 2:00 PM"), false);
  assert.equal(friday.slots.length, 17);
});

test("a day with every time taken is not listed", () => {
  const days = freeSlots(new Date("2026-11-06T01:00:00Z"), [{ start: "2026-11-06T14:00:00Z", end: "2026-11-07T02:00:00Z" }]);
  assert.equal(days.some((d) => d.date === "2026-11-06"), false);
});

test("only a time the rule offers can be booked", () => {
  assert.equal(isRuleSlot("2026-11-05T16:00:00.000Z", NOW), true);  // Thursday 11:00 AM
  assert.equal(isRuleSlot("2026-11-05T16:10:00.000Z", NOW), false); // not on the half hour
  assert.equal(isRuleSlot("2026-11-08T15:00:00.000Z", NOW), false); // Sunday
  assert.equal(isRuleSlot("2026-11-06T01:00:00.000Z", NOW), false); // 8:00 PM: the day is over
  assert.equal(isRuleSlot("2026-11-05T14:10:00.000Z", NOW), false); // less than half an hour away
  assert.equal(isRuleSlot("2026-11-06T15:00:00.000Z", NOW), false); // Friday 10:00 AM: past the 24 hours
  assert.equal(isRuleSlot("tomorrow at ten", NOW), false);
  assert.equal(isRuleSlot(undefined, NOW), false);
});

test("the appointment in words, on Mark's clock", () => {
  assert.equal(callWhenText("2026-11-10T19:00:00.000Z", "en"), "Tuesday, November 10 at 2:00 PM Eastern");
  assert.match(callWhenText("2026-11-10T19:00:00.000Z", "es"), /^martes, 10 de noviembre a las 2:00\s?p\.\s?m\., hora del Este$/);
});
