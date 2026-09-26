// nhc-forecast-track.test.ts — hurricanes pin by path (Mark, 2026-09-26). The
// fixtures are NHC's real Forecast/Advisory text for TD Fay and Hurricane
// Odalys, issued 26 Sep 2026 21Z.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parseForecastAdvisory, advisoryPath, advisoryTime, advisoryText, reachPoints } from "./nhc-forecast-track";
import { nearPath } from "./storm-sailings";

const FAY = `
886
WTNT21 KNHC 262037
TCMAT1

TROPICAL DEPRESSION FAY FORECAST/ADVISORY NUMBER  27
NWS NATIONAL HURRICANE CENTER MIAMI FL       AL062026
2100 UTC SAT SEP 26 2026

TROPICAL DEPRESSION CENTER LOCATED NEAR 29.8N  43.9W AT 26/2100Z
POSITION ACCURATE WITHIN  30 NM

PRESENT MOVEMENT TOWARD THE SOUTH OR 180 DEGREES AT   2 KT

ESTIMATED MINIMUM CENTRAL PRESSURE 1009 MB
MAX SUSTAINED WINDS  30 KT WITH GUSTS TO  40 KT.

REPEAT...CENTER LOCATED NEAR 29.8N  43.9W AT 26/2100Z
AT 26/1800Z CENTER WAS LOCATED NEAR 29.9N  43.9W

FORECAST VALID 27/0600Z 29.6N  43.9W
MAX WIND  30 KT...GUSTS  40 KT.

FORECAST VALID 27/1800Z 28.9N  44.0W
FORECAST VALID 28/0600Z 27.8N  44.0W
FORECAST VALID 28/1800Z 26.5N  44.6W
FORECAST VALID 29/0600Z 25.0N  45.8W
FORECAST VALID 29/1800Z 24.1N  47.4W

OUTLOOK VALID 30/1800Z 23.4N  51.3W...POST-TROP/REMNT LOW

OUTLOOK VALID 01/1800Z...DISSIPATED

NEXT ADVISORY AT 27/0300Z
$$
`;

const ODALYS = `
HURRICANE ODALYS FORECAST/ADVISORY NUMBER  19
NWS NATIONAL HURRICANE CENTER MIAMI FL       EP162026
2100 UTC SAT SEP 26 2026

HURRICANE CENTER LOCATED NEAR 20.5N 123.6W AT 26/2100Z
ESTIMATED MINIMUM CENTRAL PRESSURE  973 MB
MAX SUSTAINED WINDS  80 KT WITH GUSTS TO 100 KT.
REPEAT...CENTER LOCATED NEAR 20.5N 123.6W AT 26/2100Z
FORECAST VALID 27/0600Z 21.3N 123.5W
FORECAST VALID 27/1800Z 22.3N 123.2W
FORECAST VALID 28/0600Z 22.4N 122.9W
FORECAST VALID 28/1800Z 21.8N 122.5W...POST-TROP/REMNT LOW
FORECAST VALID 29/0600Z 20.7N 122.1W...POST-TROP/REMNT LOW
FORECAST VALID 29/1800Z 19.5N 121.9W...POST-TROP/REMNT LOW
OUTLOOK VALID 30/1800Z 18.2N 122.2W...POST-TROP/REMNT LOW
OUTLOOK VALID 01/1800Z...DISSIPATED
$$
`;

const NOW = new Date("2026-09-26T21:30:00Z");

test("Fay: centre, pressure, winds, seven dated points, and the dissipation flag", () => {
  const adv = parseForecastAdvisory(FAY, NOW)!;
  assert.ok(adv);
  assert.equal(adv.issuedAt, "2026-09-26T21:00:00.000Z");
  assert.equal(adv.centerLat, 29.8); assert.equal(adv.centerLon, -43.9);
  assert.equal(adv.centerAt, "2026-09-26T21:00:00.000Z");
  assert.equal(adv.pressureMb, 1009);
  assert.equal(adv.maxWindKt, 30);
  assert.equal(adv.points.length, 7);
  assert.deepEqual(adv.points[0], { kind: "forecast", validAt: "2026-09-27T06:00:00.000Z", lat: 29.6, lon: -43.9, note: null });
  assert.deepEqual(adv.points[6], { kind: "outlook", validAt: "2026-09-30T18:00:00.000Z", lat: 23.4, lon: -51.3, note: "POST-TROP/REMNT LOW" });
  assert.equal(adv.dissipates, true);
});

test("a day number that wraps into next month is dated correctly", () => {
  const issued = new Date("2026-09-30T21:00:00Z");
  assert.equal(advisoryTime(1, "1800", issued), "2026-10-01T18:00:00.000Z");
  assert.equal(advisoryTime(30, "0600", issued), "2026-09-30T06:00:00.000Z");
  assert.equal(advisoryTime(29, "1800", new Date("2026-12-31T21:00:00Z")), "2026-12-29T18:00:00.000Z");
  assert.equal(advisoryTime(2, "0000", new Date("2026-12-31T21:00:00Z")), "2027-01-02T00:00:00.000Z");
});

test("Odalys: a hurricane's track becomes a path — centre plus every forecast point inside the horizon", () => {
  const adv = parseForecastAdvisory(ODALYS, NOW)!;
  assert.equal(adv.pressureMb, 973); assert.equal(adv.maxWindKt, 80);
  const path = advisoryPath(adv, 120, NOW);
  assert.equal(path.length, 8, "centre + 7 points");
  assert.equal(path[0]!.kind, "low"); assert.equal(path[0]!.label, "973 mb");
  assert.equal(path[1]!.kind, "forecast");
  assert.ok(path[4]!.label?.includes("POST-TROP/REMNT LOW"));
  // A 44 h horizon (to 27/1730Z) keeps the centre and the three points through 28/0600Z… no:
  // 27/0600Z, 27/1800Z are inside; 28/0600Z (32.5 h) too; 28/1800Z (44.5 h) is out → centre + 3.
  assert.equal(advisoryPath(adv, 44, NOW).length, 4);
  // Odalys stays well west of the Mexican Riviera ports this week.
  assert.equal(nearPath(22.9, -109.9, path), null, "Cabo San Lucas is ~800 nm east of the track");
  assert.equal(nearPath(20.6, -105.2, path), null, "Puerto Vallarta");
  // …but a ship at 21N 120W would be inside it, and so is one 280 nm off the track:
  // tropical points reach 300 nm (Nolo passed ~270 nm from Honolulu under watches).
  assert.ok(nearPath(21.0, -120.0, path));
  assert.equal(path[0]!.reachNm, 300);
  assert.ok(nearPath(21.0, -117.0, path), "≈285 nm east of the track: in reach for a hurricane");
  assert.equal(nearPath(21.0, -117.0, path.map((p) => ({ ...p, reachNm: undefined }))), null, "…and out of reach at a nor'easter's 250 nm");
});

test("the .shtml page's <pre> block is the advisory; a page with neither centre nor points is null", () => {
  const page = `<html><body><pre>${FAY}</pre><p>footer</p></body></html>`;
  assert.equal(parseForecastAdvisory(page, NOW)!.points.length, 7);
  assert.equal(advisoryText("<pre>a &amp; b</pre>"), "a & b");
  assert.equal(parseForecastAdvisory("<html>nothing here</html>", NOW), null);
});

test("grounds are reached by the 12–72 h tropical points only; remnant-low and outlook points pin but do not threaten", () => {
  const fay = parseForecastAdvisory(FAY, NOW)!;
  assert.equal(reachPoints(fay).length, 6, "six FORECAST points, none noted; the remnant OUTLOOK point is out");
  const odalys = parseForecastAdvisory(ODALYS, NOW)!;
  assert.deepEqual(reachPoints(odalys), [{ lat: 21.3, lon: -123.5 }, { lat: 22.3, lon: -123.2 }, { lat: 22.4, lon: -122.9 }], "the three points before she goes post-tropical");
  assert.equal(advisoryPath(odalys).length, 8, "…while the path for pinning keeps every point");
});
