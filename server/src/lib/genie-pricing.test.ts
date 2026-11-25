// genie-pricing.test.ts — fares and sailing choices for the Vacation Genie.
import { test } from "node:test";
import assert from "node:assert/strict";
import { faresFromRows, fareLine, fareSearchBody, guestsToAsk, sailingChoices, type SailingRow } from "./genie-pricing";
import type { CruiseApiItem } from "./cruise-api-core";

const row = (o: Partial<CruiseApiItem>): CruiseApiItem => ({
  cruiseLineCode: "CA", departureDate: "2027-02-06", duration: 7, cruiseType: "OCEAN", availabilityStatus: "available", ...o,
});
const want = { shipName: "Carnival Celebration", lineCode: "CA", start: "2027-02-06", nights: 7, guests: 2 };

test("one fare per room type, in interior-to-suite order", () => {
  const out = faresFromRows([
    row({ roomTypeCategoryCode: "B", roomPriceWithTaxesFees: 1204.4 }),
    row({ roomTypeCategoryCode: "I", roomPriceWithTaxesFees: 804 }),
    row({ roomTypeCategoryCode: "S", roomPriceWithTaxesFees: 2310 }),
    row({ roomTypeCategoryCode: "O", roomPriceWithTaxesFees: 954 }),
  ], want);
  assert.deepEqual(out.fares.map((f) => [f.type, f.price]), [["inside", 804], ["oceanview", 954], ["balcony", 1204], ["suite", 2310]]);
  assert.ok(out.fares.every((f) => f.basis === "per-person"), "Carnival advertises per person");
});

test("a cruisetour, another date and another length are left out", () => {
  const out = faresFromRows([
    row({ roomTypeCategoryCode: "I", roomPriceWithTaxesFees: 804 }),
    row({ roomTypeCategoryCode: "I", roomPriceWithTaxesFees: 1900, cruiseType: "OCEAN_TOUR" }),
    row({ roomTypeCategoryCode: "O", roomPriceWithTaxesFees: 700, departureDate: "2027-02-13" }),
    row({ roomTypeCategoryCode: "B", roomPriceWithTaxesFees: 600, duration: 4 }),
  ], want);
  assert.deepEqual(out.fares.map((f) => [f.type, f.price]), [["inside", 804]]);
});

test("a sold-out room type is listed with no price", () => {
  const out = faresFromRows([row({ roomTypeCategoryCode: "S", availabilityStatus: "sold_out", roomPriceWithTaxesFees: null })], want);
  assert.deepEqual(out.fares[0], { type: "suite", price: null, status: "sold_out", basis: "per-person", asOf: null });
  assert.equal(fareLine(out.fares[0]!, 2), "Suite: sold out");
});

test("a line we have not checked says so instead of claiming what the fare covers", () => {
  const out = faresFromRows([row({ cruiseLineCode: "PR", roomTypeCategoryCode: "B", roomPriceWithTaxesFees: 1500 })], { ...want, lineCode: "PR" });
  assert.equal(out.fares[0]!.basis, "unconfirmed");
  assert.equal(fareLine(out.fares[0]!, 2), "Balcony: $1,500 as the line advertises it, taxes and fees included");
});

test("the fare line says what the figure covers", () => {
  assert.equal(fareLine({ type: "inside", price: 804, status: "available", basis: "per-person", asOf: null }, 2), "Interior: $804 per person, two in a room, taxes and fees included");
  assert.equal(fareLine({ type: "balcony", price: 3266, status: "available", basis: "room", asOf: null }, 2), "Balcony: $3,266 for the room, two guests, taxes and fees included");
});

test("the API is asked for one or two guests only, and two on the double-only lines", () => {
  assert.equal(guestsToAsk(1, "CA"), 1);
  assert.equal(guestsToAsk(1, "HA"), 2);
  assert.equal(guestsToAsk(4, "RC"), 2);
  assert.deepEqual(fareSearchBody({ lineCode: "RC", shipCode: "WN", start: "2027-02-06", guests: 2 }), {
    cruiseLineCodes: ["RC"], shipCodes: ["WN"], earliestStartDate: "2027-02-06", latestStartDate: "2027-02-06", numberOfGuests: [2], pageSize: 10,
  });
});

test("sailing choices: inside the dates, the right length, one row a departure, soonest first", () => {
  const s = (start: string, end: string | null, ports: string[], source = "cruisemapper"): SailingRow =>
    ({ ship_name: "Wonder of the Seas", operator: "Royal Caribbean", start_date: start, end_date: end, ports: ports.map((name) => ({ name })), source });
  const out = sailingChoices([
    s("2027-03-07", "2027-03-14", ["Port Canaveral", "Cozumel"]),
    s("2027-02-07", "2027-02-14", ["Port Canaveral"], "rapidapi-cruise"),
    s("2027-02-07", "2027-02-14", ["Port Canaveral", "Nassau", "CocoCay", "Port Canaveral"]),
    s("2027-02-14", "2027-02-18", ["Port Canaveral", "Nassau"]),        // 4 nights: too short
    s("2027-05-01", "2027-05-08", ["Port Canaveral"]),                   // outside the dates
  ], { earliest: "2027-02-01", latest: "2027-03-31", nightsMin: 6, nightsMax: 8 });
  assert.deepEqual(out.map((x) => x.start), ["2027-02-07", "2027-03-07"]);
  assert.equal(out[0]!.nights, 7);
  assert.deepEqual(out[0]!.ports, ["Port Canaveral", "Nassau", "CocoCay"], "the fuller row wins, with repeat ports listed once");
});
