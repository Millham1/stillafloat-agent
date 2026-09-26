// nws-marine-source.test.ts — nor'easters and Pacific storms from NWS marine
// products (Mark, 2026-09-26). The text fixtures are the real OPC High Seas
// Forecast and WPC bulletin lines from 26 Sep 2026 15Z, the day after the
// nor'easter that the NHC-only scanner never saw.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseHighSeasLows, parseCodedLows, parseMarineAlerts, buildMarineSystems, matchPrior, galeQualifies,
  stormName, geometryCentroid, nmBetween, withRegions,
  type MarineWarning, type ZoneInfo, type HighSeasLow, type PriorMarineAlert,
} from "./nws-marine-source";
import { severityRank } from "./storm-escalation";

const HSF_AT1 = `
.WARNINGS.

...STORM WARNING...
.LOW 38N72W 986 MB DRIFTING N 05 KT. WITHIN 180 NM W AND 240 NM N
QUADRANTS WINDS 40 TO 55 KT. SEAS 4 TO 9 M...HIGHEST NEAR 38N73W.
ELSEWHERE WITHIN 180 NM SE SEMICIRCLE...AND WITHIN 180 NM NW OF A
FRONT FROM 39N72W TO 41N65W...WINDS 30 TO 45 KT. SEAS 3 TO 8
M...HIGHEST IN S QUADRANT OF LOW.
.24 HOUR FORECAST LOW 41N73W 989 MB. FROM 39N TO 44N BETWEEN 69W
AND 75W WINDS 25 TO 40 KT. SEAS 3 TO 5 M.
.48 HOUR FORECAST LOW INLAND 40N74W 1002 MB. FROM 42N TO 48N
BETWEEN W OF 50W...AND WITHIN 360 NM SE QUADRANT WINDS 20 TO 30
KT. SEAS TO 3.5 M.

...GALE WARNING...
.LOW E OF AREA 57N30W 987 MB MOVING NE 25 KT. WITHIN 600 NM S AND
540 NM W QUADRANTS WINDS 25 TO 35 KT. SEAS 3 TO 6 M.
.24 HOUR FORECAST LOW E OF AREA 60N25W 985 MB.

...GALE WARNING...
.LOW 41N50W 1010 MB MOVING E 15 KT. FROM 38N TO 43N BETWEEN 45W
AND 52W WINDS 25 TO 35 KT. SEAS 3 TO 5 M.
.24 HOUR FORECAST LOW 40N39W 1005 MB. FROM 35N TO 41N E OF 42W
WINDS 25 TO 35 KT.

.SYNOPSIS AND FORECAST.
.LOW 38N72W 986 MB — repeated in the synopsis, must not be parsed twice.

.WARNINGS.

...HURRICANE WARNING...
.HURRICANE POLO NEAR 17.9N 111.7W 928 MB AT 1500 UTC SEP 26 MOVING
W 6 KT. WITHIN 30 NM OF CENTER WINDS 110 TO 130 KT.
$$
`;

const HSF_EP1 = `
.WARNINGS.

...GALE WARNING...
.LOW 57N168W 973 MB MOVING NE 15 KT. BETWEEN 60 NM AND 360 NM SE
AND S QUADRANTS WINDS 35 TO 45 KT. SEAS 4.5 TO 7 M.
.24 HOUR FORECAST LOW 59N159W 982 MB. BETWEEN 120 NM AND 480 NM
SE AND S QUADRANTS WINDS 25 TO 35 KT. SEAS 3 TO 5.5 M.
.48 HOUR FORECAST COMPLEX LOW WITH MAIN CENTER NEAR 58N150W 989
MB. BETWEEN 180 NM AND 780 NM SW QUADRANT WINDS 25 TO 35 KT.

...GALE WARNING...
.LOW PRES...INVEST EP90...NEAR 12N98W 1008 MB. WITHIN 14N96W TO
16N100W WINDS 20 TO 30 KT. SEAS 2 TO 3 M.
$$
`;

const CODSUS = `ASUS30 KWNP 261554
CODSUS
CODED SURFACE FRONTAL POSITIONS
NWS WEATHER PREDICTION CENTER COLLEGE PARK MD
VALID 092615Z
HIGHS 1025 38107 1020 36112 1028 5082
LOWS 1014 37111 1010 34119 991 58110 998 59149 986 3872 1009 3044 1006 6573
STNRY 33119 31120 30122
COLD 37116 35116 34117
$$`;

const NOW = new Date("2026-09-26T16:00:00Z");

function alertsJson(list: Array<{ id: string; event: string; sender: string; area: string; onset: string; ends: string; zones: string[] }>) {
  return {
    features: list.map((a) => ({
      id: a.id,
      properties: {
        id: a.id, event: a.event, senderName: a.sender, areaDesc: a.area, onset: a.onset, ends: a.ends,
        geocode: { UGC: a.zones },
        affectedZones: a.zones.map((z) => `https://api.weather.gov/zones/forecast/${z}`),
      },
    })),
  };
}

// Zone centroids as api.weather.gov reports them (26 Sep 2026).
const ZONES = new Map<string, ZoneInfo>([
  ["https://api.weather.gov/zones/forecast/ANZ450", { regions: ["us_east_coast"], lat: 40.3, lon: -73.9 }],   // Sandy Hook–Manasquan
  ["https://api.weather.gov/zones/forecast/ANZ800", { regions: ["canada_new_england"], lat: 42.8, lon: -68.35 }], // Gulf of Maine
  ["https://api.weather.gov/zones/forecast/PKZ652", { regions: ["alaska"], lat: 59.92, lon: -142.65 }],       // Icy Cape–Cape Suckling
  ["https://api.weather.gov/zones/forecast/PKZ414", { regions: [], lat: 56.77, lon: -169.28 }],               // Bering Sea offshore
]);

const NORE_STORM = { id: "w-phi-sr", event: "Storm Warning", sender: "NWS Mount Holly NJ", area: "Coastal waters from Sandy Hook to Manasquan Inlet NJ out 20 NM", onset: "2026-09-26T13:29:00-04:00", ends: "2026-09-27T12:00:00-04:00", zones: ["ANZ450"] };
const MAINE_GALE_LONG = { id: "w-opc-gl", event: "Gale Warning", sender: "NWS Ocean Prediction Center", area: "Gulf of Maine to the Hague Line", onset: "2026-09-26T06:00:00Z", ends: "2026-09-27T18:00:00Z", zones: ["ANZ800"] };
const AK_GALE = { id: "w-afc-gl", event: "Gale Warning", sender: "NWS Anchorage AK", area: "Icy Cape to Cape Suckling out to 15 NM", onset: "2026-09-26T09:00:00Z", ends: "2026-09-27T21:00:00Z", zones: ["PKZ652"] };
const BERING_GALE = { id: "w-bering", event: "Gale Warning", sender: "NWS Anchorage AK", area: "Bering Sea Offshore East of 171W", onset: "2026-09-26T09:00:00Z", ends: "2026-09-28T09:00:00Z", zones: ["PKZ414"] };

// ── parsers ─────────────────────────────────────────────────────────────────

test("High Seas Forecast: the nor'easter low, its grade, movement, winds and forecast track", () => {
  const lows = parseHighSeasLows(HSF_AT1, "atlantic");
  assert.equal(lows.length, 3, "three non-tropical lows; Polo's hurricane block and the synopsis are skipped");
  const ne = lows[0]!;
  assert.equal(ne.grade, 2);
  assert.equal(ne.lat, 38); assert.equal(ne.lon, -72);
  assert.equal(ne.pressureMb, 986);
  assert.equal(ne.movement, "N at 5 kt");
  assert.equal(ne.winds, "40–55 kt");
  assert.equal(ne.seas, "4–9 m");
  assert.deepEqual(ne.forecast24, { lat: 41, lon: -73, pressureMb: 989 });
  assert.deepEqual(ne.forecast48, { lat: 40, lon: -74, pressureMb: 1002 });
  const greenland = lows[1]!;
  assert.equal(greenland.grade, 1);
  assert.equal(greenland.pressureMb, 987);
  assert.equal(greenland.movement, "NE at 25 kt");
  assert.deepEqual(greenland.forecast24, { lat: 60, lon: -25, pressureMb: 985 });
  assert.equal(lows[2]!.pressureMb, 1010);
});

test("High Seas Forecast (Pacific): the Bering Sea gale low and TAFB's invest line", () => {
  const lows = parseHighSeasLows(HSF_EP1, "pacific");
  assert.equal(lows.length, 2);
  assert.equal(lows[0]!.pressureMb, 973);
  assert.deepEqual(lows[0]!.forecast24, { lat: 59, lon: -159, pressureMb: 982 });
  assert.deepEqual(lows[0]!.forecast48, { lat: 58, lon: -150, pressureMb: 989 });
  assert.equal(lows[1]!.pressureMb, 1008);
  assert.equal(lows[1]!.lat, 12); assert.equal(lows[1]!.lon, -98);
});

test("a forecast line that ends in a period is not a section break: the next low in the same block still parses", () => {
  const block = `
.WARNINGS.

...GALE WARNING...
.LOW 59N150W 998 MB MOVING NE 10 KT THEN DISSIPATING INLAND. NE
SEMICIRCLE WINDS 35 TO 45 KT. SEAS 4 TO 6 M.
.24 HOUR FORECAST CONDITIONS DESCRIBED WITH GALE WARNING ABOVE.
.48 HOUR FORECAST CONDITIONS DESCRIBED WITH GALE WARNING ABOVE.
.LOW 52N140W 990 MB MOVING E 20 KT. WITHIN 300 NM S QUADRANT WINDS
35 TO 45 KT. SEAS 5 TO 7 M.
.24 HOUR FORECAST LOW 53N130W 992 MB.

.SYNOPSIS AND FORECAST.
.LOW 52N140W 990 MB — synopsis copy, not a warning block.
$$
`;
  const lows = parseHighSeasLows(block, "pacific");
  assert.deepEqual(lows.map((l) => [l.lat, l.lon, l.pressureMb, l.grade]), [[59, -150, 998, 1], [52, -140, 990, 1]]);
  assert.equal(lows[0]!.forecast24, null, "a forecast with no position is null, not a crash");
  assert.deepEqual(lows[1]!.forecast24, { lat: 53, lon: -130, pressureMb: 992 });
});

test("WPC coded bulletin: every low with its pressure, 4- and 5-digit positions", () => {
  const lows = parseCodedLows(CODSUS);
  assert.equal(lows.length, 7);
  assert.deepEqual(lows.find((l) => l.pressureMb === 986), { lat: 38, lon: -72, pressureMb: 986 });
  assert.deepEqual(lows.find((l) => l.pressureMb === 991), { lat: 58, lon: -110, pressureMb: 991 });
  assert.deepEqual(lows.find((l) => l.pressureMb === 1009), { lat: 30, lon: -44, pressureMb: 1009 });
  assert.deepEqual(parseCodedLows("VALID 092615Z\nHIGHS 1025 38107\n$$"), []);
});

test("alerts API: only the three marine grades, with zones and zone URLs", () => {
  const ws = parseMarineAlerts(alertsJson([NORE_STORM, MAINE_GALE_LONG, { ...AK_GALE, id: "x", event: "Small Craft Advisory" }]));
  assert.equal(ws.length, 2);
  assert.equal(ws[0]!.grade, 2);
  assert.deepEqual(ws[0]!.zones, ["ANZ450"]);
  assert.deepEqual(ws[0]!.zoneUrls, ["https://api.weather.gov/zones/forecast/ANZ450"]);
  assert.equal(ws[1]!.grade, 1);
  assert.deepEqual(parseMarineAlerts({}), []);
  assert.deepEqual(parseMarineAlerts(null), []);
});

test("zone centroid and distance helpers", () => {
  const c = geometryCentroid({ type: "Polygon", coordinates: [[[-74, 40], [-73, 40], [-73, 41], [-74, 41], [-74, 40]]] });
  assert.deepEqual(c, { lat: 40.4, lon: -73.6 });
  assert.equal(geometryCentroid(null), null);
  assert.ok(Math.abs(nmBetween(38, -72, 41, -73) - 183) < 3, "38N72W → 41N73W is ~183 nm");
});

// ── the rules ───────────────────────────────────────────────────────────────

test("the nor'easter: storm-grade low off New Jersey becomes ONE Nor'easter alert over the East Coast and Canada/New England", () => {
  const lows = parseHighSeasLows(HSF_AT1, "atlantic");
  const { systems, ignoredGales } = buildMarineSystems({
    warnings: parseMarineAlerts(alertsJson([NORE_STORM, MAINE_GALE_LONG])),
    lows, codedLows: parseCodedLows(CODSUS), zones: ZONES, prior: [], now: NOW,
  });
  assert.equal(systems.length, 1, JSON.stringify(systems.map((s) => s.nhcId)));
  const s = systems[0]!;
  assert.equal(s.name, "Nor'easter");
  assert.equal(s.classification, "Storm Warning");
  assert.equal(severityRank(s.classification), 3, "ranks like a tropical storm, so ships get pinned");
  assert.equal(s.source, "nws_marine");
  assert.equal(s.nhcId, "NWS-AT-20260926-38N72W");
  assert.deepEqual([...(s.grounds ?? [])].sort(), ["canada_new_england", "us_east_coast"]);
  assert.equal(s.intensity, "986 mb, winds 40–55 kt");
  assert.equal(s.movement, "N at 5 kt");
  assert.equal(s.lat, 38); assert.equal(s.lon, -72);
  assert.equal(s.pressureMb, 986);
  assert.ok(s.coneUrl?.includes("A_full_00hrsfc"), "OPC Atlantic surface analysis stands in for the NHC cone");
  assert.ok(s.satelliteUrl?.includes("/ne/"), "GOES-East Northeast sector");
  assert.ok((s.outlookText ?? "").includes("Storm Warning: Mount Holly NJ"), s.outlookText);
  assert.equal(ignoredGales, 0, "the Gulf of Maine gale attached to the nor'easter");
  const path = (s.raw as { path: Array<{ kind: string; lat: number; lon: number }> }).path;
  assert.deepEqual(path.slice(0, 3).map((p) => [p.kind, p.lat, p.lon]), [["low", 38, -72], ["f24", 41, -73], ["f48", 40, -74]]);
  assert.deepEqual(path.filter((p) => p.kind === "zone").map((p) => [p.lat, p.lon]), [[40.3, -73.9], [42.8, -68.35]], "the warned waters ride along for path-based pinning");
  // The mid-Atlantic gales (41N50W, 57N30W) reach no cruising ground and the
  // 986 mb low is not double-counted from the WPC bulletin.
  assert.equal(systems.filter((x) => x.name !== "Nor'easter").length, 0);
});

test("a Bering Sea 973 mb low is nobody's storm until its forecast brings it into the Gulf of Alaska with a gale on the coast", () => {
  const lows = parseHighSeasLows(HSF_EP1, "pacific");
  // Only the Bering offshore gale: outside every ground → nothing.
  let out = buildMarineSystems({ warnings: parseMarineAlerts(alertsJson([BERING_GALE])), lows, codedLows: [], zones: ZONES, prior: [], now: NOW });
  assert.equal(out.systems.length, 0);
  // A gale on the Gulf of Alaska coast within reach of the 24 h position, low ≤ 990 mb → event.
  out = buildMarineSystems({ warnings: parseMarineAlerts(alertsJson([AK_GALE, BERING_GALE])), lows, codedLows: [], zones: ZONES, prior: [], now: NOW });
  assert.equal(out.systems.length, 1);
  const s = out.systems[0]!;
  assert.equal(s.name, "Gulf of Alaska storm");
  assert.equal(s.classification, "Storm Warning", "973 mb is under the 980 mb backstop, so it grades as a storm");
  assert.deepEqual(s.grounds, ["alaska"]);
  assert.equal(s.basin, "eastern_pacific");
  assert.ok(s.satelliteUrl?.includes("/ak/"));
  assert.equal(s.nhcId, "NWS-PA-20260926-57N168W");
});

test("an invest off Mexico in TAFB's gale block is NHC's business: no NWS zones, 1008 mb → silent", () => {
  const lows = parseHighSeasLows(HSF_EP1, "pacific").filter((l) => l.pressureMb === 1008);
  const out = buildMarineSystems({ warnings: [], lows, codedLows: [], zones: ZONES, prior: [], now: NOW });
  assert.equal(out.systems.length, 0);
});

test("a short gale with no low behind it is weather, not a storm; a storm warning with no low is an event for its region", () => {
  const shortGale = { ...MAINE_GALE_LONG, id: "short", onset: "2026-09-26T06:00:00Z", ends: "2026-09-26T18:00:00Z" };
  let out = buildMarineSystems({ warnings: parseMarineAlerts(alertsJson([shortGale])), lows: [], codedLows: [], zones: ZONES, prior: [], now: NOW });
  assert.equal(out.systems.length, 0);
  assert.equal(out.ignoredGales, 1);
  out = buildMarineSystems({ warnings: parseMarineAlerts(alertsJson([NORE_STORM])), lows: [], codedLows: [], zones: ZONES, prior: [], now: NOW });
  assert.equal(out.systems.length, 1);
  assert.equal(out.systems[0]!.nhcId, "NWS-AT-20260926-us_east_coast");
  assert.equal(out.systems[0]!.classification, "Storm Warning");
  assert.equal((out.systems[0]!.raw as { kind: string }).kind, "region");
});

test("gale qualification: 24 h+ or a deep low", () => {
  assert.equal(galeQualifies({ durationH: 30 }, null), true);
  assert.equal(galeQualifies({ durationH: 12 }, null), false);
  assert.equal(galeQualifies({ durationH: 12 }, 988), true);
  assert.equal(galeQualifies({ durationH: null }, 995), false);
});

test("the 980 mb backstop: a bomb low in the WPC bulletin with no warning yet still files", () => {
  const out = buildMarineSystems({
    warnings: [], lows: [], codedLows: [{ lat: 36, lon: -74, pressureMb: 976 }], zones: ZONES, prior: [], now: NOW,
  });
  assert.equal(out.systems.length, 1);
  assert.equal(out.systems[0]!.classification, "Storm Warning");
  assert.equal(out.systems[0]!.name, "Nor'easter");
  assert.equal(out.systems[0]!.pressureMb, 976);
  // …but not a 990 mb ordinary low.
  assert.equal(buildMarineSystems({ warnings: [], lows: [], codedLows: [{ lat: 36, lon: -74, pressureMb: 990 }], zones: ZONES, prior: [], now: NOW }).systems.length, 0);
});

test("an unknown zone (fetch failed this scan) contributes no region, so nothing is invented", () => {
  const ws = withRegions(parseMarineAlerts(alertsJson([NORE_STORM])), new Map());
  assert.deepEqual(ws[0]!.regions, []);
  const out = buildMarineSystems({ warnings: parseMarineAlerts(alertsJson([NORE_STORM])), lows: [], codedLows: [], zones: new Map(), prior: [], now: NOW });
  assert.equal(out.systems.length, 0);
});

// ── identity ────────────────────────────────────────────────────────────────

test("continuity: the same low three hours later keeps its nhc_id; a low across the ocean does not", () => {
  const prior: PriorMarineAlert[] = [{
    nhc_id: "NWS-AT-20260925-37N73W", status: "draft", last_updated: "2026-09-26T13:00:00Z",
    raw: { kind: "low", lat: 37.2, lon: -73.4, forecast24: { lat: 40, lon: -73, pressureMb: 988 }, regions: ["us_east_coast"] },
  }];
  const lows = parseHighSeasLows(HSF_AT1, "atlantic");
  const out = buildMarineSystems({ warnings: parseMarineAlerts(alertsJson([NORE_STORM])), lows, codedLows: [], zones: ZONES, prior, now: NOW });
  assert.equal(out.systems[0]!.nhcId, "NWS-AT-20260925-37N73W");

  const far: PriorMarineAlert[] = [{ nhc_id: "NWS-AT-20260920-45N40W", status: "sent", last_updated: "2026-09-26T13:00:00Z", raw: { kind: "low", lat: 45, lon: -40, regions: ["bermuda"] } }];
  const used = new Set<string>();
  assert.equal(matchPrior({ lat: 38, lon: -72, grounds: ["us_east_coast"], kind: "low" }, far, NOW, used), null);

  const stale: PriorMarineAlert[] = [{ ...prior[0]!, last_updated: "2026-09-23T13:00:00Z" }];
  assert.equal(matchPrior({ lat: 38, lon: -72, grounds: ["us_east_coast"], kind: "low" }, stale, NOW, new Set()), null, "older than 48 h is a new storm");
});

test("continuity via the 24 h forecast position, and a prior alert is claimed once", () => {
  const prior: PriorMarineAlert[] = [{
    nhc_id: "NWS-AT-20260925-33N75W", status: "sent", last_updated: "2026-09-26T04:00:00Z",
    raw: { kind: "low", lat: 33, lon: -75, forecast24: { lat: 38.5, lon: -72.5, pressureMb: 985 }, regions: ["us_east_coast"] },
  }];
  const used = new Set<string>();
  const a = matchPrior({ lat: 38, lon: -72, grounds: ["us_east_coast"], kind: "low" }, prior, NOW, used);
  assert.equal(a?.nhc_id, "NWS-AT-20260925-33N75W");
  const b = matchPrior({ lat: 38.2, lon: -72.1, grounds: ["us_east_coast"], kind: "low" }, prior, NOW, used);
  assert.equal(b, null, "a second low the same scan cannot take the same alert");
});

test("region-only events continue by region, and continue a low-based alert the High Seas text stopped naming", () => {
  const prior: PriorMarineAlert[] = [{ nhc_id: "NWS-AT-20260925-us_east_coast", status: "draft", last_updated: "2026-09-26T13:00:00Z", raw: { kind: "region", regions: ["us_east_coast"] } }];
  let out = buildMarineSystems({ warnings: parseMarineAlerts(alertsJson([NORE_STORM])), lows: [], codedLows: [], zones: ZONES, prior, now: NOW });
  assert.equal(out.systems[0]!.nhcId, "NWS-AT-20260925-us_east_coast");

  const lowPrior: PriorMarineAlert[] = [{ nhc_id: "NWS-AT-20260925-38N72W", status: "sent", last_updated: "2026-09-26T13:00:00Z", raw: { kind: "low", lat: 39, lon: -73, regions: ["us_east_coast", "canada_new_england"] } }];
  out = buildMarineSystems({ warnings: parseMarineAlerts(alertsJson([NORE_STORM])), lows: [], codedLows: [], zones: ZONES, prior: lowPrior, now: NOW });
  assert.equal(out.systems[0]!.nhcId, "NWS-AT-20260925-38N72W", "the zone warnings off New Jersey are still that storm");

  const farLowPrior: PriorMarineAlert[] = [{ nhc_id: "NWS-AT-20260925-30N60W", status: "sent", last_updated: "2026-09-26T13:00:00Z", raw: { kind: "low", lat: 30, lon: -60, regions: ["us_east_coast", "bermuda"] } }];
  out = buildMarineSystems({ warnings: parseMarineAlerts(alertsJson([NORE_STORM])), lows: [], codedLows: [], zones: ZONES, prior: farLowPrior, now: NOW });
  assert.equal(out.systems[0]!.nhcId, "NWS-AT-20260926-us_east_coast", "a low 800 nm away is a different storm");
});

test("names follow the grounds", () => {
  assert.equal(stormName(["us_east_coast"], "atlantic"), "Nor'easter");
  assert.equal(stormName(["canada_new_england"], "atlantic"), "Nor'easter");
  assert.equal(stormName(["gulf"], "atlantic"), "Gulf storm");
  assert.equal(stormName(["bahamas", "gulf"], "atlantic"), "Atlantic storm");
  assert.equal(stormName(["alaska"], "pacific"), "Gulf of Alaska storm");
  assert.equal(stormName(["hawaii"], "pacific"), "Pacific storm");
});

test("the ladder: gale pins ships, storm outranks it, hurricane force outranks both", () => {
  assert.equal(severityRank("Gale Warning"), 2);
  assert.equal(severityRank("Storm Warning"), 3);
  assert.equal(severityRank("Hurricane Force Wind Warning"), 4);
});

// Type-only usage so the imports stay honest under noUnusedLocals.
const _typeCheck: HighSeasLow["basin"] = "atlantic";
const _w: MarineWarning | null = null;
void _typeCheck; void _w;
