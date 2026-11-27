// genie-live.test.ts — the Vacation Genie's ship search on the fare service's destination search.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { liveSearchBody, liveSailingsFromRows, indexByShip, liveSailings, liveSailingsOf, DESTINATION_CODES, LIVE_MAX_PAGES } from "./genie-live";
import type { CruiseApiItem } from "./cruise-api-core";

const trip = { earliest: "2027-05-01", latest: "2027-05-30", nightsMin: 6, nightsMax: 8, destination: "s_caribbean" };

const item = (o: Partial<CruiseApiItem> & { ship: string }): CruiseApiItem => ({
  cruiseId: "c1", cruiseName: "7-Day Southern Caribbean", cruiseType: "OCEAN", cruiseLineCode: "CA", departureDate: "2027-05-09", duration: 7,
  itineraryPorts: ["PRSJU", "XZAS1", "AWAUA", "CWWIL", "PRSJU"],
  itineraryPortsHydrated: [{ portCode: "PRSJU", portName: "San Juan" }, { portCode: "AWAUA", portName: "Oranjestad" }, { portCode: "CWWIL", portName: "Willemstad" }],
  itineraryDestinationsHydrated: [{ code: "CS", name: "Caribbean (Southern)" }],
  shipHydrated: { fullName: o.ship, cruiseLineCode: o.cruiseLineCode ?? "CA" },
  roomTypeCategoryCode: "I", roomPriceWithTaxesFees: 798.4, availabilityStatus: "available", numberOfGuests: 2, ...o,
});

test("the search asks by destination first: the traveler's dates, length and where they want to go", () => {
  const b = liveSearchBody(trip, "2026-11-27", 1)!;
  assert.deepEqual(b.destinations, ["CS"]);
  assert.equal(b.earliestStartDate, "2027-05-01"); assert.equal(b.latestStartDate, "2027-05-30");
  assert.equal(b.durationMin, 6); assert.equal(b.durationMax, 8);
  assert.deepEqual(b.roomTypeCategoryCodes, ["I"]); assert.equal(b.page, 1);
  assert.equal(DESTINATION_CODES["alaska"], "AK"); assert.equal(DESTINATION_CODES["bahamas"], "BH");
});

test("a start date in the past is pulled up to today, and a question the service cannot be asked is null", () => {
  assert.equal(liveSearchBody({ ...trip, earliest: "2026-11-01", latest: "2026-12-20" }, "2026-11-27", 1)!.earliestStartDate, "2026-11-27");
  assert.equal(liveSearchBody({ ...trip, earliest: "2026-10-01", latest: "2026-11-20" }, "2026-11-27", 1), null, "the window is over");
  assert.equal(liveSearchBody({ ...trip, destination: "surprise" }, "2026-11-27", 1), null, "no destination named");
});

test("rows become sailings: ports in order with sea days dropped, the interior fare and what it covers", () => {
  const out = liveSailingsFromRows([
    item({ ship: "Carnival Magic" }),
    item({ ship: "Carnival Magic" }),                                                       // the same departure twice
    item({ ship: "Virgin Scarlet Lady", cruiseLineCode: "VI", departureDate: "2027-05-02", duration: 6, roomPriceWithTaxesFees: 1490 }),
    item({ ship: "MSC Opera", cruiseLineCode: "MS", departureDate: "2027-05-20", availabilityStatus: "sold_out", roomPriceWithTaxesFees: null }),
    item({ ship: "Land Tour", cruiseType: "OCEAN_TOUR" }),
  ]);
  assert.deepEqual(out.map((s) => s.ship), ["Virgin Scarlet Lady", "Carnival Magic", "MSC Opera"]);
  const magic = out[1]!;
  assert.deepEqual(magic.ports, ["San Juan", "Oranjestad", "Willemstad"]);
  assert.equal(magic.from, "San Juan"); assert.equal(magic.end, "2027-05-16"); assert.equal(magic.nights, 7);
  assert.equal(magic.fromPrice, 798); assert.equal(magic.basis, "per-person");
  assert.deepEqual(magic.destinations, ["Caribbean (Southern)"]);
  assert.equal(out[0]!.basis, "room", "Virgin advertises the total for two");
  assert.equal(out[2]!.fromPrice, null, "sold out: no figure");
});

test("a ship is found under any spelling of her name", () => {
  const idx = indexByShip(liveSailingsFromRows([item({ ship: "Carnival Magic" })]));
  const answer = { complete: true, byShip: idx, sailings: 1 };
  assert.equal(liveSailingsOf(answer, "Carnival Magic")!.length, 1);
  assert.equal(liveSailingsOf(answer, "Magic")!.length, 1);
  assert.equal(liveSailingsOf(answer, "Coral Princess"), null);
});

test("pages are read until the list ends, and a list longer than the cap is marked incomplete", async () => {
  const pages: number[] = [];
  const two = await liveSailings({ ...trip, earliest: "2027-06-01", latest: "2027-06-30" }, async (b) => {
    pages.push(b.page!);
    return { rows: [item({ ship: `Ship ${b.page}`, cruiseId: `c${b.page}` })], totalResults: 20, totalPages: 2 };
  }, new Date("2026-11-27T12:00:00Z"));
  assert.deepEqual(pages, [1, 2]); assert.equal(two!.complete, true); assert.equal(two!.sailings, 2);

  let calls = 0;
  const wide = await liveSailings({ ...trip, earliest: "2027-07-01", latest: "2027-12-30" }, async (b) => {
    calls++; return { rows: [item({ ship: `Ship ${b.page}`, cruiseId: `c${b.page}` })], totalResults: 400, totalPages: 40 };
  }, new Date("2026-11-27T12:00:00Z"));
  assert.equal(calls, LIVE_MAX_PAGES); assert.equal(wide!.complete, false);

  const again = await liveSailings({ ...trip, earliest: "2027-07-01", latest: "2027-12-30" }, async () => { calls++; return null; }, new Date("2026-11-27T13:00:00Z"));
  assert.equal(calls, LIVE_MAX_PAGES, "the same question an hour later is answered from memory"); assert.equal(again!.sailings, wide!.sailings);
});

test("when the service cannot answer the first page, the caller is told to use the table", async () => {
  assert.equal(await liveSailings({ ...trip, earliest: "2027-08-01", latest: "2027-08-20" }, async () => null, new Date("2026-11-27T12:00:00Z")), null);
  assert.equal(await liveSailings({ ...trip, destination: "surprise" }, async () => { throw new Error("must not be asked"); }), null);
});
