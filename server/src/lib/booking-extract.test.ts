import { test } from "node:test";
import assert from "node:assert/strict";
import { BOOKING_SCHEMA, cabinRowsFromExtraction, foundFields, normalizeDate, normalizeExtraction, normalizeMoney, travelRowsFromExtraction } from "./booking-extract";

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


// ── Air, hotel before and transfers (Mark 2026-10-10) ───────────────────────────────────────────
test("a quote's air / hotel / transfer lines become the group's travel offer, and are found", () => {
  const x = normalizeExtraction({
    ship_name: "MSC SEASIDE",
    travel_package: {
      air: { included: false, description: "Round trip from RDU, economy", from_city: "Raleigh-Durham", price_per_person: 412 },
      hotel_before: { included: false, name: "Hampton Inn Miami Airport", city: "Miami", nights: 1, price_per_person: 89.5 },
      transfers: [
        { route: "hotel_to_port", included: true, provider: "MSC motorcoach", price_per_person: null },
        { route: "port_to_airport", included: false, provider: "MSC motorcoach", price_per_person: 29 },
        { route: "mars_to_venus", included: true, provider: "x", price_per_person: 1 },
      ],
    },
  });
  assert.ok(x.travel_package);
  assert.equal(x.travel_package!.air!.price_per_person, 412);
  assert.equal(x.travel_package!.hotel_before!.nights, 1);
  assert.deepEqual(x.travel_package!.transfers.map((t) => t.route), ["hotel_to_port", "port_to_airport"], "an unknown route is dropped");
  assert.ok(foundFields(x).includes("travel_package"));
  const rows = travelRowsFromExtraction(x);
  assert.deepEqual(rows.map((r) => [r.kind, r.direction, r.included, r.price_per_person]), [
    ["flight", "pre", false, 412], ["hotel", "pre", false, 89.5], ["transfer", "pre", true, null], ["transfer", "post", false, 29],
  ]);
  assert.equal(rows[1]!.reference, "1 night");
  assert.equal(rows[2]!.from_place, "Hotel"); assert.equal(rows[2]!.to_place, "Cruise port");
  assert.ok(rows.every((r) => r.source === "quote"));
});

test("a quote with nothing about air, hotel or transfers leaves travel_package null and not found", () => {
  const x = normalizeExtraction({ ship_name: "MSC SEASIDE", travel_package: null });
  assert.equal(x.travel_package, null);
  assert.ok(!foundFields(x).includes("travel_package"));
  assert.deepEqual(travelRowsFromExtraction(x), []);
  const y = normalizeExtraction({ travel_package: { air: null, hotel_before: null, transfers: [] } });
  assert.equal(y.travel_package, null);
});

test("a travel price the document does not print is blanked with a warning; a printed one stays", () => {
  const text = "MSC SEASIDE\nAir add-on from RDU: $412.00 per person\nHotel night before: Hampton Inn Miami Airport $89.50 pp\nTransfer port to airport $29 pp";
  const x = normalizeExtraction({ travel_package: {
    air: { included: false, description: "from RDU", from_city: "RDU", price_per_person: 412 },
    hotel_before: { included: false, name: "Hampton Inn Miami Airport", city: "Miami", nights: 1, price_per_person: 99 },
    transfers: [{ route: "port_to_airport", included: false, provider: null, price_per_person: 29 }],
  } });
  const v = verifyExtraction(x, text);
  assert.equal(v.travel_package!.air!.price_per_person, 412);
  assert.equal(v.travel_package!.hotel_before!.price_per_person, null, "99 is not printed");
  assert.ok(v.warnings.some((w) => /Hotel before the cruise price was read as 99/.test(w)));
  assert.equal(v.travel_package!.transfers[0]!.price_per_person, 29);
});

test("cutSections finds the air / hotel / transfer lines of a quote", () => {
  const text = ["GROUP QUOTE", "Ship: MSC SEASIDE", "Fly & Cruise package available from RDU: $412 per person", "Pre-cruise hotel: Hampton Inn Miami Airport, 1 night, $89.50 pp", "Transfers hotel to pier included; pier to airport $29 pp", "", "Rates", "BR2 Deluxe Balcony 14 $523.00 $88.00 $84.80 $695.80"].join("\n");
  const s = cutSections(text);
  assert.match(s.travel, /Fly & Cruise/);
  assert.match(s.travel, /Pre-cruise hotel/);
  assert.match(s.travel, /Transfers hotel to pier/);
  assert.doesNotMatch(s.travel, /Deluxe Balcony/);
});


// ── MSC's group quotator: no dollar signs, 24-hour times (Mark's Millham F/F 2027 quote, 2026-10-18) ──────────────
// The anonymised text of the real printout (2 pages). The reader found nothing in it: the price table was found by
// counting "$" figures, the header block by am/pm times, and the sail date came out as the day the quote was created.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { countMoneyFigures, isDoubleRateTable, quoteTotals } from "./booking-terms";

const QUOTATOR = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/msc-quotator.txt"), "utf8");

test("a money figure is a $ figure or a bare two-decimal one; dates, times, percentages and fee columns are not", () => {
  assert.equal(countMoneyFigures("$403   $313   $52.00   468.79   1,234.56   $ 7"), 6);
  assert.equal(countMoneyFigures("BB Balcony Bella 10 468.79 308.79 308.79 149.79 149.79 149.79 149.79 68/68/68/0"), 7);
  assert.equal(countMoneyFigures("Sun 9 May 2027 16:00 --:-- 17 % 4 nights 68/68/68/0 10/18/26 6:43 PM 1/2 7.5 0.50 2027.05.09 149 12:30"), 0);
  assert.ok(moneyAppears(QUOTATOR, 468.79), "a bare figure is printed");
  assert.ok(moneyAppears(QUOTATOR, 2228.79));
  assert.ok(moneyAppears(QUOTATOR, 68), "the taxes column");
  assert.ok(!moneyAppears(QUOTATOR, 536.79), "rate + taxes is not printed");
  assert.ok(!moneyAppears(QUOTATOR, 46.8), "inside 468.79");
  assert.ok(isDoubleRateTable(QUOTATOR));
  assert.ok(!isDoubleRateTable(QUOTE));
});

test("cutSections cuts the quotator: the rate rows with their header, the header block, the itinerary rows, the summary", () => {
  const s = cutSections(QUOTATOR);
  assert.match(s.rates, /category double Rates 3rd\/4th Adult Rate[^\n]*\nIB Interior Bella 0 328\.79/, "the header sits right above the first row");
  assert.match(s.rates, /BB Balcony Bella 10 468\.79 308\.79 308\.79 149\.79 149\.79 149\.79 149\.79 68\/68\/68\/0/);
  assert.match(s.rates, /BA Balcony Aurea 2 618\.79/, "the row on page 2 is in the section too");
  assert.match(s.rates, /YC1 MSC Yacht Club Deluxe Suite 0 2228\.79/);
  for (const k of ["MSC SEASHORE", "Florida 9 May 2027", "Florida 13 May 2027", "Duration (Nights)", "Cabins 12", "Expire on 03 Nov 2026", "Create on 18 Oct 2026",
    "Total rate $11,850.96", "Group Name", "Packages Cruise Only", "Group Classification", "Group Dining",
    "1 Sun 9 May 2027 Port Canaveral (Orlando), Florida 16:00", "3 Tue 11 May 2027 Ocean Cay MSC Marine Reserve, Bahamas 08:00 --:--", "5 Thu 13 May 2027"]) {
    assert.ok(s.basics.includes(k), `basics should hold "${k}"`);
  }
  assert.doesNotMatch(s.basics, /Interior Bella 0 328/, "the rate rows are the other section's");
  assert.match(s.payments, /Names and full deposits are required at time of booking confirmation/);
  for (const [name, v] of Object.entries(s)) assert.doesNotMatch(v, /mscbook\.com|6:43 PM/, `${name}: the browser's stamp and address line are not the quote`);
  assert.equal(s.cancellation, "", "the quote says nothing about cancelling: not asked");
  assert.equal(s.travel, "", "the quote says nothing about air or hotels: not asked");
});

test("a short document is its own section: a header, price or payment section under 200 characters becomes the whole text", () => {
  const tiny = "Booking confirmation\nMSC SEASIDE\nSailing 10 May 2027";
  const t = cutSections(tiny);
  assert.equal(t.basics, tiny);
  assert.equal(t.rates, tiny, "no price table found: the box reads the whole confirmation");
  assert.equal(t.payments, tiny);
  assert.equal(t.cancellation, "", "an absent optional section is skipped, not widened");
  assert.equal(t.travel, "");
  // A section that said enough keeps its own cut.
  assert.notEqual(cutSections(QUOTE).basics, QUOTE);
  // A long document is cut, never replaced by its whole text.
  const long = `${"Filler sentence about nothing in particular. ".repeat(250)}\nShip: MSC SEASIDE`;
  assert.ok(long.length > 8_000);
  assert.equal(cutSections(long).basics, "Ship: MSC SEASIDE");
  assert.equal(cutSections(long).rates, "");
});

test("the rate block always keeps its header, even when the rows alone fill the section", () => {
  const rows = Array.from({ length: 70 }, (_, i) => `C${i} Cabin type number ${i} ${i % 9 + 1} 468.79 308.79 308.79 149.79 149.79 149.79 149.79 68/68/68/0`);
  const text = ["lots of lines above", ...Array(60).fill("an unrelated line of text above the table"), "category double Rates 3rd/4th Adult Rate 3rd/4th Child Rate 3rd/4th Jr Child Rate", ...rows].join("\n");
  assert.ok(text.length > 8_000);
  const s = cutSections(text);
  assert.match(s.rates, /^category double Rates/, "the header is the first line of the block, the 60 lines above it were trimmed");
  assert.match(s.rates, /C69 Cabin type number 69/);
});

// What a plausible box answer looks like for the quotator: right rows, but the wrong sail date (the day the quote was created),
// the double rate in the price box, a wrong cabin count on one row and a deposit taken from the taxes column.
function quotatorAnswer(over: Record<string, unknown> = {}) {
  return normalizeExtraction({
    cruise_line: "MSC Cruises", ship_name: "MSC SEASHORE", sail_date: "2026-10-18", return_date: "2027-05-13", nights: 4,
    embark_port: "Port Canaveral (Orlando), Florida",
    itinerary: [
      { day: 1, date: "2027-05-09", port: "Port Canaveral (Orlando), Florida", arrive: "16:00", depart: null },
      { day: 2, date: "2027-05-10", port: "Nassau, Bahamas", arrive: "09:00", depart: "18:00" },
      { day: 3, date: "2027-05-11", port: "Ocean Cay MSC Marine Reserve, Bahamas", arrive: "08:00", depart: "--:--" },
      { day: 4, date: "2027-05-12", port: "Ocean Cay MSC Marine Reserve, Bahamas", arrive: "--:--", depart: "12:00" },
      { day: 5, date: "2027-05-13", port: "Port Canaveral (Orlando), Florida", arrive: "07:00", depart: null },
    ],
    cabin_categories: [
      { category: "Balcony Bella", code: "BB", count: 10, price_per_person: 468.79, commissionable_fare: 468.79, taxes: 68, deposit_per_person: 68 },
      { category: "Balcony Aurea", code: "BA", count: 3, price_per_person: 618.79 },
      { category: "MSC Yacht Club Deluxe Suite", code: "YC1", count: 0 },
      { category: "Interior Bella", code: "IB", count: 0, ncf: 149.79 },
    ],
    deposit_per_person: 68, deposit_timing: "at_booking",
    ...over,
  });
}

test("verifyExtraction reads the quotator: rows from the printed lines, sail date never the day the quote was made", () => {
  const x = verifyExtraction(quotatorAnswer(), QUOTATOR);
  // Dates: "Create on 18 Oct 2026" is not a sailing date; day 1 of the printed itinerary is.
  assert.ok(x.warnings.some((w) => /Sail date was read as 2026-10-18.*Create on 18 Oct 2026.*Left blank/.test(w)), x.warnings.join(" | "));
  assert.equal(x.sail_date, "2027-05-09");
  assert.ok(x.warnings.some((w) => /sail date was blank; day 1 of the itinerary \(2027-05-09\)/i.test(w)));
  assert.equal(x.return_date, "2027-05-13");
  assert.equal(x.nights, 4);
  // Times straight off the rows: one time on the first row is the departure, one on the last is the arrival, "--:--" is none.
  assert.deepEqual(x.itinerary.map((s) => [s.arrive, s.depart]), [[null, "16:00"], ["09:00", "18:00"], ["08:00", null], [null, "12:00"], ["07:00", null]]);
  // BB: every figure from the printed row, the price per person worked out from the two printed pieces.
  const bb = x.cabin_categories[0]!;
  assert.deepEqual([bb.count, bb.commissionable_fare, bb.taxes, bb.ncf, bb.price_per_person, bb.deposit_per_person],
    [10, 468.79, 68, null, 536.79, null]);
  assert.deepEqual([bb.price_third_fourth_adult, bb.price_child, bb.price_junior_child], [308.79, 149.79, 149.79]);
  // BA is found by its own code, not as "ba" inside "Balcony Bella"; the model's count of 3 is corrected to the row's 2.
  const ba = x.cabin_categories[1]!;
  assert.deepEqual([ba.count, ba.commissionable_fare, ba.taxes, ba.price_per_person, ba.price_third_fourth_adult], [2, 618.79, 68, 686.79, 378.79]);
  assert.ok(x.warnings.some((w) => /BA Balcony Aurea: the number of cabins held was read as 3, but the printed row has 2/.test(w)));
  // A category the model left empty is filled from its row; the suite has its own taxes column.
  const yc = x.cabin_categories[2]!;
  assert.deepEqual([yc.commissionable_fare, yc.taxes, yc.price_per_person, yc.price_child], [2228.79, 92, 2320.79, 1088.79]);
  const ib = x.cabin_categories[3]!;
  assert.deepEqual([ib.commissionable_fare, ib.ncf, ib.price_per_person], [328.79, null, 396.79], "no NCF column in this layout");
  // The deposit was never printed; 68 is the taxes column.
  assert.equal(x.deposit_per_person, null);
  assert.ok(x.warnings.some((w) => /Deposit per person was read as 68, but no line about the deposit prints that amount/.test(w)));
  assert.ok(x.warnings.some((w) => /BB Balcony Bella: the deposit per person was read as 68, but the quote prints no deposit/.test(w)));
  assert.equal(x.deposit_timing, "at_booking");
  // The one-off sentence about adding the rate and the taxes up appears once, however many rows there are.
  assert.equal(x.warnings.filter((w) => /prints the double rate and the taxes and fees apart/.test(w)).length, 1);
  // The group total and the commission have no field: they ride in the notes.
  assert.match(x.notes ?? "", /Group total rate \$11,850\.96/);
  assert.match(x.notes ?? "", /Commission 17 %/);
  assert.equal(x.cabins_held, 12, "the model's rows added up to 13 until the count of one row was corrected from the printed line");
});

test("verifyExtraction: the cabins held come from the printed rows and match the quote's 'Cabins 12'", () => {
  const x = verifyExtraction(quotatorAnswer({ sail_date: "2027-05-09" }), QUOTATOR);
  assert.equal(x.sail_date, "2027-05-09");
  assert.ok(!x.warnings.some((w) => /Sail date/.test(w)));
  assert.equal(x.cabin_categories.reduce((n, c) => n + (c.count ?? 0), 0), 12);
  assert.ok(!x.warnings.some((w) => /The quote says Cabins/.test(w)));
  // Rows that do not add up to the printed total are reported.
  const short = verifyExtraction(quotatorAnswer({ sail_date: "2027-05-09", cabin_categories: [{ category: "Balcony Bella", code: "BB", count: 10 }] }), QUOTATOR);
  assert.equal(short.cabin_categories[0]!.count, 10);
  assert.ok(short.warnings.some((w) => /The quote says Cabins 12, but the category rows add up to 10/.test(w)));
  assert.equal(short.cabins_held, 12, "the block's size is the printed one");
});

test("verifyExtraction: no itinerary to fall back on, a sail date equal to the day the quote was made or expires is left blank", () => {
  for (const [bad, label] of [["2026-10-18", "Create on 18 Oct 2026"], ["2026-11-03", "Expire on 03 Nov 2026"]] as const) {
    const x = verifyExtraction(quotatorAnswer({ sail_date: bad, itinerary: [] }), QUOTATOR);
    assert.equal(x.sail_date, null);
    assert.ok(x.warnings.some((w) => w.includes(`Sail date was read as ${bad}`) && w.includes(label)), x.warnings.join(" | "));
    assert.equal(x.return_date, "2027-05-13");
  }
  // An itinerary day dated with the day the quote was made is not a port call either.
  const odd = verifyExtraction(quotatorAnswer({ sail_date: "2027-05-09", itinerary: [{ day: 1, date: "2026-10-18", port: "Port Canaveral (Orlando), Florida", arrive: null, depart: "16:00" }] }), QUOTATOR);
  assert.equal(odd.itinerary[0]!.date, null);
  // The same guard on the return date.
  const r = verifyExtraction(quotatorAnswer({ sail_date: "2027-05-09", return_date: "2026-11-03" }), QUOTATOR);
  assert.ok(r.warnings.some((w) => /Return date was read as 2026-11-03/.test(w)));
  assert.equal(r.return_date, "2027-05-13", "worked out from the sail date and the 4 nights");
});

test("quoteTotals and the notes: the printed total and commission are added once, to whatever the notes already say", () => {
  assert.deepEqual(quoteTotals(QUOTATOR), { total: 11850.96, commission: "17 %" });
  assert.deepEqual(quoteTotals(QUOTE), { total: null, commission: null });
  const again = verifyExtraction(quotatorAnswer({ sail_date: "2027-05-09", notes: "Group total rate $11,850.96. Commission 17 %. Names due at booking." }), QUOTATOR);
  assert.equal(again.notes, "Group total rate $11,850.96. Commission 17 %. Names due at booking.");
  const withOwn = verifyExtraction(quotatorAnswer({ sail_date: "2027-05-09", notes: "Champagne toast requested." }), QUOTATOR);
  assert.match(withOwn.notes ?? "", /^Champagne toast requested\. Group total rate \$11,850\.96/);
});

test("a dollar-sign quote reads as before: rows by the sums, no quotator rules", () => {
  const model = normalizeExtraction({
    ship_name: "MSC SEASIDE", sail_date: "2027-05-10", nights: 4,
    cabin_categories: [{ category: "Deluxe Balcony", code: "BR2", count: 14, price_per_person: 695.8, commissionable_fare: 523, ncf: 373, taxes: 52 }],
  });
  const x = verifyExtraction(model, QUOTE);
  const b = x.cabin_categories[0]!;
  assert.deepEqual([b.price_per_person, b.ncf, b.taxes], [695.8, 88, 84.8]);
  assert.ok(!x.warnings.some((w) => /prints the double rate/.test(w)));
  assert.equal(x.notes, null, "no total rate line, no note");
  assert.equal(x.sail_date, "2027-05-10");
});
