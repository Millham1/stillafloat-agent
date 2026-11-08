import { test } from "node:test";
import assert from "node:assert/strict";
import { ageOn, buildQuote, drinksIncluded, fares, freeCabinFor, insuranceSeedOf, quoteOptions, quoteSummary, storedQuote, validateQuoteAnswers } from "./group-quote";

type Row = Record<string, any>;

const group = (over: Row = {}): Row => ({
  id: "g", sail_date: "2027-05-09", deposit_per_person: "50.00", final_payment_due: "2027-01-15", inclusions: [], line_protection: null, insurance_plans: null,
  marketing: { taxes_included: true },
  terms: { cabin_categories: [
    { code: "BB", category: "Balcony Bella", count: 10, taxes: 68, price_per_person: 536.79, price_third_fourth_adult: 308.79, price_junior_child: 149.79, price_child: 149.79 },
    { code: "BA", category: "Balcony Aurea", count: 2, taxes: 68, price_per_person: 686.79, price_third_fourth_adult: 378.79, price_junior_child: 149.79, price_child: 149.79 },
  ] },
  ...over,
});
const cabins = (): Row[] => [
  { id: "c1", status: "held", category: "Balcony Bella", category_code: "BB", price_total: "1073.58" },
  { id: "c2", status: "held", category: "Balcony Bella", category_code: "BB", price_total: "1073.58" },
  { id: "c3", status: "booked", category: "Balcony Bella", category_code: "BB", price_total: "1073.58" },
  { id: "c4", status: "held", category: "Balcony Aurea", category_code: "BA", price_total: "1373.58" },
  { id: "c5", status: "released", category: "Interior Bella", category_code: "IB", price_total: "793.58" },
];
const travel = (): Row[] => [
  { id: "f1", kind: "flight", direction: "pre", from_place: "Raleigh (RDU)", price_per_person: "136", price_unit: "person", included: false },
  { id: "h1", kind: "hotel", direction: "pre", from_place: "Orlando", reference: "1 night", price_per_person: "125", price_unit: "room", included: false },
  { id: "t1", kind: "transfer", direction: "pre", from_place: "Hotel", to_place: "the cruise port", price_per_person: "45", price_unit: "person", included: false },
  { id: "t2", kind: "transfer", direction: "post", from_place: "Cruise port", to_place: "the airport", price_per_person: null, included: true },
  { id: "x1", kind: "transfer", traveler_id: "someone", price_per_person: "1" },
];
const two = [{ legal_name: "Mark Millham", dob: "1965-04-12" }, { legal_name: "Ceci Millham", dob: "1980-11-02" }];

test("the options come from the file: held categories cheapest first with the file's fare (booked and released cabins left out), the plans Mark typed, the travel offer without the vendor, and the kinds with no offer", () => {
  const o = quoteOptions({ group: group({ line_protection: "MSC Cruise Protection: $99 per person", insurance_plans: "OneTrip Basic: $89 per person\nOneTrip Prime — $129\nno price on this line" }), cabins: cabins(), travel: travel() }, "en");
  assert.deepEqual(o.cabins.map((c) => [c.key, c.category, c.perPerson, c.thirdFourthAdult, c.child, c.taxes, c.taxesIncluded, c.available, c.label]), [
    ["BB", "Balcony Bella", 536.79, 308.79, 149.79, 68, true, 2, "Balcony Bella · $536.79 per person · taxes and port fees included"],
    ["BA", "Balcony Aurea", 686.79, 378.79, 149.79, 68, true, 1, "Balcony Aurea · $686.79 per person · taxes and port fees included"],
  ]);
  assert.deepEqual(o.insurance.map((i) => [i.key, i.label, i.perPerson]), [
    ["line", "MSC Cruise Protection · $99 per person", 99], ["allianz-0", "OneTrip Basic (Allianz) · $89 per person", 89], ["allianz-1", "OneTrip Prime (Allianz) · $129 per person", 129],
    ["own", "I have my own policy", null], ["decline", "No insurance for us", null],
  ]);
  assert.deepEqual(o.travel.map((t) => [t.key, t.kind, t.text, t.perUnit, t.unit, t.included]), [
    ["f1", "flight", "Flight from Raleigh (RDU)", 136, "person", false],
    ["h1", "hotel", "Hotel the night before in Orlando (1 night)", 125, "room", false],
    ["t1", "transfer", "Hotel to the cruise port", 45, "person", false],
    ["t2", "transfer", "Cruise port to the airport · included in the cruise price", null, "person", true],
  ], "a row on a traveler is not the group's offer; no price is shown before Mark finalizes the quote (Mark 2026-11-07)");
  assert.deepEqual([o.needs, o.drinks, o.depositPerPersonText, o.finalPaymentText], [[], "ask", "$50", "January 15, 2027"]);
});

test("with no fare line on the file the cabin's own price is halved; taxes not included become their own note; no plan with a price leaves only 'quote me'; a drink package in the inclusions closes that question", () => {
  const o = quoteOptions({ group: group({ terms: null, marketing: { taxes_included: false }, inclusions: ["Easy Plus drink package", "Wi-Fi"] }), cabins: cabins(), travel: [] }, "es");
  assert.deepEqual(o.cabins.map((c) => [c.perPerson, c.thirdFourthAdult, c.taxes, c.label]), [[536.79, null, null, "Balcony Bella · $536.79 por persona"], [686.79, null, null, "Balcony Aurea · $686.79 por persona"]]);
  assert.deepEqual(o.insurance.map((i) => i.key), ["quote", "own", "decline"]);
  assert.deepEqual([o.drinks, o.needs], ["included", ["flight", "hotel", "transfer"]]);
  assert.equal(drinksIncluded({ inclusions: ["Premium Extra beverage package"] }), true);
  assert.equal(drinksIncluded({ inclusions: ["$25 onboard credit"] }), false);
  const taxed = quoteOptions({ group: group({ marketing: { taxes_included: false } }), cabins: cabins(), travel: [] }, "en");
  assert.equal(taxed.cabins[0]!.label, "Balcony Bella · $536.79 per person · plus $68 taxes and port fees per person");
});

test("answers are checked against the options; a kind with no offer must be answered yes or no; a drink answer is not asked when the fare includes one", () => {
  const o = quoteOptions({ group: group(), cabins: cabins(), travel: travel() }, "en");
  const good = { cabin: "BB", flexpay: false, drinks: false, insurance: "decline", travel: ["f1", "h1", "f1"], needs: {} };
  const v = validateQuoteAnswers({ answers: good }, o, "en");
  assert.ok(v.ok);
  assert.deepEqual(v.ok && v.answers, { cabin: "BB", flexpay: false, drinks: false, insurance: "decline", travel: ["f1", "h1"], needs: {} }, "a travel item ticked twice counts once; needs not asked are not kept");
  assert.deepEqual(validateQuoteAnswers({ ...good, cabin: "IB" }, o, "en"), { ok: false, error: "Pick a cabin, please.", field: "cabin" }, "a released category is not offered");
  assert.deepEqual(validateQuoteAnswers({ ...good, insurance: "line" }, o, "en"), { ok: false, error: "Pick one of the insurance choices, please.", field: "insurance" });
  const bare = quoteOptions({ group: group({ inclusions: ["drink package"] }), cabins: cabins(), travel: [] }, "en");
  assert.deepEqual(validateQuoteAnswers({ cabin: "BB", flexpay: true, insurance: "own", needs: { flight: false, hotel: true } }, bare, "en"), { ok: false, error: "Yes or no on the transfers, please.", field: "need-transfer" });
  const ok = validateQuoteAnswers({ cabin: "BB", flexpay: true, drinks: true, insurance: "own", needs: { flight: false, hotel: true, transfer: false } }, bare, "en");
  assert.deepEqual(ok.ok && ok.answers.drinks, null, "the fare includes drinks: the answer is not kept");
});

test("ages at sailing and the fare each traveler pays: the first two the full fare, the third and fourth by age from the file's reduced fares", () => {
  assert.deepEqual([ageOn("2015-05-10", "2027-05-09"), ageOn("2015-05-09", "2027-05-09"), ageOn("2009-06-01", "2027-05-09"), ageOn("bad", "2027-05-09")], [11, 12, 17, null]);
  const o = quoteOptions({ group: group(), cabins: cabins(), travel: [] }, "en");
  const four = [...two, { legal_name: "Teen Millham", dob: "2010-01-01" }, { legal_name: "Kid Millham", dob: "2018-07-04" }];
  assert.deepEqual(fares(o.cabins[0]!, four, "2027-05-09").map((f) => [f.amount, f.tag]), [[536.79, "full"], [536.79, "full"], [149.79, "junior"], [149.79, "child"]]);
  const adults = [...two, { legal_name: "Uncle Millham", dob: "1970-01-01" }];
  assert.deepEqual(fares(o.cabins[0]!, adults, "2027-05-09").map((f) => f.amount), [536.79, 536.79, 308.79]);
  const noTerms = quoteOptions({ group: group({ terms: null }), cabins: cabins(), travel: [] }, "en");
  assert.deepEqual(fares(noTerms.cabins[0]!, adults, "2027-05-09").map((f) => f.amount), [536.79, 536.79, 536.79], "no reduced fare on the file: the per-person fare, never a guess");
});

test("the quote adds up only what the file prices: insurance per person × party; every flight, hotel and transfer waits for Mark's finalized quote (Mark 2026-11-07), 'Mark quotes it' for the rest; deposit and balance", () => {
  const file = { group: group({ line_protection: "MSC Cruise Protection: $99 per person" }), cabins: cabins(), travel: travel() };
  const q = buildQuote(file, [...two, { legal_name: "Uncle Millham", dob: "1970-01-01" }], { cabin: "BB", flexpay: true, drinks: true, insurance: "line", travel: ["f1", "h1", "t2"], needs: {} }, "en", new Date("2026-11-01T12:00:00Z"));
  assert.deepEqual(q.lines.map((l) => [l.key, l.label, l.detail, l.amount, l.amountText, l.toQuote]), [
    ["cabin", "Balcony Bella · 3 travelers", "Mark $536.79 · Ceci $536.79 · Uncle $308.79 (third or fourth guest fare) · taxes and port fees included", 1382.37, "$1,382.37", false],
    ["drinks", "Drink package", "Mark prices it for your party", null, null, true],
    ["insurance", "Travel insurance: MSC Cruise Protection", "$99 per person × 3", 297, "$297", false],
    ["travel-f1", "Flight from Raleigh (RDU)", "Mark quotes it", null, null, true],
    ["travel-h1", "Hotel the night before in Orlando (1 night)", "Mark quotes it", null, null, true],
    ["travel-t2", "Cruise port to the airport", null, 0, "included in the cruise price", false],
    ["flexpay", "FlexPay", "Mark sends you the application next; it sets its own payment schedule and changes nothing on this quote", null, null, false],
  ]);
  assert.deepEqual([q.total, q.totalText, q.toQuote, q.deposit, q.depositText, q.depositPerPersonText, q.balance, q.balanceText, q.finalPaymentText, q.party, q.computed_at],
    [1679.37, "$1,679.37", ["Drink package", "Flight from Raleigh (RDU)", "Hotel the night before in Orlando (1 night)"], 150, "$150", "$50", 1529.37, "$1,529.37", "January 15, 2027", 3, "2026-11-01T12:00:00.000Z"]);
  assert.equal(quoteSummary(q, quoteOptions(file, "en")), "Balcony Bella · FlexPay yes · drinks yes · insurance: MSC Cruise Protection · Flight from Raleigh (RDU), Hotel the night before in Orlando (1 night), Cruise port to the airport · total $1,679.37 + 3 to price");
  // taxes not included: their own line; no deposit on the file: no deposit and no balance, never a made-up one
  const taxed = buildQuote({ ...file, group: group({ marketing: { taxes_included: false }, deposit_per_person: null, final_payment_due: null }) }, two, { cabin: "BA", flexpay: false, drinks: false, insurance: "own", travel: [], needs: {} }, "en");
  assert.deepEqual(taxed.lines.map((l) => [l.key, l.amountText]), [["cabin", "$1,373.58"], ["taxes", "$136"], ["insurance", null]]);
  assert.deepEqual([taxed.total, taxed.deposit, taxed.depositText, taxed.balance, taxed.finalPaymentText, taxed.toQuote], [1509.58, null, null, null, null, []]);
  assert.throws(() => buildQuote(file, two, { cabin: "IB", flexpay: false, drinks: false, insurance: "own", travel: [], needs: {} }, "en"), /not one of the group's/);
});

test("a stored quote is read back only when it is one; the first free cabin of the chosen category is where the travelers go", () => {
  assert.equal(storedQuote(null), null);
  assert.equal(storedQuote({ version: 2, answers: {}, lines: [], category: "x" }), null);
  const q = buildQuote({ group: group(), cabins: cabins(), travel: [] }, two, { cabin: "BB", flexpay: false, drinks: false, insurance: "decline", travel: [], needs: { flight: false, hotel: false, transfer: false } }, "en");
  assert.equal(storedQuote(JSON.parse(JSON.stringify(q)))?.category, "Balcony Bella");
  const o = quoteOptions({ group: group(), cabins: cabins(), travel: [] }, "en");
  assert.equal(freeCabinFor(cabins(), o.cabins[0]!, new Set())?.["id"], "c1");
  assert.equal(freeCabinFor(cabins(), o.cabins[0]!, new Set(["c1"]))?.["id"], "c2");
  assert.equal(freeCabinFor(cabins(), o.cabins[0]!, new Set(["c1", "c2"])), null, "a booked cabin is never offered");
  assert.equal(freeCabinFor(cabins(), o.cabins[1]!, new Set())?.["id"], "c4");
});

test("the insurance answer on the quote is kept on the traveler's file the way the paperwork keeps its own choice, so the insurance step opens with it chosen (Mark 2026-11-06)", () => {
  const g = group({ line_protection: "CruiseCare: $89 per person", insurance_plans: "OneTrip Prime: $142 per person\nOneTrip Premier: $210 per person" });
  const o = quoteOptions({ group: g, cabins: cabins(), travel: [] }, "en");
  const a = { cabin: "BB", flexpay: false, drinks: false, travel: [], needs: {} };
  assert.deepEqual(insuranceSeedOf(o, { ...a, insurance: "decline" }, g["line_protection"]), { choice: "decline", plan: null });
  assert.deepEqual(insuranceSeedOf(o, { ...a, insurance: "own" }, g["line_protection"]), { choice: "own", plan: null }, "the company and policy number are asked on the page");
  assert.deepEqual(insuranceSeedOf(o, { ...a, insurance: "line" }, g["line_protection"]), { choice: "line", plan: "CruiseCare: $89 per person" }, "the line's plan as Mark typed it, the text the page's own choice keeps");
  assert.deepEqual(insuranceSeedOf(o, { ...a, insurance: "allianz-1" }, g["line_protection"]), { choice: "quote", plan: "OneTrip Premier: $210 per person" }, "the Allianz plan in the words the insurance step offers, so it comes pre-picked");
  const bare = quoteOptions({ group: group(), cabins: cabins(), travel: [] }, "en");
  assert.deepEqual(insuranceSeedOf(bare, { ...a, insurance: "quote" }, null), { choice: "quote", plan: null }, "'quote me' with no plan on the file yet: yes to insurance, the plan picked once there is a price");
  assert.equal(insuranceSeedOf(bare, { ...a, insurance: "line" }, null), null, "an answer the options never offered seeds nothing");
});
