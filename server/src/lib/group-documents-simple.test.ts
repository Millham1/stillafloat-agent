// group-documents-simple.test.ts — the two-document packet (Mark 2026-10-29): About you and Your booking render from the
// file, carry every input the page asks for, and print as clean forms; the cabin and price come from the file, never typed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAnswers, blocksFor, blocksToText, buildCtx, fillBlocks, packetFor, renderDocument } from "./group-documents";
import { renderFormPdf } from "./group-form-pdf";
import { BUSINESS } from "./group-secure";

const NOW = new Date("2026-10-29T05:00:00Z");
const GROUP = {
  id: "g1", name: "Friends and Family 2027", cruise_line: "MSC Cruises", ship_name: "MSC Seashore", sail_date: "2027-05-09", return_date: "2027-05-13", nights: 4,
  embark_port: "Port Canaveral", itinerary: [{ day: 1, port: "Port Canaveral" }, { day: 2, port: "Nassau" }, { day: 3, port: "Ocean Cay" }],
  group_number: "GRP1", cabins_held: 11, deposit_per_person: 50, deposit_due: null, final_payment_due: "2027-01-15", fees: {},
  terms: { cabin_categories: [{ category: "Balcony Bella", code: "BB", price_per_person: 536.79, deposit_per_person: 50 }], deposit_timing: "at_booking",
    cancellation_schedule: [{ from_days: 121, to_days: 91, penalty: "25% of the cruise fare" }, { from_days: 90, to_days: 0, penalty: "100% of the cruise fare" }] },
};
const CABINS = [{ id: "c1", cabin_num: null, category: "Balcony Bella", category_code: "BB", booking_number: "TEST-0001", price_total: 1073.58 }];
const TRAVELERS = [
  { id: "t1", cabin_id: "c1", is_lead: true, first_name: "Mark", last_name: "Millham", email: "mark@example.com", form_data: { address: "100 Goodsell Ct", city_state_zip: "Fuquay Varina, NC 27526" } },
  { id: "t2", cabin_id: "c1", is_lead: false, first_name: "Pat", last_name: "Guest", form_data: {} },
];
const ctx = (traveler = TRAVELERS[0], over: Record<string, unknown> = {}) => buildCtx({ business: BUSINESS, group: { ...GROUP, ...over }, cabins: CABINS, travelers: TRAVELERS, traveler, now: NOW });

test("every traveler gets About you then Your booking, the cabin's lead the card authorization too; a fee agreement slots between; the organizer keeps the contract", () => {
  assert.deepEqual(packetFor({ group: GROUP, cabin: CABINS[0], traveler: TRAVELERS[0] }), ["20-about-you", "21-your-booking", "22-card-authorization"], "the cabin's lead also authorizes the card");
  assert.deepEqual(packetFor({ group: GROUP, cabin: CABINS[0], traveler: TRAVELERS[1] }), ["20-about-you", "21-your-booking"]);
  assert.deepEqual(packetFor({ group: { ...GROUP, fees: { planning_fee: 100 } }, cabin: CABINS[0], traveler: TRAVELERS[1] }),
    ["20-about-you", "02-travel-planning-agreement", "03-service-fee-planning-fee-agreement", "21-your-booking"]);
  assert.deepEqual(packetFor({ group: GROUP, organizer: true }), ["09-group-travel-contract"]);
});

test("About you: the cruise from the file at the top, every question as an input, nothing legal, one confirmation signature", () => {
  const d = renderDocument("20-about-you", ctx());
  assert.equal(d.title, "About you");
  for (const s of ["Friends and Family 2027", "MSC Cruises · MSC Seashore", "May 9, 2027", "May 13, 2027"]) assert.ok(d.text.includes(s), s);
  assert.deepEqual(d.fields.map((f) => f.name), [
    "legal_name", "dob", "gender", "us_citizen", "citizenship", "address", "city_state_zip", "phone", "email",
    "passport_number", "passport_country", "passport_issue", "passport_expiry", "loyalty_1_program", "loyalty_1_number", "loyalty_2_program", "loyalty_2_number",
    "ec1_name", "ec1_relationship", "ec1_cell_phone", "notes",
  ]);
  assert.ok(!/liab|waive|arbitration/i.test(d.text), "no legal wording on the data document");
  assert.ok(!d.text.includes("Traveler Signature"), "the template's own signature lines are replaced by the typed signature on screen");
  assert.deepEqual(d.unfilled, []);
  const a = applyAnswers(d, { legal_name: "Mark Millham", dob: "1965-04-12", gender: "male", us_citizen: "yes", address: "100 Goodsell Ct", city_state_zip: "Fuquay Varina, NC 27526",
    phone: "9193466127", email: "mark@example.com", ec1_name: "Pat Guest", ec1_relationship: "Spouse", ec1_cell_phone: "9195550100", notes: "Gluten free" }, ctx());
  assert.ok(a.ok, JSON.stringify(a));
  if (a.ok) {
    assert.equal(a.travelerPatch["emergency_phone"], "9195550100");
    assert.equal(a.travelerPatch["citizenship"], "United States");
    assert.equal(a.travelerPatch["special_needs"], "Gluten free");
    assert.equal(a.travelerPatch["gender"], "Male");
  }
});

test("Your booking: cabin, fare, deposit and dates from the file; the line's schedule in its table; the three insurance options; one signature", () => {
  const d = renderDocument("21-your-booking", ctx());
  assert.equal(d.title, "Your booking");
  for (const s of ["Balcony Bella (BB)", "Cabin number: To be assigned", "as quoted (taxes included): $ 536.79", "Deposit per person: $ 50", "Deposit due: When you book",
    "Final payment due: January 15, 2027", "Booking number: TEST-0001", "Traveler: Mark Millham", "Address: 100 Goodsell Ct, Fuquay Varina, NC 27526", "Port Canaveral", "Ports: Port Canaveral, Nassau, Ocean Cay",
    "six months past May 13, 2027", "91–121 days", "100% of the cruise fare", "Raleigh, North Carolina", "mark@stillafloatcruising.com"]) assert.ok(d.text.includes(s), s);
  assert.ok(!/\[AGENT|\[City, State\]|\{\{bl:/.test(d.text), "no placeholder and no unfilled blank");
  assert.deepEqual(d.fields.map((f) => f.name), ["insurance_choice", "insurance_policy"]);
  assert.deepEqual(d.unfilled, []);
  const own = applyAnswers(d, { insurance_choice: "own" }, ctx());
  assert.ok(!own.ok && own.errors["insurance_policy"], "own policy needs its provider and number");
  const decline = applyAnswers(d, { insurance_choice: "decline" }, ctx());
  assert.ok(decline.ok);
  if (decline.ok) assert.deepEqual(decline.formData, { insurance: { choice: "decline" } });
  const filled = blocksToText(fillBlocks(d, { insurance_choice: "quote" }, NOW));
  assert.ok(filled.includes("☒ Yes, quote me insurance through Mark.") && filled.includes("☐ I decline"), filled.slice(-900));
  assert.ok(filled.includes("Date: October 29, 2026"));
});

test("Credit card authorization: the booking and total from the file, last four and expiry only, the nine points, the lead signs", () => {
  const d = renderDocument("22-card-authorization", ctx());
  assert.equal(d.title, "Credit card authorization");
  for (const s of ["Total authorized: $ 1,073.58", "Booking number: TEST-0001", "Balcony Bella (BB)", "last four digits of my card", "ESIGN Act"]) assert.ok(d.text.includes(s), s);
  assert.deepEqual(d.fields.map((f) => f.name), ["card_name", "card_address", "card_city_state_zip", "card_phone", "card_type", "card_last4", "card_expiry"]);
  assert.equal(d.fields[0]!.prefill!(ctx()), "Mark Millham", "the cardholder's name starts as the traveler's");
  const good = { card_name: "Mark Millham", card_address: "100 Goodsell Ct", card_city_state_zip: "Fuquay Varina, NC 27526", card_phone: "9193466127", card_type: "visa", card_last4: "6666", card_expiry: "03/30" };
  assert.ok(applyAnswers(d, good, ctx()).ok);
  const bad = applyAnswers(d, { ...good, card_last4: "4111111111111111", card_expiry: "13/30" }, ctx());
  assert.ok(!bad.ok && bad.errors["card_last4"] && bad.errors["card_expiry"], JSON.stringify(bad));
  const whole = applyAnswers(d, { ...good, card_address: "4111 1111 1111 1111" }, ctx());
  assert.ok(!whole.ok && /never collected/.test(whole.errors["card_address"] ?? ""), "a card number typed anywhere is refused");
  assert.ok(blocksToText(fillBlocks(d, good, NOW)).includes("☒ Visa"));
});

test("Your booking reports what the file cannot fill instead of guessing, and its hash moves with the file", () => {
  const bare = renderDocument("21-your-booking", ctx(TRAVELERS[1], { terms: {}, deposit_per_person: null, final_payment_due: null, deposit_due: null }));
  assert.ok(bare.unfilled.includes("Cruise fare per person") && bare.unfilled.includes("Deposit per person") && bare.unfilled.includes("Final payment due") && bare.unfilled.includes("Address"), bare.unfilled.join(", "));
  assert.ok(bare.text.includes("As published by the cruise line"), "no schedule on file: the template's own line stays");
  assert.notEqual(renderDocument("21-your-booking", ctx()).sha256, renderDocument("21-your-booking", ctx(TRAVELERS[0], { return_date: "2027-05-14" })).sha256);
});

test("both print as clean forms with the business named, the answers on their lines and the signature taken", async () => {
  for (const key of ["20-about-you", "21-your-booking", "22-card-authorization"]) {
    const said: string[] = [];
    const { spec, blocks } = blocksFor(key, ctx(), { paper: true });
    const pdf = await renderFormPdf({ title: spec.title, businessName: BUSINESS.legalName, blocks, answers: { legal_name: "Mark Millham", insurance_choice: "quote" }, today: "October 29, 2026", signer: "Mark Millham", onText: (w) => said.push(w) });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-", key);
    const text = said.join(" ");
    assert.ok(text.includes("Still Afloat LLC dba Still Afloat Cruising"), key);
    assert.ok(text.includes("/s/ Mark Millham"), `${key}: the typed signature`);
    assert.ok(!/\[AGENT|\[INSERT|\{\{/.test(text), `${key}: no placeholder`);
  }
});
