import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOC_SPECS, TEMPLATE_VERSION_DATE, applyAnswers, blocksToText, buildCtx, fillBlocks, getPath, markdownToHtml, packetFor, parseBlocks,
  prefillValue, publicField, renderDocument, separateGluedHeadings, unescapeConnectorMarkdown,
} from "./group-documents";
import { BUSINESS } from "./group-secure";
import { CLIENT_DOCUMENTS } from "../content/client-documents";

const NOW = new Date("2026-10-16T15:30:00Z");

const GROUP = {
  id: "g1", name: "American Legion Post 12 Alaska 2027", cruise_line: "MSC Cruises", ship_name: "MSC Seascape",
  sail_date: "2027-03-14", return_date: "2027-03-21", nights: 7, embark_port: "Port Canaveral",
  itinerary: [{ day: 1, port: "Port Canaveral" }, { day: 2, port: "At Sea" }, { day: 3, port: "Nassau" }, { day: 4, port: "Ocean Cay" }],
  group_number: "GRP123", cabins_held: 16, deposit_per_person: 250, deposit_due: "2026-12-01", final_payment_due: "2027-01-12",
  amenities: ["$50 onboard credit per cabin"], organizer_name: "Pat Organizer", organizer_email: "pat@example.com", organizer_phone: "555-123-4567",
  fees: {},
  terms: {
    cabin_categories: [{ category: "Balcony", code: "8C", price_per_person: 1299, deposit_per_person: 250 }],
    final_payment_days_before: 90, deposit_timing: "by_date",
    cancellation_schedule: [
      { from_days: 121, to_days: 91, from_date: "2026-11-13", to_date: "2026-12-13", penalty: "25% of the cruise fare", percent: 25 },
      { from_days: 90, to_days: 0, from_date: "2026-12-14", to_date: "2027-03-14", penalty: "100% of the cruise fare", percent: 100 },
    ],
    cancellation_note: "Insurance premiums are non-refundable.",
  },
};
const CABINS = [{ id: "c1", cabin_num: "8214", category: "Balcony", category_code: "8C", booking_number: "BK77", price_total: 2598, deposit_amount: 500 }];
const TRAVELERS = [
  { id: "t1", cabin_id: "c1", is_lead: true, first_name: "Jane", last_name: "Public", dob: "1960-05-04", email: "jane@example.com", phone: "555-111-2222", form_data: { address: "1 Main St", city_state_zip: "Raleigh, NC 27601" } },
  { id: "t2", cabin_id: "c1", first_name: "John", middle_name: "Q", last_name: "Public", dob: "1958-01-09", passport_last4: "4321", passport_expiry: "2030-01-01", passport_enc: "v1:SECRETCIPHER", passport_number: "X99887766" },
];
const ctxFor = (over: Record<string, unknown> = {}, traveler: Record<string, unknown> | null = TRAVELERS[0]!) =>
  buildCtx({ business: BUSINESS, group: { ...GROUP, ...over }, cabins: CABINS, travelers: TRAVELERS, traveler, now: NOW });
const KEYS = Object.keys(DOC_SPECS);

// ── the connector's escaping ──────────────────────────────────────────────────

test("the connector's markdown escaping is undone, including the doubled escapes inside tables", () => {
  const md = unescapeConnectorMarkdown("**\\[AGENT NAME / BUSINESS NAME\\]**\n\n## 1\\. ACCEPTANCE \\#\n\nNo\\*thing\\! \\\\ done\n\n| a | \\\\\\_\\\\\\_\\\\\\_\\\\\\_ | Passport \\\\\\# |\n<!-- end list -->");
  assert.ok(md.includes("**[AGENT NAME / BUSINESS NAME]**"));
  assert.ok(md.includes("## 1. ACCEPTANCE #"));
  assert.ok(md.includes("No*thing! \\ done"));
  assert.ok(md.includes("| a | ____ | Passport # |"), md);
  assert.ok(!md.includes("end list"));
});

test("a bold heading the connector glued to its sentence gets a space, and bold spans are never mis-paired", () => {
  assert.equal(separateGluedHeadings("**3.1 Deposits**A deposit"), "**3.1 Deposits** A deposit");
  assert.equal(separateGluedHeadings("**1. Non-Refundable** All fees are **non-refundable**, ok"), "**1. Non-Refundable** All fees are **non-refundable**, ok");
  assert.equal(separateGluedHeadings("**Yes**☐ No"), "**Yes** ☐ No");
});

test("the markdown dialect parses to blocks: headings, rules, lists that the connector split, and tables with a promoted header", () => {
  const blocks = parseBlocks("# T\n\n-----\n\n## H\n\npara one\nline two\n\n  - a\n\n  - b\n\n1.  x\n2.  y\n\n|  |  |\n| :-: | :-: |\n| Name | Rel |\n|   |   |\n|   |   |");
  assert.deepEqual(blocks[0], { t: "h", level: 1, text: "T" });
  assert.deepEqual(blocks[1], { t: "hr" });
  assert.deepEqual(blocks[3], { t: "p", text: "para one\nline two" });
  assert.deepEqual(blocks[4], { t: "ul", items: ["a", "b"] });
  assert.deepEqual(blocks[5], { t: "ol", items: ["x", "y"] });
  assert.deepEqual(blocks[6], { t: "table", header: ["Name", "Rel"], rows: [["", ""], ["", ""]] });
});

test("markdown becomes html: headings, bold, italic, lists, tables, boxes, printed blanks, and inputs only where a field is named", () => {
  const html = markdownToHtml("## 1\\. TERMS\n\n**Name:** {{in:name}} and *more* ☐ Yes ____\n\n  - one <b>\n\n|  |  |\n| :-: | :-: |\n| A | B |\n| x | y |", {
    fields: [{ name: "name", label: "Your name", kind: "text" }],
  });
  assert.ok(html.includes('<h3 class="doc-h">1. TERMS</h3>'), html);
  assert.ok(html.includes("<strong>Name:</strong>") && html.includes("<em>more</em>"));
  assert.ok(html.includes('<input class="doc-in" type="text" name="name" data-field="name"') && html.includes('aria-label="Your name"'));
  assert.ok(html.includes('<span class="box">☐</span>') && html.includes('<span class="blank"></span>'));
  assert.ok(html.includes("<li>one &lt;b&gt;</li>"), "text is escaped");
  assert.ok(html.includes("<th>A</th><th>B</th>") && html.includes("<td>x</td><td>y</td>"));
  assert.ok(!markdownToHtml("Name: ____").includes("<input"), "a blank no field names is only printed");
});

// ── every template renders, and carries Mark's rulings ────────────────────────

test("every client document renders with a full file and with an empty one, with no template placeholders left", () => {
  for (const ctx of [ctxFor(), ctxFor({}, null), buildCtx({ business: BUSINESS, group: { id: "g2", name: "Bare", fees: {} }, now: NOW })]) {
    for (const key of KEYS.filter((k) => !DOC_SPECS[k]!.requiresFees)) {
      const d = renderDocument(key, ctx);
      assert.ok(d.text.length > 1500, `${key} is suspiciously short`);
      for (const bad of ["[AGENT NAME", "[AGENT CONTACT", "[INSERT LOGO", "[City, State]", "[list accepted", "\\_", "\\[", "{{", "<!--"]) {
        assert.ok(!d.text.includes(bad), `${key} still contains ${bad}`);
        assert.ok(!d.html.includes(bad), `${key} html still contains ${bad}`);
      }
      assert.ok(d.text.includes(BUSINESS.legalName), `${key} does not name the business`);
      assert.ok(d.text.includes("Affiliate of Cornerstone Collective"), `${key} lost the Cornerstone affiliate line`);
      assert.ok(d.text.includes("Seller of Travel: CA #2158353-50 | FL #ST44927 | WA #605824620"), `${key} lost the Seller of Travel footer`);
      assert.equal(d.version, `${key}@${TEMPLATE_VERSION_DATE}`);
      assert.match(d.sha256, /^[0-9a-f]{64}$/);
    }
  }
});

test("the business is written exactly as Still Afloat LLC dba Still Afloat Cruising, the contact line and venue as Mark ruled", () => {
  const d = renderDocument("01-terms-and-conditions", ctxFor());
  assert.ok(d.text.includes("Still Afloat LLC dba Still Afloat Cruising will make reasonable efforts to notify you"));
  assert.ok(!/Still Afloat LLC(?! dba)/.test(d.text), "the legal name appears without the dba");
  assert.ok(d.text.includes("Mark Millham · mark@stillafloatcruising.com · 919-346-6127 · Raleigh, North Carolina"));
  assert.ok(d.text.includes("binding arbitration in Raleigh, North Carolina in accordance"));
  assert.ok(d.text.includes("Payments are made directly to the cruise line or supplier by the client. All payments must be made in U.S. dollars"));
  assert.ok(d.text.includes("Last Updated: October 3, 2026"));
  assert.ok(d.html.includes(`<img class="doc-logo" src="/assets/images/still_afloat_logo.png"`));
});

test("without a template-date drift: the hashed text carries no logo and the signing date is a stable marker", () => {
  const d = renderDocument("05-liability-waiver", ctxFor());
  assert.ok(d.text.includes("Date: [date of signing]"));
  assert.ok(!d.text.includes("2026-10-16") && !d.text.includes("October 16, 2026"));
  assert.ok(d.html.includes("October 16, 2026"), "the page shows today's date");
});

// ── no fees unless Mark entered one ───────────────────────────────────────────

test("with no fees on the file, the fee sections and lines are gone and the rest of each template stays", () => {
  const terms = renderDocument("01-terms-and-conditions", ctxFor()).text;
  assert.ok(!/Service Fees|Change Fees|3\.4|4\.3/.test(terms), "terms 3.4 / 4.3 should be removed");
  assert.ok(terms.includes("3.3 Pricing") && terms.includes("4.2 Supplier-Initiated Changes") && terms.includes("5. TRAVEL INSURANCE"));
  const contract = renderDocument("09-group-travel-contract", ctxFor({}, null)).text;
  for (const gone of ["retainer fee", "4.3", "Agent Planning Fee", "substitution processing fee"]) assert.ok(!contract.includes(gone), `contract still has: ${gone}`);
  assert.ok(contract.includes("Substitution of a confirmed traveler with a new traveler may be permitted"), "the rest of the substitutions paragraph stays");
  assert.ok(contract.includes("Individual traveler deposits (per person)"));
  const booking = renderDocument("12-cruise-booking-agreement", ctxFor()).text;
  assert.ok(!/Agent Planning|Agent Cancellation|Processing Fee/.test(booking));
  assert.ok(booking.includes("Port Taxes") === false, "rows the file cannot price are left out, not printed blank");
  const policy = renderDocument("04-cancellation-policy", ctxFor()).text;
  assert.ok(!/AGENT SERVICE FEES|Non-Refundable Fees|Processing Fee/.test(policy));
  assert.ok(policy.includes("PART 2: SUPPLIER CANCELLATION POLICIES") && policy.includes("PART 3: HOW TO CANCEL"));
});

test("with fees on the file, they are listed and the fee blanks are filled from the file", () => {
  const fees = { planning_fee: 150, change_fee: { amount: 50, per: "per change" }, substitution_fee: 75, bogus: "free", negative: -5 };
  const ctx = ctxFor({ fees });
  assert.deepEqual(ctx.fees.map((f) => f.key), ["planning_fee", "change_fee", "substitution_fee"]);
  const terms = renderDocument("01-terms-and-conditions", ctx).text;
  assert.ok(terms.includes("3.4 Service Fees") && terms.includes("- Planning fee: $150") && terms.includes("- Change / rebooking fee: $50 per change"));
  const contract = renderDocument("09-group-travel-contract", ctxFor({ fees }, null)).text;
  assert.ok(contract.includes("A group planning fee of $ 150 is due upon signing"));
  assert.ok(contract.includes("A substitution processing fee of $ 75 may apply"));
  const planning = renderDocument("02-travel-planning-agreement", ctx).text;
  assert.ok(planning.includes("planning fee of $ 150") && planning.includes("fees of $ 50 per change"));
  const fee03 = renderDocument("03-service-fee-planning-fee-agreement", ctx).text;
  assert.ok(fee03.includes("Planning fee | $150 | —") && fee03.includes("Change / rebooking fee | $50 | per change"));
});

test("the fee agreements do not exist for a file with no fees", () => {
  for (const key of ["02-travel-planning-agreement", "03-service-fee-planning-fee-agreement"]) {
    assert.throws(() => renderDocument(key, ctxFor()), /only issued when the group file carries a fee/);
  }
});

// ── the cruise line's own cancellation schedule ───────────────────────────────

test("the line's own cancellation schedule replaces the typical table in 12 and 04, with calendar dates, and the booking-confirmation sentence stays", () => {
  for (const key of ["12-cruise-booking-agreement", "04-cancellation-policy"]) {
    const t = renderDocument(key, ctxFor()).text;
    assert.ok(t.includes("91–121 days | November 13, 2026 – December 13, 2026 | 25% of the cruise fare"), `${key}: ${t.slice(t.indexOf("Days before"), t.indexOf("Days before") + 300)}`);
    assert.ok(t.includes("0–90 days | December 14, 2026 – March 14, 2027 | 100% of the cruise fare"));
    assert.ok(t.includes("Insurance premiums are non-refundable."));
    assert.ok(!t.includes("Typical Penalty") || key === "04-cancellation-policy", "the typical table is gone from 12");
    assert.ok(!t.includes("121+ days | Deposit"), "the typical cruise rows are gone");
  }
  const booking = renderDocument("12-cruise-booking-agreement", ctxFor()).text;
  assert.ok(booking.includes("The following is the cruise line's own cancellation schedule for this sailing. Specific terms applicable to your booking will be confirmed in writing at time of booking."));
  assert.ok(renderDocument("04-cancellation-policy", ctxFor()).text.includes("Check your booking confirmation for the exact terms applicable to your reservation."));
});

test("with no schedule on the file the template's own cancellation text is unchanged", () => {
  const ctx = ctxFor({ terms: { ...GROUP.terms, cancellation_schedule: [] } });
  const t = renderDocument("12-cruise-booking-agreement", ctx).text;
  assert.ok(t.includes("The following are typical cruise line cancellation penalties. Specific terms applicable"));
  assert.ok(t.includes("121+ days | Deposit amount") && t.includes("0–30 days | 100% of total cruise fare"));
  assert.ok(renderDocument("04-cancellation-policy", ctx).text.includes("121+ days | Deposit only (deposit amount varies by cruise line)"));
  // the older column (migration 0044) is used when terms carry none
  const viaColumn = ctxFor({ terms: {}, cancellation_schedule: [{ from_days: 60, to_days: 31, from_date: "2027-01-13", to_date: "2027-02-12", percent: 75 }] });
  assert.ok(renderDocument("12-cruise-booking-agreement", viaColumn).text.includes("31–60 days | January 13, 2027 – February 12, 2027 | 75% of the cruise fare"));
});

// ── every number and date comes from the file; blanks are reported ────────────

test("a cabin's cost, deposit and dates come from the file; what the file cannot give stays blank and is reported", () => {
  const t = renderDocument("12-cruise-booking-agreement", ctxFor()).text;
  assert.ok(t.includes("Cruise Fare (per person, taxes and fees as quoted) | $1,299"));
  assert.ok(t.includes("Estimated Total (this cabin) | $2,598"));
  assert.ok(t.includes("Cruise deposit (per person) | $250 | December 1, 2026"));
  assert.ok(t.includes("Final payment | The balance, as invoiced by the cruise line | January 12, 2027"));
  assert.ok(t.includes("Final payment is due no later than 90 days before sailing"));
  assert.ok(t.includes("Cabin Category: Balcony (8C)") && t.includes("Cabin Number (if assigned): 8214") && t.includes("Number of Nights: 7"));
  assert.ok(t.includes("Confirmed on this group's file: $50 onboard credit per cabin"));
  // a group with no prices on the file prints no amounts at all
  const bare = renderDocument("12-cruise-booking-agreement", ctxFor({ terms: {}, deposit_per_person: null }, { ...TRAVELERS[0]!, cabin_id: "c9" })).text;
  assert.ok(bare.includes("The amounts for this cabin are shown on your cruise line booking confirmation."));
  assert.ok(!/\$\d/.test(bare.slice(bare.indexOf("PRICING AND PAYMENT"), bare.indexOf("CRUISE LINE CANCELLATION"))), "no invented amounts");
  const contract = renderDocument("09-group-travel-contract", ctxFor({}, null));
  assert.deepEqual(contract.unfilled.sort(), ["Complimentary berth ratio", "Minimum group size"]);
  assert.ok(contract.text.includes("Maximum Capacity: 32") && contract.text.includes("Current Confirmed Travelers: 2"));
  assert.ok(contract.text.includes("Group Booking Deadline: December 1, 2026"));
  assert.ok(contract.text.includes("Trip Duration: 7 nights / 8 days"));
});

test("the cabin's other travelers are listed by name, and a passport shows its last four only, never the number", () => {
  const booking = renderDocument("12-cruise-booking-agreement", ctxFor());
  assert.ok(booking.text.includes("John Q Public | January 9, 1958 | ending 4321 | January 1, 2030"));
  for (const secret of ["SECRETCIPHER", "X99887766", "passport_enc"]) {
    for (const key of KEYS) {
      const d = renderDocument(key, ctxFor({ fees: { planning_fee: 100 } }));
      assert.ok(!d.text.includes(secret) && !d.html.includes(secret), `${key} leaks ${secret}`);
    }
  }
  const waiver = renderDocument("05-liability-waiver", ctxFor()).text;
  assert.ok(waiver.includes("John Q Public | — | —"), "the waiver lists companions by name only");
  assert.ok(!waiver.includes("January 9, 1958"));
  assert.ok(renderDocument("07-travel-insurance-declination", ctxFor()).text.includes("Additional Traveler(s): John Q Public"));
});

test("a traveler's own name or answers can never become markup or template tokens", () => {
  const evil = { ...TRAVELERS[0]!, first_name: "**Eve**<script>alert(1)</script>{{in:dob}}", last_name: "____", form_data: { address: "{{ta:notes}} <b>x</b>", legal_name: "Zed *Z*" } };
  const ctx = ctxFor({}, evil);
  for (const key of ["05-liability-waiver", "12-cruise-booking-agreement", "16-passport-document-checklist", "07-travel-insurance-declination"]) {
    const d = renderDocument(key, ctx);
    assert.ok(!d.html.includes("<script"), `${key} html carries a script tag`);
    assert.ok(!d.html.includes("<b>x"), `${key} html carries raw markup`);
    assert.ok(!/\{\{/.test(d.text), `${key} text carries a token`);
    assert.equal((d.html.match(/data-field="dob"/g) ?? []).length, 0, `${key}: a name must not create an input`);
  }
});

// ── the inputs ────────────────────────────────────────────────────────────────

test("the traveler form's blanks and boxes become the inputs its spec names, and every spec field is on the page", () => {
  for (const key of KEYS) {
    const d = renderDocument(key, ctxFor({ fees: { planning_fee: 100 } }, key.startsWith("09") ? null : TRAVELERS[0]!));
    assert.deepEqual(d.fields.map((f) => f.name).sort(), DOC_SPECS[key]!.fields.map((f) => f.name).sort(), `${key}: fields on the page vs the spec`);
    for (const f of d.fields) {
      assert.ok(d.html.includes(`data-field="${f.name}"`), `${key}: no input for ${f.name}`);
      if (f.kind === "choice" || f.kind === "multi") for (const o of f.options!) assert.ok(d.html.includes(`value="${o.value}"`), `${key}: ${f.name} has no option ${o.value}`);
    }
  }
  const f15 = renderDocument("15-emergency-contact-form", ctxFor());
  assert.equal(f15.fields.length, 30);   // Mark 2026-10-26: one contact by cell phone, nothing medical, no insurance, prescriptions or diet
  assert.ok(f15.html.includes('type="date" name="dob"') && f15.html.includes('type="email" name="email"') && f15.html.includes('type="radio" name="gender" value="female"'));
  assert.ok(f15.html.includes('type="checkbox" name="trusted_programs" value="tsa"'), "multi fields are checkboxes");
  assert.ok(f15.html.includes('autocomplete="off"'), "the passport input must not be autofilled or remembered");
});

test("the card authorization form still renders but offers no input at all, so no card number can be typed on it", () => {
  const d = renderDocument("06-credit-card-authorization", ctxFor());
  assert.equal(d.fields.length, 0);
  assert.ok(!d.html.includes("<input") && !d.html.includes("<textarea"));
  assert.ok(d.text.includes("CREDIT CARD AUTHORIZATION FORM"));
});

test("a template that stopped matching its spec fails loudly instead of printing a wrong page", () => {
  const saved = CLIENT_DOCUMENTS["16-passport-document-checklist"]!;
  try {
    CLIENT_DOCUMENTS["16-passport-document-checklist"] = saved.replace("Client Name:", "Name of Client:");
    assert.throws(() => renderDocument("16-passport-document-checklist", ctxFor()), /no longer matches its spec/);
  } finally {
    CLIENT_DOCUMENTS["16-passport-document-checklist"] = saved;
  }
});

// ── the signed text is reproducible ───────────────────────────────────────────

test("the document hash is stable for the same file and moves when anything the signer sees moves", () => {
  const a = renderDocument("12-cruise-booking-agreement", ctxFor());
  assert.equal(a.sha256, renderDocument("12-cruise-booking-agreement", ctxFor()).sha256);
  assert.equal(a.sha256, renderDocument("12-cruise-booking-agreement", buildCtx({ business: BUSINESS, group: GROUP, cabins: CABINS, travelers: TRAVELERS, traveler: TRAVELERS[0]!, now: new Date("2027-01-01T00:00:00Z") })).sha256, "the clock must not move the hash");
  assert.notEqual(a.sha256, renderDocument("12-cruise-booking-agreement", ctxFor({ sail_date: "2027-03-15" })).sha256);
  assert.notEqual(a.sha256, renderDocument("12-cruise-booking-agreement", ctxFor({ ship_name: "MSC Seashore" })).sha256);
  assert.notEqual(a.sha256, renderDocument("12-cruise-booking-agreement", ctxFor({ fees: { planning_fee: 100 } })).sha256);
});

test("a signed copy merges the answers into the text and marks the chosen boxes", () => {
  const d = renderDocument("07-travel-insurance-declination", ctxFor());
  const filled = blocksToText(fillBlocks(d, { insurance_choice: "decline", decline_reasons: ["premium"], decline_other: "no thanks" }, NOW));
  assert.ok(filled.includes("☒ No. I decline travel insurance for this trip."));
  assert.ok(filled.includes("☐ Yes. Please send me an Allianz travel insurance quote"));
  assert.ok(filled.includes("☒ The insurance premium cost is a concern"));
  assert.ok(filled.includes("☐ I have existing coverage"));
  assert.ok(filled.includes("Other: no thanks"));
  assert.ok(filled.includes("Date: October 16, 2026"));
  assert.ok(!filled.includes("[date of signing]") && !filled.includes("{{"));
});

// ── who signs what ────────────────────────────────────────────────────────────

test("every traveler gets 15, 01, 05, 07 and 16 in that order; the cabin's lead also 12; the organizer 09", () => {
  const plain = packetFor({ group: GROUP, cabin: CABINS[0], traveler: TRAVELERS[1] });
  assert.deepEqual(plain, ["15-emergency-contact-form", "01-terms-and-conditions", "05-liability-waiver", "07-travel-insurance-declination", "16-passport-document-checklist"]);
  assert.deepEqual(packetFor({ group: GROUP, cabin: CABINS[0], traveler: TRAVELERS[0] }), [...plain, "12-cruise-booking-agreement"]);
  assert.deepEqual(packetFor({ group: GROUP, cabin: null, traveler: TRAVELERS[0] }), plain, "a lead with no cabin has no cabin agreement to sign");
  assert.deepEqual(packetFor({ group: GROUP, organizer: true }), ["09-group-travel-contract"]);
});

test("documents 02 and 03 are in a packet only when the file carries a fee; 04, 06, 13 and 14 are in no packet", () => {
  const withFees = packetFor({ group: { ...GROUP, fees: { planning_fee: 100 } }, cabin: CABINS[0], traveler: TRAVELERS[0] });
  assert.deepEqual(withFees.slice(0, 5), ["15-emergency-contact-form", "01-terms-and-conditions", "02-travel-planning-agreement", "03-service-fee-planning-fee-agreement", "05-liability-waiver"]);
  assert.equal(packetFor({ group: { ...GROUP, fees: { planning_fee: 0, x: "free" } }, traveler: TRAVELERS[1] }).length, 5, "a zero or non-numeric fee is not a fee");
  for (const g of [GROUP, { ...GROUP, fees: { planning_fee: 100 } }]) {
    for (const t of [TRAVELERS[0], TRAVELERS[1]]) {
      const keys = [...packetFor({ group: g, cabin: CABINS[0], traveler: t }), ...packetFor({ group: g, organizer: true })];
      for (const out of ["04-cancellation-policy", "06-credit-card-authorization", "13-new-client-questionnaire", "14-travel-preferences-survey"]) assert.ok(!keys.includes(out), `${out} must be in no packet`);
    }
  }
  assert.ok(DOC_SPECS["09-group-travel-contract"]!.agentCountersign, "09 flags the agent countersignature that is still to build");
});

// ── answers ───────────────────────────────────────────────────────────────────

const GOOD_15 = {
  legal_name: "Jane Quincy Public", dob: "1960-05-04", gender: "female", us_citizen: "yes", address: "1 Main St", city_state_zip: "Raleigh, NC 27601",
  phone: "(919) 555-0100", email: "jane@example.com", passport_number: "a1234-5678", passport_country: "United States", passport_expiry: "2031-02-03",
  passport_issue: "2021-02-04", ec1_name: "Sam Public", ec1_relationship: "Son", ec1_cell_phone: "919-555-0199",
  trusted_programs: ["tsa"], ktn: "TT1234567", loyalty_1_program: "Delta", loyalty_1_number: "123456", notes: "Window seat please.",
};
const doc15 = () => renderDocument("15-emergency-contact-form", ctxFor());

test("form 15 answers are checked, filed into columns and form_data, and the passport number is returned only to be encrypted", () => {
  const r = applyAnswers(doc15(), GOOD_15, ctxFor());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.passport, { number: "A12345678", last4: "5678" });
  assert.equal(r.answers["passport_number"], "ending 5678", "the stored answers never hold the passport number");
  assert.ok(!JSON.stringify(r.answers).includes("A12345678") && !JSON.stringify(r).includes("1234-5678"));
  assert.equal(JSON.stringify(r.travelerPatch).includes("A1234"), false);
  assert.deepEqual(
    { dob: r.travelerPatch["dob"], gender: r.travelerPatch["gender"], phone: r.travelerPatch["phone"], email: r.travelerPatch["email"], passport_country: r.travelerPatch["passport_country"], passport_expiry: r.travelerPatch["passport_expiry"], passport_last4: r.travelerPatch["passport_last4"], emergency_name: r.travelerPatch["emergency_name"], emergency_phone: r.travelerPatch["emergency_phone"], citizenship: r.travelerPatch["citizenship"], special_needs: r.travelerPatch["special_needs"] },
    { dob: "1960-05-04", gender: "Female", phone: "(919) 555-0100", email: "jane@example.com", passport_country: "United States", passport_expiry: "2031-02-03", passport_last4: "5678", emergency_name: "Sam Public", emergency_phone: "919-555-0199", citizenship: "United States", special_needs: undefined },
  );
  assert.equal(getPath(r.formData, "emergency.primary.relationship"), "Son");
  assert.equal(getPath(r.formData, "emergency.primary.cell_phone"), "919-555-0199");
  assert.deepEqual(getPath(r.formData, "trusted.programs"), ["tsa"]);
  assert.equal(getPath(r.formData, "loyalty.1.program"), "Delta");
  assert.equal(getPath(r.formData, "passport.issue_date"), "2021-02-04");
  assert.equal(getPath(r.formData, "legal_name"), "Jane Quincy Public");
  assert.equal(getPath(r.formData, "address"), "1 Main St");
  assert.equal(getPath(r.formData, "passport_number"), undefined);
  assert.equal("passport_enc" in r.travelerPatch, false);
  assert.equal("first_name" in r.travelerPatch, false, "the file's name columns are only filled from the form when they are empty");
});

test("the file's name columns are filled from the legal name only when they are empty", () => {
  const empty = { ...TRAVELERS[0]!, first_name: null, last_name: null, middle_name: null };
  const ctx = ctxFor({}, empty);
  const r = applyAnswers(renderDocument("15-emergency-contact-form", ctx), { ...GOOD_15, legal_name: "Maria Elena Gonzalez Ruiz" }, ctx);
  assert.equal(r.ok && r.travelerPatch["first_name"], "Maria");
  assert.equal(r.ok && r.travelerPatch["last_name"], "Ruiz");
  assert.equal(r.ok && r.travelerPatch["middle_name"], "Elena Gonzalez");
});

test("required answers, dates, phone and email are checked with a plain message for each field", () => {
  const bad = applyAnswers(doc15(), { ...GOOD_15, legal_name: "", dob: "2099-01-01", email: "nope", phone: "12", passport_expiry: "2020-01-01", gender: "robot", address: undefined }, ctxFor());
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.deepEqual(Object.keys(bad.errors).sort(), ["address", "dob", "email", "gender", "legal_name", "passport_expiry", "phone"]);
  assert.match(bad.errors["dob"]!, /date of birth/);
  assert.match(bad.errors["passport_expiry"]!, /passed/);
  const none = applyAnswers(doc15(), {}, ctxFor());
  assert.equal(none.ok, false);
  if (none.ok) return;
  for (const k of ["legal_name", "dob", "gender", "us_citizen", "address", "city_state_zip", "phone", "email", "ec1_name", "ec1_relationship", "ec1_cell_phone"]) assert.ok(none.errors[k], `${k} should be required`);
  for (const k of ["passport_number", "passport_country", "passport_expiry", "notes", "ec1_email", "ec1_address"]) assert.equal(none.errors[k], undefined, `${k} is optional until a passport number is given`);
});

test("a passport number needs its country and expiry, must look like a passport, and a US non-citizen must say their citizenship", () => {
  const { passport_country: _c, passport_expiry: _e, ...rest } = GOOD_15;
  const a = applyAnswers(doc15(), rest, ctxFor());
  assert.equal(a.ok, false);
  if (!a.ok) assert.deepEqual(Object.keys(a.errors).sort(), ["passport_country", "passport_expiry"]);
  const b = applyAnswers(doc15(), { ...GOOD_15, passport_number: "12" }, ctxFor());
  assert.equal(!b.ok && b.errors["passport_number"], "A passport number is 6 to 9 letters and digits.");
  const c = applyAnswers(doc15(), { ...GOOD_15, us_citizen: "no" }, ctxFor());
  assert.equal(!c.ok && c.errors["citizenship"], "Please fill this in.");
  const d = applyAnswers(doc15(), { ...GOOD_15, us_citizen: "no", citizenship: "Canada" }, ctxFor());
  assert.equal(d.ok && d.travelerPatch["citizenship"], "Canada");
  const { passport_number: _p, passport_country: _pc, passport_expiry: _pe, passport_issue: _pi, ...noPassport } = GOOD_15;
  const e = applyAnswers(doc15(), noPassport, ctxFor());
  assert.equal(e.ok, true);
  assert.equal(e.ok && e.passport, undefined);
});

test("a card number is refused in any text answer, unknown answers are dropped, and wrong types are refused", () => {
  const card = applyAnswers(doc15(), { ...GOOD_15, notes: "my visa is 4111 1111 1111 1111" }, ctxFor());
  assert.equal(!card.ok && card.errors["notes"], "Card numbers are never collected here. Please remove it.");
  const ok = applyAnswers(doc15(), { ...GOOD_15, __proto__: { x: 1 }, sneaky: "x", passport_enc: "v1:evil", form_token_hash: "x" }, ctxFor());
  assert.equal(ok.ok, true);
  if (ok.ok) {
    for (const k of ["sneaky", "passport_enc", "form_token_hash"]) assert.ok(!(k in ok.answers) && !(k in ok.travelerPatch));
    assert.equal("form_token_hash" in ok.formData, false);
  }
  assert.equal(applyAnswers(doc15(), { ...GOOD_15, dob: 19600504 }, ctxFor()).ok, false);
  assert.equal(applyAnswers(doc15(), { ...GOOD_15, trusted_programs: ["tsa", "bogus"] }, ctxFor()).ok, false);
  assert.equal(applyAnswers(doc15(), { ...GOOD_15, notes: "x".repeat(1001) }, ctxFor()).ok, false);
  assert.equal(applyAnswers(doc15(), "nonsense", ctxFor()).ok, false);
  const nonObject = applyAnswers(renderDocument("01-terms-and-conditions", ctxFor()), null, ctxFor());
  assert.equal(nonObject.ok, true, "a document with no inputs needs no answers");
});

test("form 15 asks for one emergency contact by cell phone, and nothing medical, no insurance, prescriptions or diet (Mark 2026-10-26)", () => {
  const { ec1_cell_phone: _c, ...noPhone } = GOOD_15;
  const r = applyAnswers(doc15(), noPhone, ctxFor());
  assert.ok(!r.ok && r.errors["ec1_cell_phone"], "the contact's cell phone is required");
  const d = doc15();
  for (const gone of ["Secondary Emergency Contact", "Home Phone", "Work Phone", "power of attorney", "MEDICAL INFORMATION", "Blood Type", "HEALTH INSURANCE",
    "TRAVEL INSURANCE", "PRESCRIPTION", "EpiPen", "medical alert", "DIETARY", "at least two individuals"]) assert.ok(!d.text.includes(gone), `"${gone}" is no longer asked`);
  assert.ok(d.text.includes("Do you belong to any Loyalty Programs?") && !d.text.includes("FREQUENT FLYER"));
  assert.ok(d.text.includes("Please list one person who can be reached") && d.text.includes("ADDITIONAL NOTES"));
  assert.deepEqual(d.fields.filter((f) => f.name.startsWith("ec")).map((f) => f.name), ["ec1_name", "ec1_relationship", "ec1_cell_phone", "ec1_email", "ec1_address", "ec1_city_state_zip"]);
});

test("the insurance choice is required, a quote or a declination; the waiver's health box must be ticked", () => {
  const ins = renderDocument("07-travel-insurance-declination", ctxFor());
  assert.equal(applyAnswers(ins, {}, ctxFor()).ok, false);
  const q = applyAnswers(ins, { insurance_choice: "quote" }, ctxFor());
  assert.equal(q.ok && getPath(q.formData, "insurance.choice"), "quote");
  assert.equal(applyAnswers(ins, { insurance_choice: "maybe" }, ctxFor()).ok, false);
  const d = applyAnswers(ins, { insurance_choice: "decline", decline_reasons: ["premium", "other"], decline_other: "tight budget" }, ctxFor());
  assert.equal(d.ok && getPath(d.formData, "insurance.other_reason"), "tight budget");
  const waiver = renderDocument("05-liability-waiver", ctxFor());
  assert.equal(applyAnswers(waiver, {}, ctxFor()).ok, false);
  assert.equal(applyAnswers(waiver, { health_ack: true }, ctxFor()).ok, true);
  assert.equal(applyAnswers(waiver, { health_ack: "yes" }, ctxFor()).ok, false);
});

test("the organizer's contract asks for an address, phone and email, and offers the file's own as defaults", () => {
  const ctx = ctxFor({}, null);
  const c = renderDocument("09-group-travel-contract", ctx);
  const byName = Object.fromEntries(c.fields.map((f) => [f.name, f]));
  assert.equal(prefillValue(byName["org_phone"]!, ctx), "555-123-4567");
  assert.equal(prefillValue(byName["org_email"]!, ctx), "pat@example.com");
  assert.equal(prefillValue(byName["accommodation"]!, ctx), "cruise");
  const r = applyAnswers(c, { org_address: "5 Elm", org_city_state_zip: "Cary, NC", org_phone: "555-123-4567", org_email: "pat@example.com", group_type: "family" }, ctx);
  assert.equal(r.ok, true);
  assert.equal(applyAnswers(c, { org_phone: "555-123-4567" }, ctx).ok, false);
});

test("the page gets each field without functions or secrets, pre-filled from the file, and never a passport number", () => {
  const ctx = ctxFor({}, { ...TRAVELERS[1]!, form_data: { passport: { place_of_issue: "Raleigh" }, trusted: { programs: ["global"] } }, passport_country: "United States" });
  const fields = renderDocument("15-emergency-contact-form", ctx).fields.map((f) => publicField(f, ctx));
  const by = Object.fromEntries(fields.map((f) => [f.name as string, f]));
  assert.equal(by["dob"]!.value, "1958-01-09");
  assert.equal(by["legal_name"]!.value, "John Q Public");
  assert.equal(by["passport_country"]!.value, "United States");
  assert.equal(by["passport_place"]!.value, "Raleigh");
  assert.deepEqual(by["trusted_programs"]!.value, ["global"]);
  assert.equal(by["passport_number"]!.value, null);
  assert.equal(by["passport_number"]!.kind, "passport");
  assert.ok(!JSON.stringify(fields).includes("X99887766") && !JSON.stringify(fields).includes("SECRETCIPHER") && !JSON.stringify(fields).includes("4321"));
  for (const f of fields) for (const v of Object.values(f)) assert.notEqual(typeof v, "function");
});
