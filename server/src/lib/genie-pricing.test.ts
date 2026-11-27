// genie-pricing.test.ts — fares and sailing choices for the Vacation Genie.
import { test } from "node:test";
import assert from "node:assert/strict";
import { faresFromRows, fareLine, fareSearchBody, guestsToAsk, sailingChoices, regionsOfPorts, type SailingRow } from "./genie-pricing";
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
  // "ZZ" stands for a line the API might add later: all eleven it carries today are checked.
  const out = faresFromRows([row({ cruiseLineCode: "ZZ", roomTypeCategoryCode: "B", roomPriceWithTaxesFees: 1500 })], { ...want, lineCode: "ZZ" });
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

test("a sailing's destination is read from its own port names, with no map positions", () => {
  const named = (name: string) => [...regionsOfPorts([{ name, slug: null }])];
  // Names exactly as the schedule source prints them.
  assert.deepEqual(named("Oranjestad Aruba, Netherlands Antilles"), ["s_caribbean"]);
  assert.deepEqual(named("Bridgetown, Barbados"), ["s_caribbean"]);
  assert.deepEqual(named("Pointe-a-Pitre, Grande-Terre Island Guadeloupe"), ["s_caribbean"]);
  assert.deepEqual(named("Roseau, Dominica"), ["s_caribbean"]);
  assert.deepEqual(named("Cartagena Colombia"), ["s_caribbean"]);
  assert.deepEqual(named("St John's Antigua, RCI Royal Beach Club"), ["e_caribbean"]);
  assert.deepEqual(named("St Thomas Island USVI, Charlotte Amalie, US Virgin Islands"), ["e_caribbean"]);
  assert.deepEqual(named("Philipsburg St Maarten, Netherlands Antilles"), ["e_caribbean"]);
  assert.deepEqual(named("Puerto Plata-Amber Cove, Dominicana"), ["e_caribbean"]);
  assert.deepEqual(named("Grand Turk Island, Cockburn Town, Turks and Caicos"), ["e_caribbean"]);
  assert.deepEqual(named("Cozumel, Mexico, Riviera Maya"), ["w_caribbean"]);
  assert.deepEqual(named("Grand Cayman Island, George Town Harbour"), ["w_caribbean"]);
  assert.deepEqual(named("Falmouth Jamaica"), ["w_caribbean"]);
  assert.deepEqual(named("Belize City"), ["w_caribbean"]);
  assert.deepEqual(named("Nassau, Bahamas, New Providence Island"), ["bahamas"]);
  assert.deepEqual(named("Coco Cay, Bahamas, Royal Caribbean"), ["bahamas"]);
  assert.deepEqual(named("Ketchikan, Revillagigedo Island Alaska"), ["alaska"]);
  assert.deepEqual(named("Cabo San Lucas, Baja California Mexico"), ["mexican_riviera"]);
  assert.deepEqual(named("Puerto Vallarta, Jalisco, Mexico Riviera"), ["mexican_riviera"]);
  assert.deepEqual(named("Barcelona, Spain"), ["mediterranean"]);
  assert.deepEqual(named("Marseille, France Riviera"), ["mediterranean"]);
  assert.deepEqual(named("Piraeus-Athens, Greece"), ["mediterranean"]);
  // Home ports and other regions are none of the seven.
  for (const n of ["Miami, Florida", "Fort Lauderdale, Port Everglades, Florida", "Port Canaveral, Orlando, Florida", "Tampa, Florida",
    "Galveston, Texas", "Key West, Florida", "Boston, Massachusetts", "Kings Wharf, Bermuda", "Vancouver, BC Canada", "Seattle, Washington",
    "Los Angeles, Long Beach-San Pedro, California", "Cartagena Spain, Murcia".replace("Cartagena Spain, Murcia", "Cadiz, Spain, Sevilla"),
    "Lisbon, Portugal", "Southampton, England", "Santa Cruz de Tenerife, Canary Islands", "Le Havre-Paris, France", "Puntarenas, Puerto Caldera, Costa Rica"]) {
    assert.deepEqual(named(n), [], `${n} is not one of the seven destinations`);
  }
  assert.equal(regionsOfPorts([{ lat: 12.5, lon: -70 }]).size, 0, "a position with no name says nothing");
  assert.equal(regionsOfPorts(null).size, 0);
});

test("with a destination named, only sailings that call there are offered", () => {
  const row = (start: string, end: string, ports: unknown): SailingRow =>
    ({ ship_name: "Test Ship", operator: null, start_date: start, end_date: end, ports, source: "t" });
  const want = { earliest: "2027-05-01", latest: "2027-05-30", nightsMin: 6, nightsMax: 8 };
  const rows = [
    row("2027-05-02", "2027-05-09", [{ name: "Boston, Massachusetts" }, { name: "Kings Wharf, Bermuda" }]),
    row("2027-05-09", "2027-05-16", [{ name: "San Juan, Puerto Rico" }, { name: "Oranjestad Aruba, Netherlands Antilles" }]),
    row("2027-05-16", "2027-05-23", [{ name: "Somewhere" }]),
  ];
  assert.equal(sailingChoices(rows, want).length, 3, "no destination named: all three");
  assert.equal(sailingChoices(rows, { ...want, destination: "surprise" }).length, 3);
  const south = sailingChoices(rows, { ...want, destination: "s_caribbean" });
  assert.deepEqual(south.map((c) => c.start), ["2027-05-09"]);
  assert.equal(sailingChoices(rows, { ...want, destination: "alaska" }).length, 0);
});
