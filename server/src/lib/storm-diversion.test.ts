// storm-diversion.test.ts — the course-change classifier (Mark, 2026-09-05).
// The Navigator fixture is the real 08-28 → 09-04 pattern that produced 22
// false "diversions" under the old detector; it must produce NONE here.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  classifyDestinationChange, successorsOf, knownPorts, dedupKey, kindConfidence,
  MIN_LEG_HOURS, MAX_SILENCE_HOURS, EVENT_KINDS,
  type PortCall, type ChangeInput, type ChangeVerdict,
} from "./storm-diversion";
import { mergeDetections, describeDiversion, diversionButtons, type PendingDiversion } from "./storm-diversion-events";
import { newsItemMatchesShip } from "./storm-intel";

// The cases below this point were written for the AIS-only classifier, which
// as of 2026-09-21 is the FALLBACK rather than the default (it produced 25
// false diversions in three days — see the header of storm-diversion.ts).
// They still document that path, so the suite runs it explicitly. The
// itinerary-first tests at the bottom of this file manage the flag themselves.
process.env["STORM_DIVERSION_AIS_FALLBACK"] = "1";
import { buildWatchItineraryEvent } from "./wms-alerts";

const T0 = Date.parse("2026-09-04T12:00:00Z");
const iso = (hoursFromT0: number) => new Date(T0 + hoursFromT0 * 3_600_000).toISOString();
const call = (slug: string, arrivedH: number, departedH: number | null): PortCall =>
  ({ slug, arrivedAt: iso(arrivedH), departedAt: departedH === null ? null : iso(departedH) });

// Navigator of the Seas, as the tracker actually saw it (hours relative to T0):
// LA → Ensenada → LA → Cabo → Puerto Vallarta → LA  (3/4-night and 7-night loops)
const NAVIGATOR: PortCall[] = [
  call("los-angeles", -360, -350),
  call("ensenada", -330, -320),
  call("los-angeles", -300, -290),
  call("cabo-san-lucas", -230, -220),
  call("puerto-vallarta", -200, -190),
  call("los-angeles", -150, -140),
  call("ensenada", -120, -110),
  call("los-angeles", -90, -80),
  call("cabo-san-lucas", -40, -30),
  call("puerto-vallarta", -20, -12),
  call("los-angeles", -6, -2),
];

function base(over: Partial<ChangeInput> = {}): ChangeInput {
  return {
    baseline: "los-angeles", baselineDeclaredAt: iso(-20), current: "ensenada", now: iso(0),
    inPortSlug: null, lastPortSlug: "los-angeles", lastPortDepartedAt: iso(-2), lastPosAt: iso(-0.2),
    portCalls: NAVIGATOR, knownExtra: ["los-angeles"], observedSince: iso(-400),
    ...over,
  };
}

// ── Baseline handling ────────────────────────────────────────────────────────

test("first sighting sets the baseline and its timestamp, no event", () => {
  const v = classifyDestinationChange(base({ baseline: null, baselineDeclaredAt: null }));
  assert.equal(v.kind, "unknown");
  assert.equal(v.newBaseline, "ensenada");
  assert.equal(v.newBaselineDeclaredAt, iso(0));
  assert.equal(v.change, null);
});

test("no declared destination / unchanged destination → nothing", () => {
  assert.equal(classifyDestinationChange(base({ current: null })).change, null);
  const same = classifyDestinationChange(base({ current: "los-angeles" }));
  assert.equal(same.kind, "rotation");
  assert.equal(same.change, null);
});

// ── The regression: scheduled rotation is NOT a course change ────────────────

test("Navigator: LA → Ensenada after calling at LA is rotation (the old detector's false positive)", () => {
  const v = classifyDestinationChange(base());
  assert.equal(v.kind, "rotation");
  assert.deepEqual(v.change, { from: "los-angeles", to: "ensenada" });
  assert.equal(v.newBaseline, "ensenada");
});

test("Navigator: LA → Cabo (its alternate loop) is also rotation", () => {
  assert.equal(classifyDestinationChange(base({ current: "cabo-san-lucas" })).kind, "rotation");
});

test("Navigator: Cabo → Puerto Vallarta mid-rotation is rotation", () => {
  const v = classifyDestinationChange(base({
    baseline: "cabo-san-lucas", baselineDeclaredAt: iso(-80), current: "puerto-vallarta",
    inPortSlug: null, lastPortSlug: "cabo-san-lucas", lastPortDepartedAt: iso(-30),
  }));
  assert.equal(v.kind, "rotation");
});

// ── Real course changes ──────────────────────────────────────────────────────

test("order_change: after LA, Puerto Vallarta is a known port but never the next one", () => {
  const v = classifyDestinationChange(base({ current: "puerto-vallarta" }));
  assert.equal(v.kind, "order_change");
  assert.match(v.reason, /ensenada|cabo-san-lucas/);
  assert.equal(kindConfidence(v.kind), "medium");
});

test("new_port: a port this ship has never called at", () => {
  const v = classifyDestinationChange(base({ current: "mazatlan" }));
  assert.equal(v.kind, "new_port");
  assert.equal(kindConfidence(v.kind), "high");
});

test("reroute: declared Cabo 10h ago, never called there, now declares LA", () => {
  const v = classifyDestinationChange(base({
    baseline: "cabo-san-lucas", baselineDeclaredAt: iso(-10), current: "los-angeles",
    inPortSlug: null, lastPortSlug: "puerto-vallarta", lastPortDepartedAt: iso(-12),
    portCalls: NAVIGATOR.filter((c) => Date.parse(c.arrivedAt) < T0 - 11 * 3_600_000),
  }));
  assert.equal(v.kind, "reroute");
  assert.match(v.reason, /never called there/);
});

test("reroute: skipped the declared port (called somewhere else instead)", () => {
  const v = classifyDestinationChange(base({
    baseline: "cabo-san-lucas", baselineDeclaredAt: iso(-30), current: "los-angeles",
    inPortSlug: null, lastPortSlug: "ensenada", lastPortDepartedAt: iso(-3),
    portCalls: [...NAVIGATOR.filter((c) => Date.parse(c.arrivedAt) < T0 - 31 * 3_600_000), call("ensenada", -8, -3)],
  }));
  assert.equal(v.kind, "reroute");
});

// ── Evidence rules: never claim what we could not have seen ──────────────────

test("unknown: destination flipped within the correction window", () => {
  const v = classifyDestinationChange(base({
    baseline: "cabo-san-lucas", baselineDeclaredAt: iso(-(MIN_LEG_HOURS - 0.5)), current: "los-angeles",
    lastPortSlug: "puerto-vallarta", lastPortDepartedAt: iso(-12),
  }));
  assert.equal(v.kind, "unknown");
  assert.deepEqual(v.change, { from: "cabo-san-lucas", to: "los-angeles" }); // re-baselined, no event
});

test("unknown: the leg began before the tracker's observation window (restart gap)", () => {
  const v = classifyDestinationChange(base({
    baseline: "cabo-san-lucas", baselineDeclaredAt: iso(-10), current: "los-angeles",
    lastPortSlug: "puerto-vallarta", lastPortDepartedAt: iso(-12), observedSince: iso(-5),
  }));
  assert.equal(v.kind, "unknown");
});

test("unknown: ship went silent — a port call could have been missed", () => {
  const v = classifyDestinationChange(base({
    baseline: "cabo-san-lucas", baselineDeclaredAt: iso(-10), current: "los-angeles",
    lastPortSlug: "puerto-vallarta", lastPortDepartedAt: iso(-12), lastPosAt: iso(-(MAX_SILENCE_HOURS + 1)),
  }));
  assert.equal(v.kind, "unknown");
});

test("unknown: legacy row with no declared-at timestamp cannot support a reroute", () => {
  const v = classifyDestinationChange(base({
    baseline: "cabo-san-lucas", baselineDeclaredAt: null, current: "los-angeles",
    lastPortSlug: "puerto-vallarta", lastPortDepartedAt: iso(-12),
    portCalls: NAVIGATOR.filter((c) => c.slug !== "cabo-san-lucas"),
  }));
  assert.equal(v.kind, "unknown");
});

test("no history → order cannot be judged → rotation, not a nudge", () => {
  const v = classifyDestinationChange(base({ current: "puerto-vallarta", portCalls: [call("los-angeles", -6, -2)], knownExtra: [] }));
  assert.equal(v.kind, "rotation");
});

// ── Helpers ──────────────────────────────────────────────────────────────────

test("successorsOf learns both of Navigator's loops from LA", () => {
  const s = successorsOf(NAVIGATOR, "los-angeles");
  assert.deepEqual([...s.ports].sort(), ["cabo-san-lucas", "ensenada"]);
  assert.equal(s.departures, 4);
});

test("knownPorts merges the log with extra sources", () => {
  assert.ok(knownPorts(NAVIGATOR, ["long-beach"]).includes("long-beach"));
  assert.ok(knownPorts(NAVIGATOR).includes("puerto-vallarta"));
});

test("dedupKey: one key per ship movement per day, case-insensitive", () => {
  assert.equal(dedupKey("Navigator of the Seas", "cabo-san-lucas", "los-angeles", iso(0)),
    dedupKey("navigator of the seas", "cabo-san-lucas", "los-angeles", iso(3)));
  assert.notEqual(dedupKey("Navigator of the Seas", "cabo-san-lucas", "los-angeles", iso(0)),
    dedupKey("Navigator of the Seas", "cabo-san-lucas", "los-angeles", iso(30)));
});

test("mergeDetections: the same movement in three storms is ONE event naming all three", () => {
  const d = (stormName: string, alertId: string): PendingDiversion => ({
    shipName: "Navigator of the Seas", cruiseLine: "Royal Caribbean", mmsi: "210662000", kind: "reroute",
    from: "cabo-san-lucas", to: "los-angeles", raw: "US LAX", at: iso(0), reason: "test", alertId, stormName,
  });
  const merged = mergeDetections([d("Karina", "a1"), d("Marie", "a2"), d("Lowell", "a3")]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]?.alertIds, ["a1", "a2", "a3"]);
  assert.deepEqual(merged[0]?.stormNames, ["Karina", "Marie", "Lowell"]);
});

test("the nudge offers exactly Publish / Open dashboard / Ignore", () => {
  const b = diversionButtons("evt1");
  assert.equal(b.length, 3);
  assert.match(b[0]?.path ?? "", /\/api\/storm-diversions\/evt1\/publish$/);
  assert.equal(b[1]?.href, "/storm-alerts");
  assert.equal(b[2]?.dismiss, true);
  const body = describeDiversion({
    ship_name: "Navigator of the Seas", kind: "reroute", from_slug: "cabo-san-lucas", to_slug: "los-angeles",
    raw: "US LAX", reason: "declared cabo 10h ago, never called there", storm_names: ["Karina", "Marie"],
    intel: [{ line: "Cruise Hive", note: "Navigator skips Cabo as Karina nears", url: "https://x" }],
  });
  assert.match(body, /Cabo San Lucas.*→.*Los Angeles/);
  assert.match(body, /Karina, Marie/);
  assert.match(body, /Cruise Hive/);
  assert.match(body, /Nothing is emailed/);
});

test("newsItemMatchesShip needs the ship name plus a storm/itinerary signal", () => {
  assert.equal(newsItemMatchesShip({ title: "Navigator of the Seas skips Cabo as Tropical Storm Karina nears", description: "" }, "Navigator of the Seas"), true);
  assert.equal(newsItemMatchesShip({ title: "Navigator of the Seas adds a new pizza venue", description: "food news" }, "Navigator of the Seas"), false);
  assert.equal(newsItemMatchesShip({ title: "Carnival Panorama reroutes for weather", description: "" }, "Navigator of the Seas"), false);
});


test("watchers are told about a REAL course change in plain words, deduped per day", () => {
  const ev = buildWatchItineraryEvent("Navigator of the Seas", "reroute", { from: "cabo-san-lucas", to: "los-angeles" }, "w1", iso(0));
  assert.match(ev.title, /re-routed mid-leg/);
  assert.match(ev.title, /Los Angeles/);
  assert.match(ev.body, /was headed to Cabo San Lucas/);
  assert.match(ev.body, /cruise line/);
  const again = buildWatchItineraryEvent("Navigator of the Seas", "reroute", { from: "cabo-san-lucas", to: "los-angeles" }, "w1", iso(5));
  assert.equal(ev.hash, again.hash); // same day → same hash → one email
  assert.notEqual(ev.hash, buildWatchItineraryEvent("Navigator of the Seas", "reroute", { from: "cabo-san-lucas", to: "los-angeles" }, "w2", iso(0)).hash);
});

// ── Itinerary-first classification (2026-09-21) ───────────────────────────────
// Regression fixtures are the REAL events the AIS-only classifier filed between
// 19 and 21 Sep. Every one was a scheduled port; every one must now be silent.

const GETAWAY = ["miami", "great-stirrup", "nassau", "miami"];
const SPIRIT = ["seattle", "endicott-arm", "skagway", "juneau", "ketchikan", "victoria-bc", "seattle"];

function withItinerary(over: Partial<ChangeInput>, itinerary: readonly string[]): ChangeVerdict {
  return classifyDestinationChange({
    baseline: "miami", baselineDeclaredAt: "2026-09-21T00:00:00Z",
    current: "great-stirrup", now: "2026-09-21T10:34:00Z",
    inPortSlug: "miami", lastPortSlug: "miami", lastPortDepartedAt: null,
    lastPosAt: "2026-09-21T10:30:00Z", portCalls: [], observedSince: "2026-09-05T21:12:00Z",
    itinerary, ...over,
  });
}

test("REGRESSION: Getaway's Great Stirrup Cay is her itinerary, not a new port", () => {
  const v = withItinerary({}, GETAWAY);
  assert.equal(v.kind, "rotation");
  assert.equal(EVENT_KINDS.has(v.kind), false, "must not reach the review queue");
});

test("REGRESSION: Getaway Nassau → Miami is the run home, not a re-route", () => {
  const v = withItinerary({ baseline: "nassau", current: "miami" }, GETAWAY);
  assert.equal(v.kind, "rotation");
  assert.equal(EVENT_KINDS.has(v.kind), false);
});

test("REGRESSION: Carnival Spirit declaring a port further down her run is silent", () => {
  // Crews type "USKTN > CAVIC"; our decoder takes Victoria, five ports ahead.
  const v = withItinerary({ baseline: "seattle", current: "victoria-bc" }, SPIRIT);
  assert.equal(EVENT_KINDS.has(v.kind), false, "declaring a later scheduled port is the timetable");
});

test("a port that is NOT on the itinerary is still a real diversion", () => {
  const v = withItinerary({ current: "bermuda" }, GETAWAY);
  assert.equal(v.kind, "reroute");
  assert.equal(EVENT_KINDS.has(v.kind), true);
  assert.match(v.reason, /not on this sailing's itinerary/);
});

test("an out-of-order scheduled port is recorded as a swap, never alerted", () => {
  const v = withItinerary({ baseline: "nassau", current: "great-stirrup" }, GETAWAY);
  assert.equal(v.kind, "itinerary_swap");
  assert.equal(EVENT_KINDS.has(v.kind), false, "sources disagree on order — a swap must not email anyone");
});

test("with NO itinerary the classifier says nothing rather than guessing", () => {
  const prev = process.env["STORM_DIVERSION_AIS_FALLBACK"];
  delete process.env["STORM_DIVERSION_AIS_FALLBACK"];
  const v = classifyDestinationChange({
    baseline: "nassau", baselineDeclaredAt: "2026-09-19T12:00:00Z",
    current: "miami", now: "2026-09-21T07:34:00Z",
    inPortSlug: null, lastPortSlug: "miami", lastPortDepartedAt: "2026-09-18T20:17:00Z",
    lastPosAt: "2026-09-21T07:30:00Z",
    // The exact history that produced the false re-route: five Miami calls.
    portCalls: [
      { slug: "miami", arrivedAt: "2026-09-07T09:52:00Z", departedAt: "2026-09-07T20:36:00Z" },
      { slug: "miami", arrivedAt: "2026-09-11T09:46:00Z", departedAt: "2026-09-11T20:15:00Z" },
      { slug: "miami", arrivedAt: "2026-09-14T08:55:00Z", departedAt: "2026-09-14T20:17:00Z" },
      { slug: "miami", arrivedAt: "2026-09-18T09:38:00Z", departedAt: "2026-09-18T20:17:00Z" },
    ],
    observedSince: "2026-09-05T21:12:00Z", itinerary: null,
  });
  assert.equal(v.kind, "unknown");
  assert.equal(EVENT_KINDS.has(v.kind), false);
  assert.match(v.reason, /no itinerary on file/);
  if (prev !== undefined) process.env["STORM_DIVERSION_AIS_FALLBACK"] = prev;
});

test("the old AIS heuristics still work when explicitly re-enabled", () => {
  const prev = process.env["STORM_DIVERSION_AIS_FALLBACK"];
  process.env["STORM_DIVERSION_AIS_FALLBACK"] = "1";
  const v = classifyDestinationChange({
    baseline: "nassau", baselineDeclaredAt: "2026-09-19T12:00:00Z",
    current: "miami", now: "2026-09-21T07:34:00Z",
    inPortSlug: null, lastPortSlug: "miami", lastPortDepartedAt: "2026-09-18T20:17:00Z",
    lastPosAt: "2026-09-21T07:30:00Z", portCalls: [], observedSince: "2026-09-05T21:12:00Z",
    itinerary: null,
  });
  assert.equal(v.kind, "reroute", "the old path is preserved behind the flag");
  if (prev === undefined) delete process.env["STORM_DIVERSION_AIS_FALLBACK"];
  else process.env["STORM_DIVERSION_AIS_FALLBACK"] = prev;
});
