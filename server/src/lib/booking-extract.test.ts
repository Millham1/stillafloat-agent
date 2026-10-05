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

// ── Terms: code finds the deadlines and checks the model's answer ─────────────
import { addDays, cutSections, dateAppears, findDeadlines, moneyAppears, verifyExtraction } from "./booking-terms";

const QUOTE = `GROUP ALLOCATION AND GROUP RATES
Category   Allotment   Commissionable Fare   NCF   Tax   Total Guest Price
IR2 Deluxe Interior   2   $403   $313   $52   $52   $88   $0   $84.80   $575.80   $485.80   $224.80   $136.80
BR2 Deluxe Balcony   14   $523   $373   $52   $52   $88   $0   $84.80   $695.80   $545.80   $224.80   $136.80
Ship Name:   MSC SEASIDE
Sailing Date:   10 May 2027
Nights   4
1   Mon, May 10, 2027   Miami, Florida   -   4:00 PM   ALONGSIDE
3   Wed, May 12, 2027   Ocean Cay MSC Marine Reserve, Bahamas   2:00 PM   -   ALONGSIDE
Any requested spaces will be reviewed and approved, aiming to do so at least 30 days before sailing whenever possible.
DINING
The Dining Room Form must be submitted no later than 45 days prior to sailing. MSC Cruises will make all reasonable efforts.
DEPOSIT AND PAYMENT REQUIREMENTS
For any Interior, Ocean View, Balcony, and Suite bookings, a deposit equal to   $99   per passenger is due at time of Booking.
Final Payment:
Final payment for all space is due   75 days   prior to sailing date and is determined by length of cruise.
ALLOTMENT REVIEW SCHEDULE
180 days prior to the sailing date   11/11/2026 , allotment space will be reviewed. If no staterooms have been sold, then 100% of the allotment will be
retaken. If staterooms have been sold, then 75% of the remaining unsold allotment will be retaken.
150 days prior to the sailing date   12/11/2026 , a second review of sold allotment space will occur. At that time, 50% of the remaining unsold allotment
will be retaken.
120 days prior to the sailing date   01/10/2027 , a third review of sold allotment space will occur. At that time, 100% of the remaining unsold allotment
will be retaken.
All new bookings made thereafter will be subject to availability and rates at time of booking.
CANCELLATION CHARGES
Cruises 4 Nights or Less   Cruises 5 to 14 Nights
74 – 51 days   Deposit Non-Refundable   89 – 61 days   Deposit Non-Refundable
50 – 31 days   50% penalty*   60 – 46 days   50% penalty*
30 – 16 days   75% penalty*   45 – 16 days   75% penalty*
15 – 0 days   100% penalty   15 – 0 days   100% penalty
Name changes can be made until 7 days prior to departure at no cost to the guest.`;

test("moneyAppears and dateAppears only accept what is printed", () => {
  assert.ok(moneyAppears(QUOTE, 575.8));
  assert.ok(moneyAppears(QUOTE, 403));
  assert.ok(!moneyAppears(QUOTE, 52.5));
  assert.ok(!moneyAppears(QUOTE, 75.8));   // inside 575.80
  assert.ok(!moneyAppears(QUOTE, 84));     // 84.80 is not 84
  assert.ok(moneyAppears("Total $1,218.80 due", 1218.8));
  assert.ok(dateAppears(QUOTE, "2027-05-10"));
  assert.ok(dateAppears(QUOTE, "2026-11-11"));
  assert.ok(dateAppears("Mon, May 10, 2027", "2027-05-10"));
  assert.ok(!dateAppears(QUOTE, "2026-10-20"));
  assert.equal(addDays("2027-05-10", -75), "2027-02-24");
});

test("findDeadlines dates the reviews, the final payment and the other deadlines from the sail date", () => {
  const f = findDeadlines(QUOTE, "2027-05-10");
  assert.equal(f.finalPaymentDays, 75);
  assert.deepEqual(f.reviews.map((r) => [r.date, r.days_before, r.percent_retaken]), [
    ["2026-11-11", 180, 75], ["2026-12-11", 150, 50], ["2027-01-10", 120, 100],
  ]);
  assert.match(f.reviews[0]!.note ?? "", /If no staterooms have been sold, then 100%/);
  assert.equal(f.reviews[1]!.note, null);
  assert.deepEqual(f.deadlines.map((d) => [d.days_before, d.date]), [[45, "2027-03-26"], [30, "2027-04-10"], [7, "2027-05-03"]]);
  assert.match(f.deadlines[0]!.text, /^The Dining Room Form/);
  assert.deepEqual(f.warnings, []);
  // A printed date that disagrees with the arithmetic is kept and reported.
  const odd = findDeadlines("90 days prior to sailing 02/01/2027, unsold allotment space will be recalled.", "2027-05-10");
  assert.equal(odd.reviews[0]!.date, "2027-02-01");
  assert.equal(odd.warnings.length, 1);
});

test("verifyExtraction blanks invented values, fixes a wrong price column and works out the dates", () => {
  // What the AI box really returned for this quote on 2026-10-05.
  const model = normalizeExtraction({
    cruise_line: "MSC Cruises", ship_name: "MSC SEASIDE", sail_date: "2027-05-10", nights: 4,
    itinerary: [
      { day: 1, date: "2027-05-10", port: "Miami, Florida", arrive: "16:00", depart: null },
      { day: 3, date: "2027-05-12", port: "Ocean Cay MSC Marine Reserve, Bahamas", arrive: "14:00", depart: null },
    ],
    cabin_categories: [
      { category: "Deluxe Interior", code: "IR2", count: 2, price_per_person: 52, commissionable_fare: 403, ncf: 88, taxes: 84.8 },
      // Right total, wrong columns for everything else (the box's second answer).
      { category: "Deluxe Balcony", code: "BR2", count: 14, price_per_person: 695.8, deposit_per_person: 84.8, commissionable_fare: 523, ncf: 373, taxes: 52,
        price_third_fourth_adult: 224.8, price_child: 136.8, price_junior_child: 0 },
    ],
    deposit_per_person: 99, deposit_timing: "at_booking", deposit_due: "2026-10-20", names_due: "2026-10-20",
    final_payment_due: "2027-02-20", final_payment_days_before: 75, recall_date: "2027-01-10",
    cancellation_schedule: [
      { from_days: 50, to_days: 31, penalty: "50% penalty", percent: 50 },
      { from_days: 51, to_days: 74, penalty: "Deposit Non-Refundable", percent: null },
      { from_days: 40, to_days: 20, penalty: "60% penalty", percent: 60 },
    ],
  });
  const x = verifyExtraction(model, QUOTE);
  assert.equal(x.cabin_categories[0]!.price_per_person, 575.8);
  assert.equal(x.cabin_categories[1]!.price_per_person, 695.8);
  const b = x.cabin_categories[1]!;
  assert.deepEqual([b.ncf, b.taxes, b.price_third_fourth_adult, b.price_child, b.price_junior_child, b.deposit_per_person], [88, 84.8, 545.8, 224.8, 136.8, 99]);
  assert.deepEqual([x.itinerary[0]!.arrive, x.itinerary[0]!.depart], [null, "16:00"]);
  assert.deepEqual([x.itinerary[1]!.arrive, x.itinerary[1]!.depart], ["14:00", null]);
  assert.equal(x.deposit_per_person, 99);
  assert.equal(x.deposit_timing, "at_booking");
  assert.equal(x.deposit_due, null);
  assert.equal(x.names_due, null);
  assert.equal(x.final_payment_due, "2027-02-24");
  assert.equal(x.return_date, "2027-05-14");
  assert.equal(x.recall_date, "2027-01-10");
  assert.equal(x.allotment_reviews.length, 3);
  assert.deepEqual(x.cancellation_schedule.map((r) => [r.from_days, r.to_days, r.from_date, r.to_date]), [
    [74, 51, "2027-02-25", "2027-03-20"], [50, 31, "2027-03-21", "2027-04-09"],
  ]);
  assert.ok(x.warnings.some((w) => /575\.8 was used/.test(w)));
  assert.ok(x.warnings.some((w) => /Names-due date was read as 2026-10-20/.test(w)));
  assert.ok(x.warnings.some((w) => /40 to 20 days/.test(w)));
  assert.ok(!foundFields(x).includes("warnings"));
});

test("cutSections pulls the price rows with their headers and the payment lines", () => {
  const s = cutSections(QUOTE);
  assert.match(s.rates, /Total Guest Price[\s\S]*BR2 Deluxe Balcony/);
  assert.match(s.payments, /\$99\s+per passenger is due at time of Booking/);
  assert.match(s.payments, /75 days/);
  assert.match(s.cancellation, /74 – 51 days/);
  assert.match(s.basics, /MSC SEASIDE/);
});
