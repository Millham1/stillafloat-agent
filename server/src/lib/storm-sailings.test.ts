// storm-sailings.test.ts — the "Track this ship" sign-up link only goes beside a ship the
// tracker knows. It carries no dates: a storm-page watch runs 15 days from when it starts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withTrackable, type Sailing } from "./storm-sailings";

const sailing = (ship_name: string, start_date = "2026-09-15", end_date = "2026-09-20"): Sailing => ({
  ship_name, cruise_line: "Carnival", depart_port: "Miami", start_date, end_date, regions: ["bahamas"],
});

describe("withTrackable", () => {
  it("marks each sailing by whether Where's My Ship can open that ship, keeping every other field and adding nothing else", () => {
    const registry = new Set(["carnival panorama", "navigator of the seas"]);
    const out = withTrackable(
      [sailing("Carnival Panorama"), sailing("Navigator of the Seas"), sailing("A Ship We Do Not Track"), sailing("")],
      (name) => registry.has(name.toLowerCase()),
    );
    assert.deepEqual(out.map((s) => [s.ship_name, s.trackable]), [
      ["Carnival Panorama", true],
      ["Navigator of the Seas", true],
      ["A Ship We Do Not Track", false],
      ["", false],
    ]);
    assert.deepEqual(out[0], { ...sailing("Carnival Panorama"), trackable: true });
    assert.deepEqual(out[2], { ...sailing("A Ship We Do Not Track"), trackable: false });
  });

  it("links a ship whatever its listed dates, since the watch does not use them", () => {
    const [season, underWay] = withTrackable([
      sailing("Seasonal Deployment", "2026-05-01", "2026-10-31"),
      sailing("Under Way", "2026-09-10", "2026-09-17"),
    ], () => true);
    assert.deepEqual([season!.trackable, underWay!.trackable], [true, true]);
  });

  it("gives no links at all when the registry has not loaded", () => {
    assert.deepEqual(withTrackable([sailing("Carnival Panorama")], () => false).map((s) => s.trackable), [false]);
  });
});

// 2026-09-26 — published itineraries (planned_sailings) decide impacted ships
// for grounds the hand-kept tables never tagged (Canada/New England, Alaska).
import { test } from "node:test";
import { plannedRowsInGrounds, type PlannedSailingRow, type PortLocator } from "./storm-sailings";

const PORTS: Record<string, { lat: number; lon: number }> = {
  boston: { lat: 42.36, lon: -71.06 }, halifax: { lat: 44.65, lon: -63.57 }, "new-york": { lat: 40.7, lon: -74.0 },
  miami: { lat: 25.77, lon: -80.19 }, cozumel: { lat: 20.5, lon: -86.95 }, juneau: { lat: 58.3, lon: -134.4 },
};
const locate: PortLocator = (p) => (p.slug && PORTS[p.slug]) || (typeof p.lat === "number" && typeof p.lon === "number" ? { lat: p.lat, lon: p.lon } : null);
const row = (ship: string, start: string, slugs: string[], extra: Partial<PlannedSailingRow> = {}): PlannedSailingRow => ({
  ship_name: ship, operator: "Norwegian", source: "cruisemapper", start_date: start, end_date: null,
  ports: slugs.map((slug) => ({ name: slug, slug })), ...extra,
});

test("a sailing with a port in the storm's grounds is impacted; one without is not", () => {
  const out = plannedRowsInGrounds([
    row("Norwegian Escape", "2026-09-20", ["new-york", "halifax", "boston", "new-york"], { end_date: "2026-09-27" }),
    row("Norwegian Getaway", "2026-09-22", ["miami", "cozumel", "miami"]),
  ], ["canada_new_england"], locate);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.ship_name, "Norwegian Escape");
  assert.deepEqual(out[0]!.regions, ["canada_new_england"]);
  assert.equal(out[0]!.depart_port, "new-york");
  assert.equal(out[0]!.end_date, "2026-09-27");
});

test("two sources for the same ship collapse to the earliest sailing; unresolvable ports count for nothing", () => {
  const out = plannedRowsInGrounds([
    row("Norwegian Escape", "2026-09-27", ["new-york", "halifax"], { source: "rapidapi-cruise" }),
    row("Norwegian Escape", "2026-09-20", ["new-york", "boston"], { source: "cruisemapper" }),
    row("Mystery Ship", "2026-09-20", ["atlantis"]),
    row("Coordinates Only", "2026-09-21", [], { ports: [{ name: "Juneau", slug: null, lat: 58.3, lon: -134.4 }] }),
  ], ["canada_new_england", "alaska"], locate);
  assert.deepEqual(out.map((s) => [s.ship_name, s.start_date, s.regions]), [
    ["Norwegian Escape", "2026-09-20", ["canada_new_england"]],
    ["Coordinates Only", "2026-09-21", ["alaska"]],
  ]);
  assert.deepEqual(plannedRowsInGrounds([], ["alaska"], locate), []);
});

// 2026-09-26, Mark: "we only ping a ship if the itinerary says it's in the path
// of the storm". The 26 Sep nor'easter as the NWS adapter saw it: low 38N 72W,
// 24 h 41N 73W, 48 h 40N 74W, warnings from the Chesapeake to the Gulf of Maine.
import { plannedRowsNearPath, sailingsNearPath, nearPath, pathOf, callInWindow, PATH_ZONE_NM, PATH_LOW_NM, type PathPoint } from "./storm-sailings";

const NOREASTER: PathPoint[] = [
  { kind: "low", lat: 38, lon: -72, label: "986 mb" },
  { kind: "f24", lat: 41, lon: -73 },
  { kind: "f48", lat: 40, lon: -74 },
  { kind: "zone", lat: 40.3, lon: -73.9, label: "Storm Warning: Sandy Hook to Manasquan" },
  { kind: "zone", lat: 42.8, lon: -68.35, label: "Gale Warning: Gulf of Maine" },
  { kind: "zone", lat: 37.0, lon: -75.8, label: "Gale Warning: Virginia coastal waters" },
];
const NE_PORTS: Record<string, { lat: number; lon: number }> = {
  ...PORTS, baltimore: { lat: 39.28, lon: -76.61 }, norfolk: { lat: 36.85, lon: -76.29 }, "portland-me": { lat: 43.66, lon: -70.25 },
  "port-canaveral": { lat: 28.41, lon: -80.6 }, bermuda: { lat: 32.3, lon: -64.78 },
};
const locateNE: PortLocator = (p) => (p.slug && NE_PORTS[p.slug]) || null;

test("the nor'easter reaches New York, Boston, Baltimore and Norfolk — not Miami, Port Canaveral, Bermuda or Halifax", () => {
  assert.ok(nearPath(40.7, -74.0, NOREASTER));   // New York
  assert.ok(nearPath(42.36, -71.06, NOREASTER)); // Boston
  assert.ok(nearPath(39.28, -76.61, NOREASTER)); // Baltimore
  assert.ok(nearPath(36.85, -76.29, NOREASTER)); // Norfolk
  assert.equal(nearPath(25.77, -80.19, NOREASTER), null, "Miami is 640 nm from the nearest warning");
  assert.equal(nearPath(28.41, -80.6, NOREASTER), null);
  assert.equal(nearPath(32.3, -64.78, NOREASTER), null, "Bermuda");
  assert.equal(nearPath(44.65, -63.57, NOREASTER), null, "Halifax: this storm turned inland over New York");
  assert.ok(PATH_ZONE_NM < PATH_LOW_NM);
});

test("itinerary ships are pinned by the path: the Florida turnarounds stay out", () => {
  const out = plannedRowsNearPath([
    row("Norwegian Escape", "2026-09-20", ["new-york", "halifax", "boston", "new-york"]),
    row("Vision of the Seas", "2026-09-25", ["baltimore", "port-canaveral", "nassau"]),
    row("Norwegian Getaway", "2026-09-22", ["miami", "cozumel", "miami"]),
    row("Carnival Celebration", "2026-09-21", ["port-canaveral", "nassau", "port-canaveral"]),
    row("Norwegian Joy", "2026-09-27", ["new-york", "bermuda", "new-york"]),
  ], NOREASTER, locateNE);
  assert.deepEqual(out.map((s) => s.ship_name), ["Norwegian Escape", "Vision of the Seas", "Norwegian Joy"]);
  assert.deepEqual(plannedRowsNearPath([row("Anything", "2026-09-20", ["miami"])], [], locateNE), [], "no path = no path pins");
});

test("AIS-derived current sailings are judged by their departure port; pathOf reads only well-formed points", () => {
  const ny = sailing("Norwegian Joy"); ny.depart_port = "New York";
  const mia = sailing("Norwegian Getaway"); mia.depart_port = "Miami";
  const unknown = sailing("Mystery"); unknown.depart_port = "Atlantis";
  const out = sailingsNearPath([ny, mia, unknown], NOREASTER, (n) => (n === "New York" ? { lat: 40.7, lon: -74 } : n === "Miami" ? { lat: 25.77, lon: -80.19 } : null));
  assert.deepEqual(out.map((s) => s.ship_name), ["Norwegian Joy"]);
  assert.deepEqual(pathOf({ path: [{ kind: "low", lat: 38, lon: -72 }, { kind: "bogus", lat: 1, lon: 1 }, { kind: "zone", lat: "x" }] }), [{ kind: "low", lat: 38, lon: -72 }]);
  assert.deepEqual(pathOf(null), []);
  assert.deepEqual(pathOf({ source: "manual" }), []);
});

test("a port call counts only on the day it happens: a Montreal → New York cruise is not in the nor'easter while it is on the St Lawrence", () => {
  const win = { start: "2026-09-26", end: "2026-10-01" };
  const dated = (ship: string, start: string, calls: Array<[string, string]>): PlannedSailingRow => ({
    ship_name: ship, operator: "Viking", source: "cruisemapper", start_date: start, end_date: "2026-10-06",
    ports: calls.map(([slug, date]) => ({ name: slug, slug, date })),
  });
  const rows = [
    // Vista: Montreal 9/25 … Portland ME 10/4, New York 10/6 — out of the corridor all window.
    dated("Vista", "2026-09-25", [["montreal", "2026-09-25"], ["quebec", "2026-09-26"], ["sydney-ns", "2026-10-01"], ["portland-me", "2026-10-04"], ["new-york", "2026-10-06"]]),
    // Viking Mars: New York 9/25, Boston 9/27 — in the corridor this week.
    dated("Viking Mars", "2026-09-25", [["new-york", "2026-09-25"], ["boston", "2026-09-27"], ["halifax", "2026-09-29"]]),
    // Undated calls (Widgety rows) fall back to the sailing overlap the caller applied.
    row("Norwegian Joy", "2026-09-27", ["new-york", "bermuda", "new-york"]),
  ];
  const locate: PortLocator = (p) => (p.slug && { ...NE_PORTS, montreal: { lat: 45.5, lon: -73.55 }, quebec: { lat: 46.8, lon: -71.2 }, "sydney-ns": { lat: 46.14, lon: -60.19 } }[p.slug]) || null;
  assert.deepEqual(plannedRowsNearPath(rows, NOREASTER, locate, win).map((s) => s.ship_name), ["Viking Mars", "Norwegian Joy"]);
  assert.deepEqual(plannedRowsNearPath(rows, NOREASTER, locate).map((s) => s.ship_name), ["Viking Mars", "Vista", "Norwegian Joy"], "without a window every call counts (same sailing date → by name)");
  assert.equal(callInWindow({ date: "2026-09-30" }, win), true);
  assert.equal(callInWindow({ date: "2026-10-02" }, win), false);
  assert.equal(callInWindow({ date: null }, win), true);
  assert.equal(callInWindow({ date: "2026-09-30T10:00:00Z" }, win), true, "a timestamp is judged by its day");
});
