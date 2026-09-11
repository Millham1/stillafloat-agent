// planned-sailings.test.ts — an operator's sailing list becomes dated, routable itineraries.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWidgetyRef, parseWidgetyShip, withEndDates, currentSailing, assembleRoute, portNamesFromSailingName } from "./planned-sailings";
import { resolvePortName } from "./world-ports";

// Verbatim shape from the July 2026 Widgety archive (msc-meraviglia/ship.json)
const SHIP = { title: "MSC Meraviglia", operator: { name: "MSC Cruises" }, cruises: [
  { name: "Southampton,Gijon,La Rochelle,Bilbao,Le Havre,Southampton", ref: "MSCMR20281021SOUSOU", cruise: "https://www.widgety.co.uk/api/cruises/MSCMR20281021SOUSOU.json" },
  { name: "Miami,Ocean Cay,Nassau,Miami", ref: "MSCMR20261204MIAMIA" },
  { name: "Miami,Italy,Cozumel,Isla de Roatan,Miami", ref: "MSCMR20261211MIAMIA" },
  { name: "dupe", ref: "MSCMR20261211MIAMIA" },
  { name: "bad", ref: "MSCMRNODATE" },
] };

describe("parseWidgetyRef", () => {
  it("reads the date and the from/to port codes", () => {
    assert.deepEqual(parseWidgetyRef("MSCMR20281021SOUSOU"), { startDate: "2028-10-21", nights: null, fromCode: "SOU", toCode: "SOU" });
    assert.deepEqual(parseWidgetyRef("NCLVIV-20281020-10-IST-BCN"), { startDate: "2028-10-20", nights: 10, fromCode: "IST", toCode: "BCN" });
    assert.equal(parseWidgetyRef("MSCMRNODATE"), null);
    assert.equal(parseWidgetyRef("MSCMR20281321SOUSOU"), null, "month 13 is not a date");
  });
});

describe("resolvePortName", () => {
  it("maps provider spellings onto the gazetteer, world ports, and drops countries and sea days", () => {
    assert.equal(resolvePortName("Isla de Roatan")!.slug, "roatan");
    assert.equal(resolvePortName("Civitavecchia")!.slug, "rome-civitavecchia");
    assert.equal(resolvePortName("Ocean Cay")!.slug, "ocean-cay");
    assert.equal(resolvePortName("Genoa")!.slug, "wp-genoa");
    assert.equal(resolvePortName("Palma de Mallorca")!.slug, "wp-palma");
    assert.equal(resolvePortName("Valletta")!.slug, "wp-valletta");
    assert.equal(resolvePortName("Italy"), null);
    assert.equal(resolvePortName("At sea"), null);
    assert.equal(resolvePortName("Nowhere Special"), null);
  });
});

describe("parseWidgetyShip + withEndDates + currentSailing", () => {
  const sailings = withEndDates(parseWidgetyShip(SHIP));
  it("keeps one sailing per ref, in date order, each ending when the next begins", () => {
    assert.deepEqual(sailings.map((s) => [s.ref, s.startDate, s.endDate]), [
      ["MSCMR20261204MIAMIA", "2026-12-04", "2026-12-11"],
      ["MSCMR20261211MIAMIA", "2026-12-11", "2028-10-21"],
      ["MSCMR20281021SOUSOU", "2028-10-21", null],
    ]);
    assert.equal(sailings[0]!.operator, "MSC Cruises");
    assert.equal(sailings[0]!.shipName, "MSC Meraviglia");
  });
  it("resolves the ports it can and keeps the rest by name", () => {
    const p = sailings[1]!.ports;
    assert.deepEqual(p.map((x) => [x.name, x.slug]), [["Miami, Florida", "miami"], ["Italy", null], ["Cozumel, Mexico", "cozumel"], ["Roatán, Honduras", "roatan"], ["Miami, Florida", "miami"]]);
  });
  it("picks the sailing under way on a date", () => {
    assert.equal(currentSailing(sailings, "2026-12-08")!.ref, "MSCMR20261204MIAMIA");
    assert.equal(currentSailing(sailings, "2026-12-11")!.ref, "MSCMR20261211MIAMIA", "the day a sailing starts belongs to it");
    assert.equal(currentSailing(sailings, "2026-11-30"), null);
    assert.equal(currentSailing(sailings, "2029-01-01")!.ref, "MSCMR20281021SOUSOU", "an open-ended last sailing stays current");
  });
});

describe("assembleRoute", () => {
  const ports = withEndDates(parseWidgetyShip(SHIP))[1]!.ports; // Miami, Italy(null), Cozumel, Roatan, Miami
  const legs: Record<string, [number, number][]> = {
    "miami>cozumel": [[25.76, -80.19], [23.0, -83.0], [20.5, -86.9]],
    "cozumel>roatan": [[20.5, -86.9], [18.0, -86.6], [16.3, -86.5]],
    // roatan>miami deliberately missing
  };
  it("joins stored legs through the resolved ports and leaves a gap where a leg is missing", () => {
    const r = assembleRoute(ports, (a, b) => legs[`${a}>${b}`] ?? null);
    assert.equal(r.legs, 3); assert.equal(r.missing, 1);
    assert.equal(r.segments.length, 1);
    assert.deepEqual(r.segments[0]![0], [25.76, -80.19]);
    assert.deepEqual(r.segments[0]![r.segments[0]!.length - 1], [16.3, -86.5]);
    assert.equal(r.segments[0]!.length, 5, "shared endpoints are not duplicated");
  });
});

describe("portNamesFromSailingName", () => {
  it("a day-by-day list is ordered as given", () => {
    assert.deepEqual(portNamesFromSailingName("Kiel,Copenhagen,Hellesylt,Alesund,Flaam,Kiel", "KEL", "KEL"), { names: ["Kiel", "Copenhagen", "Hellesylt", "Alesund", "Flaam", "Kiel"], ordered: true });
  });
  it("an NCL headline is bracketed by the from/to codes and marked unordered", () => {
    const r = portNamesFromSailingName("Greek Isles: Mykonos, Kusadasi & Athens", "IST", "CIV");
    assert.equal(r.ordered, false);
    assert.deepEqual(r.names, ["Istanbul, Turkey", "Mykonos", "Kusadasi", "Athens", "Rome / Civitavecchia, Italy"]);
  });
  it("a two-name repositioning keeps both ports; two countries fall back to the codes", () => {
    assert.deepEqual(portNamesFromSailingName("Barcelona, Copenhagen", "BCN", "CPH").names, ["Barcelona", "Copenhagen"]);
    assert.deepEqual(portNamesFromSailingName("United States, Mexico", "GLS", "GLS").names, ["Galveston, Texas"]);
  });
  it("NCL refs give an exact end date from the nights", () => {
    const s = parseWidgetyShip({ title: "Norwegian Viva", operator: { name: "Norwegian Cruise Line" }, cruises: [{ name: "Greek Isles: Mykonos & Kusadasi", ref: "NCLVIV-20281020-10-IST-BCN" }] })[0]!;
    assert.equal(s.endDate, "2028-10-30"); assert.equal(s.nights, 10); assert.equal(s.ordered, false);
    assert.deepEqual(s.ports.map((p) => p.slug), ["wp-istanbul", "mykonos", "wp-kusadasi", "barcelona"]);
  });
});
