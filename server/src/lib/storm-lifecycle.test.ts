// storm-lifecycle.test.ts — death detection, diversion baselines, and the
// all-clear draft (Mark's storm-lifecycle design 2026-07-22).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  judgeDeath, draftAllClear, portSlugByName, allClearMode, MISSING_SCANS_TO_END, pinsToRelease, isLiveNamedThreat,
  manualStillOpen,
  type LifecycleAlertState,
} from "./storm-lifecycle";
import { newsItemMatchesStorm, extractWindow, parseRssItems } from "./storm-intel";

function alert(overrides: Partial<LifecycleAlertState> = {}): LifecycleAlertState {
  return { status: "sent", approved_at: "2026-07-20T03:44:00Z", missing_scans: 0, ...overrides };
}

// ── Death detection ──────────────────────────────────────────────────────────

test("present system resets the death counter", () => {
  assert.deepEqual(judgeDeath(alert({ missing_scans: 2 }), true, true), { kind: "seen" });
});

test("an unhealthy feed is never evidence of death (NHC outage ≠ dead storm)", () => {
  assert.deepEqual(judgeDeath(alert({ missing_scans: 2 }), false, false), { kind: "hold" });
});

test("absence counts up and ends the storm at the threshold", () => {
  assert.deepEqual(judgeDeath(alert({ missing_scans: 0 }), false, true), { kind: "count", missing: 1 });
  assert.deepEqual(judgeDeath(alert({ missing_scans: 1 }), false, true), { kind: "count", missing: 2 });
  const verdict = judgeDeath(alert({ missing_scans: MISSING_SCANS_TO_END - 1 }), false, true);
  assert.deepEqual(verdict, { kind: "end", allClear: true });
});

test("an alert never approved/sent ends quietly — no all-clear draft", () => {
  const verdict = judgeDeath(alert({ approved_at: null, missing_scans: 2 }), false, true);
  assert.deepEqual(verdict, { kind: "end", allClear: false });
});

// ── Port name → slug (knownExtra for the classifier) ────────────────────────

test("portSlugByName resolves gazetteer names and passes slugs through", () => {
  assert.equal(portSlugByName("Los Angeles / San Pedro, CA"), "los-angeles");
  assert.equal(portSlugByName("los-angeles"), "los-angeles");
  assert.equal(portSlugByName("Nowhere Harbour"), null);
  assert.equal(portSlugByName(null), null);
});

// ── All-clear mode (Mark 2026-09-05: autonomous unless the dev box says no) ──

test("all-clear is autonomous by default and gated only when explicitly disabled", () => {
  assert.equal(allClearMode({}), "auto");
  assert.equal(allClearMode({ DISABLE_STORM_ALLCLEAR_AUTOSEND: "1" }), "gated");
  assert.equal(allClearMode({ DISABLE_STORM_ALLCLEAR_AUTOSEND: "0" }), "auto");
});

// ── All-clear draft ──────────────────────────────────────────────────────────

test("all-clear draft names the storm and the grounds", () => {
  const d = draftAllClear({ name: "Bertha", classification: "Tropical Storm", affected_grounds: ["gulf"] });
  assert.match(d.headline, /All clear: Bertha/);
  assert.match(d.body_md, /Gulf of Mexico/);
  assert.match(d.body_md, /no longer being tracked/);
});

// ── Intel helpers ────────────────────────────────────────────────────────────

test("news matching requires the storm name plus a storm/cruise signal", () => {
  assert.equal(newsItemMatchesStorm(
    { title: "Carnival Cruise Line Sends Out Itinerary Change Advisory", description: "as Tropical Storm Bertha strengthens" },
    "Bertha",
  ), true);
  assert.equal(newsItemMatchesStorm(
    { title: "Bertha's Kitchen wins food award", description: "Charleston soul food institution" },
    "Bertha",
  ), false);
  assert.equal(newsItemMatchesStorm(
    { title: "Cruise line stock rallies", description: "no storms in sight" },
    "Bertha",
  ), false);
});

test("extractWindow returns surrounding context or null", () => {
  const text = "AAA ".repeat(300) + "Advisory for Tropical Storm Bertha: itinerary changes" + " ZZZ".repeat(300);
  const win = extractWindow(text, "Bertha");
  assert.ok(win && win.includes("Bertha"));
  assert.equal(extractWindow(text, "Fausto"), null);
});

test("parseRssItems pulls title/link from RSS", () => {
  const xml = `<rss><channel><item><title>Storm Bertha Update</title><link>https://x/y</link>
    <pubDate>Tue, 21 Jul 2026 12:00:00 +0000</pubDate><description><![CDATA[<p>Bertha news</p>]]></description></item></channel></rss>`;
  const items = parseRssItems(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Storm Bertha Update");
  assert.equal(items[0].link, "https://x/y");
  assert.equal(items[0].description, "Bertha news");
});

// ── Pins released when the grounds move (Nolo, 2026-09-25) ──────────────────

test("a pinned ship with no claim on the new grounds is released", () => {
  const pinned = ["navigator of the seas", "quantum of the seas", "pride of america"];
  const derived = ["Pride of America"];                 // the Hawaii sailing derived today
  const groundShips = ["Pride of America"];             // registry ships whose regions overlap "hawaii"
  assert.deepEqual(pinsToRelease(pinned, derived, groundShips), ["navigator of the seas", "quantum of the seas"]);
});

test("a ship still derived for the storm, or still in the grounds' registry, keeps her pin", () => {
  // Fay: an AIS-derived Bahamas sailing lapsed, but the ship's registry regions still overlap.
  assert.deepEqual(pinsToRelease(["utopia of the seas"], [], ["Utopia of the Seas"]), []);
  assert.deepEqual(pinsToRelease(["utopia of the seas"], ["Utopia of the Seas"], []), []);
});

test("names compare case-insensitively and nothing is released when nothing is pinned", () => {
  assert.deepEqual(pinsToRelease(["PRIDE OF AMERICA"], ["pride of america"], []), []);
  assert.deepEqual(pinsToRelease([], ["x"], ["y"]), []);
});

// ── Only a live named threat keeps its pins (2026-09-26) ─────────────────────

test("a positioned storm that threatens nowhere is not a live named threat, so its pins go", () => {
  assert.equal(isLiveNamedThreat({ is_threat: true, classification: "Tropical Storm" }), true);
  assert.equal(isLiveNamedThreat({ is_threat: true, classification: "Hurricane" }), true);
  assert.equal(isLiveNamedThreat({ is_threat: false, classification: "Tropical Storm" }), false); // Fay, Gonzalo after the grounds fix
  assert.equal(isLiveNamedThreat({ is_threat: true, classification: "Disturbance" }), false);     // outlook items never pin
  assert.equal(isLiveNamedThreat({ is_threat: true, classification: null }), false);
});

// 2026-09-26 — a storm Mark declares by hand is in no feed.
test("a hand-declared storm counts as seen until a day after its window, then dies like the rest", () => {
  const at = (iso: string) => new Date(iso);
  const row = { nhc_id: "MANUAL-mistral-20260926", window_end: "2026-09-30" };
  assert.equal(manualStillOpen(row, at("2026-09-27T12:00:00Z")), true);
  assert.equal(manualStillOpen(row, at("2026-10-01T12:00:00Z")), true, "grace day after the window");
  assert.equal(manualStillOpen(row, at("2026-10-02T12:00:00Z")), false);
  assert.equal(manualStillOpen({ nhc_id: "MANUAL-x", window_end: null }, at("2027-01-01T00:00:00Z")), true, "no window = open until dismissed");
  assert.equal(manualStillOpen({ nhc_id: "al062026", window_end: "2026-09-30" }, at("2026-09-27T12:00:00Z")), false, "only MANUAL ids");
  assert.equal(manualStillOpen({ nhc_id: "NWS-AT-20260926-38N72W", window_end: null }, at("2026-09-27T12:00:00Z")), false);
  // Gale Warning ranks 2: a hand-declared or NWS gale keeps its ships pinned.
  assert.equal(isLiveNamedThreat({ is_threat: true, classification: "Gale Warning" }), true);
  assert.equal(isLiveNamedThreat({ is_threat: true, classification: "Storm Warning" }), true);
});
