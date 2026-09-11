// cruise-api-core.test.ts — a live Cruise API search record becomes a dated, routable sailing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCruiseApiItems, cruiseApiRef, resolveCruiseApiPort } from "./cruise-api-core";

// Verbatim item from POST /cruises/search on 2026-09-11 (Royal Caribbean, basic tier)
const ITEM = { cruiseId: "CSVGKztXc2YWYVVRREhEckhIcnJ1aXNlQVBJU2VjcmUA", cruiseLineCode: "RC", cruiseName: "Bahamas Getaway Cruise", cruiseType: "OCEAN", departureDate: "2026-09-11", duration: 3, itineraryDestinations: ["BH", "SE", "US"], itineraryPorts: ["USFLL", "BSNAS", "BSFPO", "USFLL"], itineraryUrl: "https://royalcaribbean.com/booking/landing?groupId=JW03FLL-2551937889", numberOfGuests: 2, roomTypeCategoryCode: "B", shipCode: "JW", soldOut: true,
  shipHydrated: { code: "JW", cruiseLineCode: "RC", fullName: "Jewel of the Seas", shortName: "Jewel of the Seas" },
  itineraryPortsHydrated: [{ portCode: "USFLL", portName: "Fort Lauderdale", portCountryCode: "US" }, { portCode: "BSNAS", portName: "Nassau", portCountryCode: "BS" }, { portCode: "BSFPO", portName: "Freeport", portCountryCode: "BS" }, { portCode: "USFLL", portName: "Fort Lauderdale", portCountryCode: "US" }] };
const ALASKA = { ...ITEM, cruiseId: "x", shipCode: "OV", departureDate: "2026-09-11", duration: 7, roomTypeCategoryCode: "I",
  shipHydrated: { code: "OV", cruiseLineCode: "RC", fullName: "Ovation of the Seas", shortName: "Ovation" },
  itineraryPorts: ["USSWD", "USHG1", "USJNU", "USSGY", "USHNH", "XZAS1", "CAVAN"],
  itineraryPortsHydrated: [{ portCode: "USSWD", portName: "Seward" }, { portCode: "USHG1", portName: "Hubbard Glacier" }, { portCode: "USJNU", portName: "Juneau" }, { portCode: "USSGY", portName: "Skagway" }, { portCode: "USHNH", portName: "Icy Strait Point" }, { portCode: "XZAS1", portName: "At Sea" }, { portCode: "CAVAN", portName: "Vancouver" }] };

describe("parseCruiseApiItems", () => {
  it("collapses the four room-type rows of one sailing into one dated sailing with ordered, resolved ports", () => {
    const rows = parseCruiseApiItems([ITEM, { ...ITEM, roomTypeCategoryCode: "I", cruiseId: "other" }, { ...ITEM, roomTypeCategoryCode: "O", cruiseId: "third" }]);
    assert.equal(rows.length, 1);
    const s = rows[0]!;
    assert.equal(s.ref, "rapidapi:RC:JW:2026-09-11:3");
    assert.equal(s.shipName, "Jewel of the Seas"); assert.equal(s.operator, "Royal Caribbean");
    assert.equal(s.startDate, "2026-09-11"); assert.equal(s.endDate, "2026-09-14"); assert.equal(s.nights, 3); assert.equal(s.ordered, true);
    assert.deepEqual(s.ports.map((p) => p.slug), ["fort-lauderdale", "nassau", "freeport-bahamas", "fort-lauderdale"]);
  });
  it("drops at-sea markers and scenic-cruising entries, resolves the rest by the API's port name", () => {
    const s = parseCruiseApiItems([ALASKA])[0]!;
    assert.deepEqual(s.ports.map((p) => [p.name.split(",")[0], p.slug]), [["Seward", "wp-seward"], ["Hubbard Glacier", null], ["Juneau", "juneau"], ["Skagway", "skagway"], ["Icy Strait Point", "wp-icy-strait"], ["Vancouver", "vancouver"]]);
    assert.equal(s.endDate, "2026-09-18");
    assert.equal(resolveCruiseApiPort("XZAS1", "At Sea"), null);
  });
  it("an item without a date or ship is skipped, and a ref needs both", () => {
    assert.equal(cruiseApiRef({ shipCode: "JW" }), null);
    assert.deepEqual(parseCruiseApiItems([{ departureDate: "2026-01-01" }]), []);
  });
});
