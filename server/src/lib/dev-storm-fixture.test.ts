// dev-storm-fixture.test.ts — the permanent test storm for the dev mirror (Mark 2026-10-12).
// The I/O half (ensureDevStormFixture) is proven by the dev sweep; these pin the rules around it.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  devStormFixtureEnabled, isDevFixtureAlert, isFixtureAlertRow, firstRealStorm, fixtureWindow, fixtureSailingRows, fixtureAlertRow, ensureDevStormFixture,
  FIXTURE_NHC_ID, FIXTURE_GROUND, FIXTURE_REGION, FIXTURE_SOURCE, FIXTURE_SHIPS,
} from "./dev-storm-fixture";
import { keepsPins, isLiveNamedThreat, manualStillOpen } from "./storm-lifecycle";
import { severityRank } from "./storm-escalation";
import { isMainstreamLine } from "./storm-sailings";
import { REGION_LABELS } from "./storm-grounds";

const DEV = { DEV_STORM_FIXTURE: "1", PUBLIC_URL: "http://178.156.154.144" };
const NOW = new Date("2026-10-12T12:00:00Z");

test("switch: off unless DEV_STORM_FIXTURE=1", () => {
  assert.equal(devStormFixtureEnabled({ PUBLIC_URL: "http://178.156.154.144" }), false);
  assert.equal(devStormFixtureEnabled({ DEV_STORM_FIXTURE: "0", PUBLIC_URL: "http://178.156.154.144" }), false);
  assert.equal(devStormFixtureEnabled(DEV), true);
});

test("switch: refuses the production site, with or without www, a port or a path, and an unknown address", () => {
  for (const url of ["https://stillafloatcruising.com", "https://www.stillafloatcruising.com/", "http://stillafloatcruising.com:443", "", undefined]) {
    assert.equal(devStormFixtureEnabled({ DEV_STORM_FIXTURE: "1", PUBLIC_URL: url }), false, String(url));
  }
});

test("only the fixture's own alert answers to the fixture, and only on a dev box with it switched on", () => {
  const mine = { raw: { source: FIXTURE_SOURCE } };
  assert.equal(isDevFixtureAlert(mine, DEV), true);
  assert.equal(isDevFixtureAlert(mine, { PUBLIC_URL: "http://178.156.154.144" }), false);
  assert.equal(isDevFixtureAlert(mine, { DEV_STORM_FIXTURE: "1", PUBLIC_URL: "https://stillafloatcruising.com" }), false);
  assert.equal(isDevFixtureAlert({ raw: { source: "nhc" } }, DEV), false);
  assert.equal(isDevFixtureAlert({ raw: null }, DEV), false);
  assert.equal(isDevFixtureAlert({}, DEV), false);
});

test("the three ships' sailing straddles today, is far inside the 120-day sanity limit, and can never match a real storm's grounds", () => {
  const w = fixtureWindow(NOW);
  assert.equal(w.start, "2026-10-10");
  assert.equal(w.end, "2026-10-22");
  const rows = fixtureSailingRows(NOW);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.ship_name), ["MSC Meraviglia", "MSC Seashore", "MSC Seascape"]);
  for (const r of rows) {
    assert.equal(r.source, FIXTURE_SOURCE);
    assert.equal(r.active, true);
    assert.deepEqual(r.regions, [FIXTURE_REGION]);
    assert.equal(Object.keys(REGION_LABELS).includes(FIXTURE_REGION), false, "a region no real storm uses");
    assert.ok(Date.parse(r.start_date) <= NOW.getTime() && Date.parse(r.end_date) >= NOW.getTime());
    assert.ok((Date.parse(r.end_date) - Date.parse(r.start_date)) / 86_400_000 < 120);
  }
});

test("the dates roll: a month later the sailing still straddles 'today'", () => {
  const later = new Date("2026-11-12T03:00:00Z");
  const w = fixtureWindow(later);
  assert.ok(Date.parse(w.start) <= later.getTime() && Date.parse(w.end) >= later.getTime());
});

test("every fixture ship is on a mainstream line (storm pages show mainstream lines only, Mark 2026-10-09)", () => {
  for (const s of FIXTURE_SHIPS) assert.equal(isMainstreamLine(s.line), true, s.name);
});

test("the alert: a hand-declared, already-sent, still-a-threat storm that never ends on its own", () => {
  const a = fixtureAlertRow(NOW);
  assert.equal(a.nhc_id, FIXTURE_NHC_ID);
  assert.ok(a.nhc_id.startsWith("MANUAL-"));
  assert.equal(a.status, "sent");
  assert.equal(a.is_threat, true);
  assert.equal(a.window_start, null);
  assert.equal(a.window_end, null);
  assert.equal(manualStillOpen(a, new Date("2030-01-01T00:00:00Z")), true, "no window = open until dismissed");
  assert.ok(a.approved_at && a.sent_at, "inserted already sent, so nothing ever emails anyone");
  assert.equal(a.sent_count, 0);
  assert.deepEqual(a.affected_grounds, [FIXTURE_GROUND]);
  assert.ok(Object.keys(REGION_LABELS).includes(FIXTURE_GROUND), "a real ground, so the pages can label it");
});

test("the alert pins ships but never reaches the paid intel sweep", () => {
  const a = fixtureAlertRow(NOW);
  assert.equal(isLiveNamedThreat(a), true);
  assert.equal(keepsPins(a), true);
  assert.ok(severityRank(a.classification) < 3, "storm-intel only reads Tropical Storm and up");
});

test("both languages carry a headline, a body, and a 'what this means for you' paragraph worth reading; the test is labelled on its face", () => {
  const a = fixtureAlertRow(NOW);
  for (const [head, body, label] of [[a.headline, a.body_md, /What this means/], [a.headline_es, a.body_md_es, /Lo que esto significa/]] as const) {
    assert.ok(head.length > 20);
    assert.match(body, label);
    const blocks = body.split(/\n{2,}/);
    assert.ok(blocks.length >= 2 && blocks.every((b) => b.trim().length >= 40));
  }
  assert.match(a.headline, /test/i);
  assert.match(a.headline_es, /prueba/i);
  assert.match(a.body_md, /not real weather/i);
});

test("with the switch off, keeping the fixture alive touches nothing", async () => {
  const was = process.env["DEV_STORM_FIXTURE"];
  delete process.env["DEV_STORM_FIXTURE"];
  try { assert.equal(await ensureDevStormFixture(NOW), "off"); }
  finally { if (was !== undefined) process.env["DEV_STORM_FIXTURE"] = was; }
});

test("a client's journey never hears of the dev test storm: the fixture alert is skipped wherever it is read, a real storm behind it is kept", () => {
  const fixture = { ...fixtureAlertRow(new Date("2026-10-19T12:00:00Z")), id: "f1" };
  assert.equal(isFixtureAlertRow(fixture), true);
  assert.equal(isFixtureAlertRow({ nhc_id: "AL052026", raw: {} }), false);
  assert.equal(isFixtureAlertRow({ nhc_id: "x", raw: { source: FIXTURE_SOURCE } }), true, "marked by its source even if the id changed");
  assert.equal(isFixtureAlertRow(null), false);
  // the fixture is refreshed constantly, so it is always the newest: the real storm after it must still be found
  assert.equal(firstRealStorm([fixture]), null);
  assert.deepEqual(firstRealStorm([fixture, { nhc_id: "AL052026", raw: {}, name: "Gonzalo", classification: "Tropical Storm", headline: "Gonzalo nears the Bahamas" }]),
    { name: "Gonzalo", classification: "Tropical Storm", headline: "Gonzalo nears the Bahamas" });
  assert.equal(firstRealStorm([]), null);
  // the same on a box with the fixture switched off: the row is still not real weather
  assert.equal(devStormFixtureEnabled({ DEV_STORM_FIXTURE: "0", PUBLIC_URL: "https://stillafloatcruising.com" }), false);
  assert.equal(isFixtureAlertRow(fixture), true);
});
