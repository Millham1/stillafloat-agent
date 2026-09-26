// storm-diversion-log.test.ts — the running list of ship diversions (Mark,
// 2026-09-26). Pure helpers only: window filtering, legacy rows, folding the
// same movement logged under two storms, joining the events table, ordering
// and the days clamp. The fixture is the 24 Sep nor'easter (Fay) plus a
// Caribbean hurricane (Gonzalo) that pinned some of the same ships.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  flattenPings, dedupePings, attachEvents, verdictOf, pingLabel, clampDays,
  MERGE_WINDOW_MS, DEFAULT_DAYS, MAX_DAYS,
  type TrackedShipLogRow, type StormRef, type Ping,
} from "./storm-diversion-log";
import { dedupKey } from "./storm-diversion";
import type { DiversionEventRow } from "./storm-diversion-events";

const SINCE = "2026-09-12T00:00:00.000Z"; // 14-day window ending 26 Sep

const STORMS: ReadonlyMap<string, StormRef> = new Map<string, StormRef>([
  ["a-fay",     { id: "a-fay",     nhc_id: "AL072026", name: "Fay",     classification: "Tropical Storm", status: "sent" }],
  ["a-gonzalo", { id: "a-gonzalo", nhc_id: "AL082026", name: "Gonzalo", classification: "Hurricane",      status: "approved" }],
  ["a-imelda",  { id: "a-imelda",  nhc_id: "AL062026", name: "Imelda",  classification: "Hurricane",      status: "ended" }],
]);

function row(id: string, alert_id: string, ship_name: string, cruise_line: string | null, changes: TrackedShipLogRow["changes"]): TrackedShipLogRow {
  return { id, alert_id, ship_name, cruise_line, changes };
}

// Norwegian Escape's early run home from Boston — recorded as an itinerary_swap
// under Fay's pin and, until this page, shown nowhere.
const ESCAPE = row("ts-01", "a-fay", "Norwegian Escape", "Norwegian Cruise Line", [
  { at: "2026-09-24T14:05:00.000Z", from: "boston", to: "new-york", raw: "USNYC", kind: "itinerary_swap", reason: "new-york is on the itinerary but not ahead of boston" },
  // Outside the window: must be dropped.
  { at: "2026-09-01T08:00:00.000Z", from: "new-york", to: "bermuda", raw: "BERMUDA", kind: "rotation", reason: "next port on the published itinerary" },
]);

// MSC Seascape is pinned to BOTH storms; the lifecycle logged the same movement
// once per pin. Fay's pass ran late on the 22nd, Gonzalo's after midnight —
// 2h35m apart, inside MERGE_WINDOW_MS but on different calendar days, so the
// two entries carry DIFFERENT dedup keys and must still fold into one ping.
const SEASCAPE_FAY = row("ts-02", "a-fay", "MSC Seascape", "MSC Cruises", [
  { at: "2026-09-22T22:40:00.000Z", from: "cozumel", to: "galveston", raw: "US GLS", kind: "rotation", reason: "next port on the published itinerary" },
  // The same movement two days later (her next loop) is a NEW ping.
  { at: "2026-09-24T22:40:00.000Z", from: "cozumel", to: "galveston", raw: "US GLS", kind: "rotation", reason: "next port on the published itinerary" },
]);
const SEASCAPE_GONZALO = row("ts-03", "a-gonzalo", "MSC Seascape", "MSC Cruises", [
  { at: "2026-09-23T01:15:00.000Z", from: "cozumel", to: "galveston", raw: "US GLS", kind: "rotation", reason: "next port on the published itinerary" },
]);

// A genuine diversion with a pending event in the review queue.
const TREASURE = row("ts-04", "a-gonzalo", "Disney Treasure", "Disney Cruise Line", [
  { at: "2026-09-25T06:30:00.000Z", from: "cozumel", to: "grand-cayman", raw: "GRAND CAYMAN", kind: "reroute", reason: "grand-cayman is not on this sailing's itinerary (port-canaveral → cozumel → nassau → port-canaveral)" },
]);

// Written before the 5 Sep classifier: no kind, no reason.
const LEGACY = row("ts-05", "a-imelda", "Carnival Sunrise", "Carnival Cruise Line", [
  { at: "2026-09-13T09:30:00.000Z", from: "miami", to: "nassau", raw: "NASSAU" },
]);

// Malformed entries the jsonb column can hold: no `to`, no `at`, null.
const JUNK = row("ts-06", "a-gonzalo", "Carnival Vista", "Carnival Cruise Line", [
  { at: "2026-09-20T10:00:00.000Z", from: "galveston", to: "", raw: null, kind: "rotation" },
  { at: "", from: "galveston", to: "cozumel", raw: null, kind: "rotation" },
  null as unknown as NonNullable<TrackedShipLogRow["changes"]>[number],
]);

const ROWS: TrackedShipLogRow[] = [ESCAPE, SEASCAPE_FAY, SEASCAPE_GONZALO, TREASURE, LEGACY, JUNK, row("ts-07", "a-fay", "Carnival Venezia", "Carnival Cruise Line", null)];

function event(over: Partial<DiversionEventRow> & Pick<DiversionEventRow, "id" | "ship_name" | "from_slug" | "to_slug" | "detected_at" | "kind">): DiversionEventRow {
  return {
    cruise_line: null, mmsi: null, raw: null, reason: null, alert_ids: [], storm_names: [], intel: [],
    status: "pending", published_at: null, ignored_at: null,
    dedup_key: dedupKey(over.ship_name, over.from_slug, over.to_slug, over.detected_at),
    ...over,
  };
}

const PENDING_TREASURE = event({
  id: "ev-01", ship_name: "Disney Treasure", cruise_line: "Disney Cruise Line", kind: "reroute",
  from_slug: "cozumel", to_slug: "grand-cayman", raw: "GRAND CAYMAN",
  reason: "grand-cayman is not on this sailing's itinerary (port-canaveral → cozumel → nassau → port-canaveral)",
  detected_at: "2026-09-25T06:30:00.000Z", alert_ids: ["a-gonzalo"], storm_names: ["Gonzalo"],
});

// A dev-box simulation: nothing in storm_tracked_ships matches it.
const SIMULATED = event({
  id: "ev-02", ship_name: "Navigator of the Seas", cruise_line: "Royal Caribbean", kind: "reroute",
  from_slug: "cabo-san-lucas", to_slug: "los-angeles", raw: "SIMULATED",
  reason: "simulated on the dev box to exercise the nudge → publish path",
  detected_at: "2026-09-19T15:00:00.000Z", alert_ids: ["a-gonzalo"], storm_names: ["Gonzalo"],
  status: "ignored", ignored_at: "2026-09-19T15:20:00.000Z",
});

const at = (list: readonly Ping[]) => list.map((p) => p.at);
const find = (list: readonly Ping[], ship: string, to: string) => list.find((p) => p.ship_name === ship && p.to_slug === to);

// ── flattenPings ─────────────────────────────────────────────────────────────

test("flattenPings: entries older than `since` are dropped, junk entries are skipped", () => {
  const pings = flattenPings(ROWS, STORMS, SINCE);
  assert.equal(pings.some((p) => p.to_slug === "bermuda"), false, "1 Sep entry is outside the window");
  assert.equal(pings.some((p) => p.ship_name === "Carnival Vista"), false, "no `to`, no `at`, null → skipped");
  assert.ok(pings.every((p) => Date.parse(p.at) >= Date.parse(SINCE)));
  // 1 Escape + 2 Seascape/Fay + 1 Seascape/Gonzalo + 1 Treasure + 1 legacy
  assert.equal(pings.length, 6);
});

test("flattenPings: names the storm, resolves port names, keys every entry", () => {
  const pings = flattenPings(ROWS, STORMS, SINCE);
  const escape = find(pings, "Norwegian Escape", "new-york");
  assert.ok(escape);
  assert.deepEqual(escape.storms, ["Fay"]);
  assert.deepEqual(escape.alert_ids, ["a-fay"]);
  assert.equal(escape.from_name, "Boston, Massachusetts");
  assert.equal(escape.to_name, "New York City, New York");
  assert.equal(escape.kind, "itinerary_swap");
  assert.equal(escape.verdict, "swap");
  assert.equal(escape.label, "called its scheduled ports in a different order");
  assert.equal(escape.source, "ping");
  assert.equal(escape.event, null);
  assert.deepEqual(escape.dedup_keys, ["norwegian escape|boston|new-york|2026-09-24"]);
});

test("flattenPings: a legacy entry (no kind) is kind 'legacy', verdict 'unknown', and says so", () => {
  const pings = flattenPings(ROWS, STORMS, SINCE);
  const legacy = find(pings, "Carnival Sunrise", "nassau");
  assert.ok(legacy);
  assert.equal(legacy.kind, "legacy");
  assert.equal(legacy.verdict, "unknown");
  assert.equal(legacy.reason, null);
  assert.match(legacy.label, /before the 5 Sep detector/);
  assert.deepEqual(legacy.storms, ["Imelda"]);
});

test("flattenPings: an unknown alert id falls back to the id prefix, not a crash", () => {
  const pings = flattenPings([row("x", "deadbeef-0000-4000-8000-000000000000", "MSC Seascape", null, [
    { at: "2026-09-20T00:00:00.000Z", from: null, to: "miami", raw: null, kind: "unknown", reason: "first sighting sets the baseline" },
  ])], STORMS, SINCE);
  assert.deepEqual(pings[0]?.storms, ["deadbeef"]);
  assert.equal(pings[0]?.from_name, "unknown");
  assert.deepEqual(pings[0]?.dedup_keys, ["msc seascape|?|miami|2026-09-20"]);
});

// ── dedupePings ──────────────────────────────────────────────────────────────

test("dedupePings: the same movement under two storms within the merge window is ONE ping", () => {
  const pings = dedupePings(flattenPings(ROWS, STORMS, SINCE));
  const seascape = pings.filter((p) => p.ship_name === "MSC Seascape");
  assert.equal(seascape.length, 2, "22/23 Sep pair folds; 24 Sep loop stays separate");

  const folded = seascape.find((p) => p.at === "2026-09-22T22:40:00.000Z");
  assert.ok(folded, "keeps the EARLIEST timestamp — when the movement was first seen");
  assert.deepEqual(folded.storms, ["Fay", "Gonzalo"]);
  assert.deepEqual(folded.alert_ids, ["a-fay", "a-gonzalo"]);
  assert.deepEqual(folded.dedup_keys, [
    "msc seascape|cozumel|galveston|2026-09-22",
    "msc seascape|cozumel|galveston|2026-09-23",
  ], "both storms' keys ride along so either event row can join later");

  const later = seascape.find((p) => p.at === "2026-09-24T22:40:00.000Z");
  assert.ok(later, "the same movement two days later is her next loop, not a duplicate");
  assert.deepEqual(later.storms, ["Fay"]);
  assert.deepEqual(later.dedup_keys, ["msc seascape|cozumel|galveston|2026-09-24"]);
});

test("dedupePings: the merge window is a hard edge and the input is not mutated", () => {
  const base = flattenPings([SEASCAPE_GONZALO], STORMS, SINCE)[0]!;
  const t0 = Date.parse(base.at);
  const mk = (offsetMs: number, storm: string, alert: string): Ping =>
    ({ ...base, at: new Date(t0 + offsetMs).toISOString(), storms: [storm], alert_ids: [alert], dedup_keys: [`k-${alert}`] });
  const inside = mk(MERGE_WINDOW_MS, "Fay", "a-fay");
  const outside = mk(MERGE_WINDOW_MS + 1, "Imelda", "a-imelda");

  const input = [outside, base, inside];
  const out = dedupePings(input);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1]?.storms, ["Gonzalo", "Fay"], "exactly MERGE_WINDOW_MS later still folds");
  assert.deepEqual(out[0]?.storms, ["Imelda"], "one millisecond past the window does not");
  assert.deepEqual(base.storms, ["Gonzalo"], "the original ping is untouched");
  assert.deepEqual(input.map((p) => p.storms), [["Imelda"], ["Gonzalo"], ["Fay"]]);
});

test("dedupePings: a later pass with a real verdict upgrades a legacy first entry", () => {
  const legacy = flattenPings([LEGACY], STORMS, SINCE)[0]!;
  const classified: Ping = {
    ...legacy, at: "2026-09-13T09:31:00.000Z", kind: "rotation", verdict: "routine",
    label: "moved to its next scheduled port", reason: "next port on the published itinerary", storms: ["Gonzalo"], alert_ids: ["a-gonzalo"],
  };
  const [only] = dedupePings([legacy, classified]);
  assert.equal(only?.at, legacy.at);
  assert.equal(only?.kind, "rotation");
  assert.equal(only?.verdict, "routine");
  assert.equal(only?.reason, "next port on the published itinerary");
  assert.deepEqual(only?.storms, ["Imelda", "Gonzalo"]);
});

// ── attachEvents ─────────────────────────────────────────────────────────────

test("attachEvents: an event joins its ping by dedup key and the event's status/kind/verdict win", () => {
  const pings = dedupePings(flattenPings(ROWS, STORMS, SINCE));
  // The event is the reviewed record: give it a different kind than the raw
  // change carried and make sure the event's wins.
  const reviewed: DiversionEventRow = { ...PENDING_TREASURE, kind: "new_port", status: "published", published_at: "2026-09-25T09:00:00.000Z" };
  const out = attachEvents(pings, [reviewed]);
  const treasure = find(out, "Disney Treasure", "grand-cayman");
  assert.ok(treasure);
  assert.equal(treasure.source, "ping", "still the tracked-ship entry, now with its event");
  assert.equal(treasure.event?.id, "ev-01");
  assert.equal(treasure.event?.status, "published");
  assert.equal(treasure.event?.published_at, "2026-09-25T09:00:00.000Z");
  assert.equal(treasure.kind, "new_port");
  assert.equal(treasure.verdict, "diversion");
  assert.equal(treasure.label, "is heading to a port it doesn't normally call at");
  assert.equal(out.length, pings.length, "a matched event adds no row");
  assert.equal(out.filter((p) => p.event?.id === "ev-01").length, 1, "one event attaches to one ping");
});

test("attachEvents: an event with no ping is appended as source 'event'", () => {
  const pings = dedupePings(flattenPings(ROWS, STORMS, SINCE));
  const out = attachEvents(pings, [PENDING_TREASURE, SIMULATED]);
  assert.equal(out.length, pings.length + 1);
  const sim = find(out, "Navigator of the Seas", "los-angeles");
  assert.ok(sim);
  assert.equal(sim.source, "event");
  assert.equal(sim.at, "2026-09-19T15:00:00.000Z");
  assert.equal(sim.cruise_line, "Royal Caribbean");
  assert.equal(sim.from_name, "Cabo San Lucas, Mexico");
  assert.equal(sim.to_name, "Los Angeles / San Pedro, CA");
  assert.equal(sim.verdict, "diversion");
  assert.equal(sim.event?.status, "ignored");
  assert.equal(sim.event?.ignored_at, "2026-09-19T15:20:00.000Z");
  assert.deepEqual(sim.storms, ["Gonzalo"]);
  assert.deepEqual(sim.dedup_keys, ["navigator of the seas|cabo-san-lucas|los-angeles|2026-09-19"]);
  const treasure = find(out, "Disney Treasure", "grand-cayman");
  assert.equal(treasure?.event?.status, "pending");
});

test("attachEvents: a folded two-storm ping joins an event keyed on EITHER storm's day", () => {
  const pings = dedupePings(flattenPings(ROWS, STORMS, SINCE));
  const gonzaloDay = event({
    id: "ev-03", ship_name: "MSC Seascape", kind: "rotation", from_slug: "cozumel", to_slug: "galveston",
    detected_at: "2026-09-23T01:15:00.000Z", status: "ignored",
  });
  assert.equal(gonzaloDay.dedup_key, "msc seascape|cozumel|galveston|2026-09-23");
  const out = attachEvents(pings, [gonzaloDay]);
  const folded = out.find((p) => p.ship_name === "MSC Seascape" && p.at === "2026-09-22T22:40:00.000Z");
  assert.equal(folded?.event?.id, "ev-03");
  assert.equal(out.length, pings.length);
});

// ── Ordering ─────────────────────────────────────────────────────────────────

test("the finished list is newest first end to end", () => {
  const out = attachEvents(dedupePings(flattenPings(ROWS, STORMS, SINCE)), [PENDING_TREASURE, SIMULATED]);
  const times = at(out).map((t) => Date.parse(t));
  for (let i = 1; i < times.length; i++) assert.ok(times[i - 1]! >= times[i]!, `row ${i} is older than row ${i - 1}`);
  assert.equal(out[0]?.ship_name, "Disney Treasure");
  assert.equal(out[out.length - 1]?.ship_name, "Carnival Sunrise");
  assert.equal(out.length, 6);
});

// ── verdictOf / pingLabel / clampDays ────────────────────────────────────────

test("verdictOf: reroute / new_port / order_change are diversions; swap, rotation, everything else", () => {
  assert.equal(verdictOf("reroute"), "diversion");
  assert.equal(verdictOf("new_port"), "diversion");
  assert.equal(verdictOf("order_change"), "diversion");
  assert.equal(verdictOf("itinerary_swap"), "swap");
  assert.equal(verdictOf("rotation"), "routine");
  assert.equal(verdictOf("unknown"), "unknown");
  assert.equal(verdictOf("legacy"), "unknown");
  assert.equal(verdictOf(null), "unknown");
  assert.equal(verdictOf(undefined), "unknown");
});

test("pingLabel: legacy has its own wording, every classifier kind keeps kindLabel's", () => {
  assert.match(pingLabel("legacy"), /before the 5 Sep detector/);
  assert.equal(pingLabel("reroute"), "re-routed mid-leg");
  assert.equal(pingLabel("rotation"), "moved to its next scheduled port");
  assert.equal(pingLabel("itinerary_swap"), "called its scheduled ports in a different order");
});

test("clampDays: 1..MAX_DAYS, whole days, anything unusable → the default", () => {
  assert.equal(DEFAULT_DAYS, 30);
  assert.equal(MAX_DAYS, 180);
  assert.equal(clampDays(undefined), DEFAULT_DAYS);
  assert.equal(clampDays(null), DEFAULT_DAYS);
  assert.equal(clampDays(""), DEFAULT_DAYS);
  assert.equal(clampDays("abc"), DEFAULT_DAYS);
  assert.equal(clampDays(0), DEFAULT_DAYS);
  assert.equal(clampDays(-5), DEFAULT_DAYS);
  assert.equal(clampDays(NaN), DEFAULT_DAYS);
  assert.equal(clampDays(Infinity), DEFAULT_DAYS);
  assert.equal(clampDays("7"), 7);
  assert.equal(clampDays(14.9), 14);
  assert.equal(clampDays(1), 1);
  assert.equal(clampDays(180), MAX_DAYS);
  assert.equal(clampDays(999), MAX_DAYS);
  assert.equal(clampDays(["90"]), 90, "express gives ?days=90 as a string; a repeated param arrives as an array");
});
