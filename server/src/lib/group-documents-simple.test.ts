// group-documents-simple.test.ts — the two-document packet (Mark 2026-10-29): About you and Your booking render from the
// file, carry every input the page asks for, and print as clean forms; the cabin and price come from the file, never typed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAnswers, askedOf, blocksFor, blocksToText, buildCtx, fillBlocks, packetFor, prefillValue, renderDocument } from "./group-documents";
import { INSURANCE_CHOICE_FIELDS } from "./group-document-specs";
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
  assert.deepEqual(packetFor({ group: GROUP, cabin: CABINS[0], traveler: TRAVELERS[0] }), ["15-emergency-contact-form", "01-terms-and-conditions", "07-travel-insurance-declination", "05-liability-waiver", "16-passport-document-checklist", "12-cruise-booking-agreement", "22-card-authorization"], "Mark 2026-10-30: the six live documents plus the card authorization; the cabin's lead signs the booking agreement and authorizes the card");
  assert.deepEqual(packetFor({ group: GROUP, cabin: CABINS[0], traveler: TRAVELERS[1] }), ["15-emergency-contact-form", "01-terms-and-conditions", "07-travel-insurance-declination", "05-liability-waiver", "16-passport-document-checklist"]);
  assert.deepEqual(packetFor({ group: { ...GROUP, fees: { planning_fee: 100 } }, cabin: CABINS[0], traveler: TRAVELERS[1] }),
    ["15-emergency-contact-form", "01-terms-and-conditions", "02-travel-planning-agreement", "03-service-fee-planning-fee-agreement", "07-travel-insurance-declination", "05-liability-waiver", "16-passport-document-checklist"]);
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
  assert.deepEqual(d.fields.map((f) => f.name), ["cardholder", "card_name", "card_email", "card_address", "card_city_state_zip", "card_phone", "card_type", "card_last4", "card_expiry", "dl_state", "dl_number"]);
  assert.ok(d.text.includes("Identity verification") && d.text.includes("Driver's licence:"), "the licence line and Cornerstone's identity point");
  assert.ok(d.text.includes("The card belongs to:"), "whose card it is, on the form (Mark 2026-10-30)");
  const good = { cardholder: "other", card_name: "Jane Public", card_email: "jane@example.com", card_address: "1 Main St", card_city_state_zip: "Raleigh, NC 27601", card_phone: "9195550100", card_type: "visa", card_last4: "6666", card_expiry: "03/30", dl_state: "NC", dl_number: "0000554321" };
  const ok = applyAnswers(d, good, ctx());
  assert.ok(ok.ok, JSON.stringify(ok));
  if (ok.ok) {
    assert.deepEqual(ok.license, { number: "0000554321", last4: "4321" }, "the licence number is handed back only to be encrypted");
    assert.equal(ok.answers["dl_number"], "ending 4321", "the signature's answers never hold the licence number");
    assert.deepEqual([ok.travelerPatch["dl_last4"], ok.travelerPatch["dl_state"]], ["4321", "NC"]);
  }
  const badDl = applyAnswers(d, { ...good, dl_number: "x" }, ctx());
  assert.ok(!badDl.ok && badDl.errors["dl_number"]);
  const bad = applyAnswers(d, { ...good, card_last4: "4111111111111111", card_expiry: "13/30" }, ctx());
  assert.ok(!bad.ok && bad.errors["card_last4"] && bad.errors["card_expiry"], JSON.stringify(bad));
  const whole = applyAnswers(d, { ...good, card_address: "4111 1111 1111 1111" }, ctx());
  assert.ok(!whole.ok && /never collected/.test(whole.errors["card_address"] ?? ""), "a card number typed anywhere is refused");
  assert.ok(blocksToText(fillBlocks(d, good, NOW)).includes("☒ Visa"));
  assert.ok(blocksToText(fillBlocks(d, good, NOW)).includes("☒ someone else, named below") && blocksToText(fillBlocks(d, good, NOW)).includes("Jane Public"), "someone else's card: that person on the form");
  // Mark 2026-10-30: the traveler's own card needs nothing more from them: the cardholder lines come from the file, the licence is theirs
  const mine = applyAnswers(d, { cardholder: "me", card_type: "visa", card_last4: "6666", card_expiry: "03/30", dl_state: "NC", dl_number: "0000554321" }, ctx());
  assert.ok(mine.ok, JSON.stringify(mine));
  if (mine.ok) {
    assert.deepEqual([mine.answers["card_name"], mine.answers["card_address"], mine.answers["card_city_state_zip"], mine.answers["card_email"]], ["Mark Millham", "100 Goodsell Ct", "Fuquay Varina, NC 27526", "mark@example.com"], "the traveler on file is the cardholder");
    assert.equal((mine.formData["card"] as Record<string, unknown>)["holder"], "me");
    const printed = blocksToText(fillBlocks(d, mine.answers, NOW));
    assert.ok(printed.includes("☒ me, the traveler named on this booking") && printed.includes("Mark Millham") && printed.includes("Fuquay Varina"), printed);
  }
  const someone = applyAnswers(d, { cardholder: "other", card_type: "visa", card_last4: "6666", card_expiry: "03/30", dl_state: "NC", dl_number: "0000554321" }, ctx());
  assert.ok(!someone.ok && someone.errors["card_name"] && someone.errors["card_address"] && someone.errors["card_phone"], "someone else's card without that person's details is refused");
  const nobody = applyAnswers(d, { card_type: "visa", card_last4: "6666", card_expiry: "03/30", dl_state: "NC", dl_number: "0000554321" }, ctx());
  assert.ok(!nobody.ok && nobody.errors["cardholder"], "whose card it is must be answered");
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

// ── Mark 2026-10-30 ────────────────────────────────────────────────────────────

test("the waiver's advisory level comes from the State Department per port, never asked; the levels are written on the waiver", () => {
  const advisories = [
    { port: "Port Canaveral", country: "United States", level: null, title: "United States (no State Department advisory applies at home)" },
    { port: "Nassau", country: "The Bahamas", level: 2 as const, title: "Level 2: Exercise Increased Caution" },
    { port: "Ocean Cay", country: "The Bahamas", level: 2 as const, title: "Level 2: Exercise Increased Caution" },
  ];
  const c = buildCtx({ business: BUSINESS, group: GROUP, cabins: CABINS, travelers: TRAVELERS, traveler: TRAVELERS[0], now: NOW, advisories });
  const d = renderDocument("05-liability-waiver", c);
  assert.equal(d.fields.find((f) => f.name === "advisory_level")!.prefill!(c), "2", "the highest level on the itinerary ticks the box");
  const filled = blocksToText(fillBlocks(d, { advisory_level: "2", health_ack: true }, NOW));
  assert.ok(filled.includes("Advisory levels for this itinerary on October 29, 2026, from the U.S. Department of State (travel.state.gov): United States: United States (no State Department advisory applies at home) (Port Canaveral); The Bahamas: Level 2: Exercise Increased Caution (Nassau, Ocean Cay)."), filled.slice(filled.indexOf("Advisory levels"), filled.indexOf("Advisory levels") + 300));
  assert.ok(d.text.includes("on [date of signing], from the U.S. Department of State"), "the hashed text carries the marker, not the day");
  const none = renderDocument("05-liability-waiver", ctx());
  assert.equal(none.fields.find((f) => f.name === "advisory_level")!.prefill!(ctx()), "unknown");
  assert.ok(none.text.includes("could not be read from travel.state.gov on [date of signing]"));
});

test("the booking agreement's dining and occasion come from the booking; a line left empty prints as intentionally blank", () => {
  const c = buildCtx({ business: BUSINESS, group: { ...GROUP, marketing: { occasion: "A reunion of old friends" } }, cabins: [{ ...CABINS[0], dining: "Late seating" }], travelers: TRAVELERS, traveler: TRAVELERS[0], now: NOW });
  const d = renderDocument("12-cruise-booking-agreement", c);
  const by = Object.fromEntries(d.fields.map((f) => [f.name, f]));
  assert.equal(by["dining"]!.prefill!(c), "late");
  assert.deepEqual(by["occasions"]!.prefill!(c), ["other"]);
  assert.equal(by["occasion_other"]!.prefill!(c), "A reunion of old friends");
  assert.equal(by["dining"]!.prefill!(ctx()), undefined, "no dining on the file: nothing ticked");
  const filled = blocksToText(fillBlocks(d, { dining: "late", occasions: ["other"], occasion_other: "A reunion of old friends" }, NOW));
  assert.ok(filled.includes("☒ Late Seating") && filled.includes("☒ Other: A reunion of old friends"), filled.slice(filled.indexOf("Dining"), filled.indexOf("Dining") + 400));
  assert.ok(filled.includes("Date of Occasion: N/A — left intentionally blank"), "an empty line on a signed copy says so");
  assert.ok(!renderDocument("12-cruise-booking-agreement", c).text.includes("N/A — left"), "the unsigned text keeps its blanks (the hash)");
});

test("the traveler information form asks no passport place of issue and hides the agent-only lines; the card form says why the licence is asked", () => {
  const d = renderDocument("15-emergency-contact-form", ctx());
  assert.ok(!d.fields.some((f) => f.name === "passport_place"));
  assert.ok(!/Place of Issue|For Agent Use Only|Entered into Client File/.test(d.text), "the client's copy keeps none of these");
  assert.ok(!/\n-{3,}\n-{3,}/.test(d.text), "no doubled rule where the agent block was");
  const card = renderDocument("22-card-authorization", ctx());
  assert.ok(card.text.includes("Why we ask for it: to protect against fraud, Cornerstone Collective asks for the state and number of your driver's licence."));
});

// Mark 2026-10-30: "the quotes should show up right after viewing the insurance video and they make a decision there. then that opens the
// logic chain of what is presented in the documents, either a declination or the approval with the quote."
const withInsurance = (choice: string, plan?: string, over: Record<string, unknown> = {}) => ({ ...TRAVELERS[1], form_data: { insurance: { choice, ...(plan ? { plan } : {}) } }, ...over });
test("the choice made on the page decides the insurance document: the plan (23) for Allianz or the line's own plan, Cornerstone's declination (07) for none or own", () => {
  const at = (t: Record<string, unknown>) => packetFor({ group: GROUP, cabin: CABINS[0], traveler: t })[2];
  assert.equal(at(TRAVELERS[1]), "07-travel-insurance-declination", "no choice yet: the declination holds the slot");
  assert.equal(at(withInsurance("quote", "OneTrip Prime: $129 per person")), "23-insurance-plan");
  assert.equal(at(withInsurance("line", "MSC Protection Plan: $59 per person")), "23-insurance-plan");
  assert.equal(at(withInsurance("own")), "07-travel-insurance-declination");
  assert.equal(at(withInsurance("decline")), "07-travel-insurance-declination");
  assert.deepEqual(INSURANCE_CHOICE_FIELDS.map((f) => f.name), ["insurance_choice", "insurance_plan"], "the page's own lines, not a document's");
  assert.deepEqual(INSURANCE_CHOICE_FIELDS[0]!.options!.map((o) => o.value), ["quote", "line", "own", "decline"]);
  assert.deepEqual(packetFor({ group: GROUP, cabin: CABINS[0], traveler: TRAVELERS[1] }).slice(1, 4), ["01-terms-and-conditions", "07-travel-insurance-declination", "05-liability-waiver"], "the waiver's insurance line follows the choice");
});

test("the plan document carries the plan and price chosen, the provider and who is covered; nothing is asked on it and nothing is worked out", () => {
  const allianz = renderDocument("23-insurance-plan", ctx(withInsurance("quote", "OneTrip Prime: $129 per person") as any));
  assert.equal(allianz.title, "Travel insurance: your plan");
  assert.deepEqual(allianz.fields, [], "nothing to type: the choice was made on the page");
  for (const line of ["Provider: Allianz Global Assistance", "Plan and price: OneTrip Prime: $129 per person", "Covered traveler: Pat Guest", "Traveler: Pat Guest", "Also on this cabin: Mark Millham", "Cruise fare per person, as quoted: $ 536.79", "Pricing subject to change until finalized", "it is not the policy", "charged to the card authorized for this booking", "do not insure me and do not decide claims"]) {
    assert.ok(allianz.text.includes(line), `missing: ${line}\n${allianz.text}`);
  }
  assert.match(allianz.text, /Quoted: By .+ for this sailing, from Allianz's rates/, "a plan from the group file says who quoted it");
  assert.ok(!/\$\s*\d[\d,]*\.?\d*\s*(?!per person)/.test(allianz.text.replace(/\$ 536\.79|\$129 per person/g, "")), "no price the file does not hold");
  const line = renderDocument("23-insurance-plan", ctx(withInsurance("line") as any, { line_protection: "MSC Protection Plan: $59 per person" }));
  assert.ok(line.text.includes("Provider: MSC Cruises") && line.text.includes("Plan and price: MSC Protection Plan: $59 per person") && line.text.includes("Quoted: The cruise line's own protection plan"), line.text);
});

test("the declination is Cornerstone's form with no plan to pick on it: its own boxes say quotes were shown, the provider, and the prices offered (Mark 2026-10-31: 'Show the price')", () => {
  const d = renderDocument("07-travel-insurance-declination", ctx(withInsurance("decline") as any, { insurance_plans: "OneTrip Basic: $89 per person\nOneTrip Prime: $129 per person" }));
  assert.equal(d.title, "Travel insurance declination");
  assert.deepEqual(d.fields.map((f) => f.name), ["decline_reasons", "decline_other"], "only Cornerstone's optional reasons are asked");
  assert.ok(!/YOUR CHOICE|Plan chosen/.test(d.text), "no plan is picked on a declination");
  assert.ok(d.text.includes("☒ Client has been provided with travel insurance quote(s).") && d.text.includes("☒ Client has reviewed insurance options and is declining all coverage."), d.text);
  assert.ok(d.text.includes("Quoted Policy Provider (if applicable): Allianz Global Assistance"));
  assert.ok(d.text.includes("Quoted Premium Amount (if applicable): $ 89 per person for OneTrip Basic; $129 per person for OneTrip Prime"), "the prices offered, as the page showed them: " + d.text);
  assert.ok(!d.unfilled.includes("Quoted premium amount"));
  const noPrice = renderDocument("07-travel-insurance-declination", ctx(withInsurance("decline") as any));
  assert.ok(noPrice.text.includes("Quoted Premium Amount (if applicable): $ ________") && noPrice.unfilled.includes("Quoted premium amount"), "no price was shown: the line stays a blank");
  const own = renderDocument("07-travel-insurance-declination", ctx(withInsurance("own") as any));
  assert.ok(own.text.includes("☐ Client has been provided with travel insurance quote(s).") && own.text.includes("☐ Client has reviewed insurance options and is declining all coverage."), "no plans shown, and own cover is not declining all coverage");
  assert.deepEqual(prefillValue(own.fields[0]!, ctx(withInsurance("own") as any)), ["existing"], "a policy of their own pre-ticks Cornerstone's first reason");
  assert.equal(prefillValue(d.fields[0]!, ctx(withInsurance("decline") as any)), undefined);
});

// Mark 2026-10-30: "for the CC, build the link to be sent to the owner of the card if that choice is selected"
test("someone else's card leaves the lead's packet; the owner's own packet is the card authorization alone, with the lines that are theirs", () => {
  const lead = { ...TRAVELERS[0], form_data: { ...TRAVELERS[0].form_data, card: { holder: "other", name: "Pat Payer", email: "pat@example.com" } } };
  assert.deepEqual(packetFor({ group: GROUP, cabin: CABINS[0], traveler: lead }).slice(-2), ["16-passport-document-checklist", "12-cruise-booking-agreement"], "no card authorization in the lead's packet");
  assert.deepEqual(packetFor({ group: GROUP, cabin: CABINS[0], traveler: { ...TRAVELERS[0], form_data: { card: { holder: "me" } } } }).slice(-1), ["22-card-authorization"]);
  assert.deepEqual(packetFor({ group: GROUP, cardholder: true }), ["22-card-authorization"]);
  const d = renderDocument("22-card-authorization", ctx(lead as any));
  assert.deepEqual(askedOf(d.fields, "lead").map((f) => f.name), ["cardholder", "card_name", "card_email", "card_type", "card_last4", "card_expiry", "dl_state", "dl_number"], "the lead names the owner and their email; the billing lines are the owner's");
  assert.deepEqual(askedOf(d.fields, "cardholder").map((f) => f.name), ["card_name", "card_address", "card_city_state_zip", "card_phone", "card_type", "card_last4", "card_expiry", "dl_state", "dl_number"], "the owner is not asked whose card it is or their own email");
  assert.ok(d.text.includes("Email: ________"), "the owner's email is on the form");
  assert.equal(prefillValue(d.fields.find((f) => f.name === "card_name")!, ctx(lead as any)), "Pat Payer", "the owner's page starts with the name the lead gave");
});
