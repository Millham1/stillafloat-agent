import { test } from "node:test";
import assert from "node:assert/strict";
import { BOOKING_SCHEMA, cabinRowsFromExtraction, foundFields, normalizeDate, normalizeExtraction, normalizeMoney } from "./booking-extract";

test("normalizeDate accepts the formats quotes print and rejects junk", () => {
  assert.equal(normalizeDate("2027-03-01"), "2027-03-01");
  assert.equal(normalizeDate("03/01/2027"), "2027-03-01");
  assert.equal(normalizeDate("3/1/27"), "2027-03-01");
  assert.equal(normalizeDate("March 1, 2027"), "2027-03-01");
  assert.equal(normalizeDate("Sept 14 2027"), "2027-09-14");
  assert.equal(normalizeDate("1 Mar 2027"), "2027-03-01");
  assert.equal(normalizeDate("14 de septiembre de 2027"), "2027-09-14");
  assert.equal(normalizeDate("TBD"), null);
  assert.equal(normalizeDate("2027-13-01"), null);
  assert.equal(normalizeDate(null), null);
});

test("normalizeMoney strips symbols and rounds to cents", () => {
  assert.equal(normalizeMoney("$1,249.50"), 1249.5);
  assert.equal(normalizeMoney(500), 500);
  assert.equal(normalizeMoney("USD 250"), 250);
  assert.equal(normalizeMoney(""), null);
  assert.equal(normalizeMoney("n/a"), null);
});

test("normalizeExtraction tidies a raw answer and derives nights, cabins_held and deposit", () => {
  const x = normalizeExtraction({
    cruise_line: " Carnival ", ship_name: "Carnival Celebration", sail_date: "March 1, 2027", return_date: "03/08/2027",
    nights: null, embark_port: "Miami", itinerary: [{ day: 1, date: "2027-03-01", port: "Miami", arrive: null, depart: "16:00" }, { port: "" }],
    group_number: "G12345", booking_number: null, cabins_held: null,
    cabin_categories: [
      { category: "Balcony", code: "8C", count: 10, price_per_person: "$1,199", deposit_per_person: "250" },
      { category: "Interior", code: "4A", count: 6, price_per_person: 799, deposit_per_person: 250 },
      { category: null, code: null, count: null, price_per_person: null, deposit_per_person: null },
    ],
    deposit_per_person: null, deposit_due: "April 15, 2026", names_due: null, final_payment_due: "2026-12-01", recall_date: "bogus",
    amenities: ["$50 OBC per cabin", "", "1 free berth per 8"], organizer_name: "Post 12", travelers: [], total_price: "n/a", notes: "  ",
  });
  assert.equal(x.cruise_line, "Carnival");
  assert.equal(x.sail_date, "2027-03-01");
  assert.equal(x.return_date, "2027-03-08");
  assert.equal(x.nights, 7);
  assert.equal(x.cabins_held, 16);
  assert.equal(x.deposit_per_person, 250);
  assert.equal(x.deposit_due, "2026-04-15");
  assert.equal(x.recall_date, null);
  assert.equal(x.itinerary.length, 1);
  assert.equal(x.cabin_categories.length, 2);
  assert.equal(x.cabin_categories[0]!.price_per_person, 1199);
  assert.deepEqual(x.amenities, ["$50 OBC per cabin", "1 free berth per 8"]);
  assert.equal(x.total_price, null);
  assert.equal(x.notes, null);
  assert.ok(foundFields(x).includes("ship_name"));
  assert.ok(!foundFields(x).includes("names_due"));
  assert.ok(!foundFields(x).includes("travelers"));
});

test("normalizeExtraction survives garbage", () => {
  const x = normalizeExtraction("nope");
  assert.equal(x.ship_name, null);
  assert.deepEqual(x.itinerary, []);
  assert.deepEqual(foundFields(x), []);
});

test("cabinRowsFromExtraction opens one row per cabin, priced per cabin (double occupancy)", () => {
  const x = normalizeExtraction({
    cabin_categories: [{ category: "Balcony", code: "8C", count: 2, price_per_person: 1000, deposit_per_person: 250 }],
    cabins_held: 2,
  });
  const rows = cabinRowsFromExtraction(x, "group");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!["price_total"], 2000);
  assert.equal(rows[0]!["deposit_amount"], 500);
  assert.equal(rows[0]!["status"], "held");
  // Individual booking: exactly one cabin, booked, carrying the booking number.
  const one = cabinRowsFromExtraction(normalizeExtraction({ ...x, booking_number: "ABC123" }), "individual");
  assert.equal(one.length, 1);
  assert.equal(one[0]!["status"], "booked");
  assert.equal(one[0]!["booking_number"], "ABC123");
  // No category lines: fall back to the held count.
  assert.equal(cabinRowsFromExtraction(normalizeExtraction({ cabins_held: 16 }), "group").length, 16);
  assert.equal(cabinRowsFromExtraction(normalizeExtraction({}), "individual").length, 1);
});

test("the schema requires every field so the model cannot skip one silently", () => {
  const props = Object.keys((BOOKING_SCHEMA as { properties: object }).properties);
  assert.deepEqual([...(BOOKING_SCHEMA as { required: string[] }).required].sort(), [...props].sort());
});
