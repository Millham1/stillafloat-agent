import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { buildCtx, markValue, paperText, type Answers } from "./group-documents";
import { BUSINESS } from "./group-secure";
import { FORM_PDF_KEYS, fillFormPdf, formPdfFiles, lineUp, printable, stillAfloatLogo, textWords } from "./form-pdf";

const NOW = new Date("2026-10-27T15:00:00Z");
const GROUP = {
  id: "g1", name: "Friends 2027", cruise_line: "MSC Cruises", ship_name: "MSC Seashore", sail_date: "2027-05-09", return_date: "2027-05-13", nights: 4,
  embark_port: "Port Canaveral", itinerary: [{ day: 1, port: "Port Canaveral" }, { day: 2, port: "Nassau" }], group_number: "GRP1", cabins_held: 4,
  deposit_per_person: 50, deposit_due: "2026-12-01", final_payment_due: "2027-01-15", fees: {},
};
const CABINS = [{ id: "c1", cabin_num: "8214", category: "Balcony", category_code: "BB", booking_number: "BK77", price_total: 1073.58, deposit_amount: 100 }];
const TRAVELER = { id: "t1", cabin_id: "c1", is_lead: true, first_name: "Jane", last_name: "Public", email: "jane@example.com", form_data: {} };
const ctx = () => buildCtx({ business: BUSINESS, group: GROUP, cabins: CABINS, travelers: [TRAVELER], traveler: TRAVELER, now: NOW });
const ANSWERS: Answers = {
  legal_name: "Jane Quincy Public", dob: "1960-05-04", gender: "female", us_citizen: "yes", address: "100 Goodsell Ct", city_state_zip: "Fuquay Varina, NC 27526",
  phone: "919-555-0100", email: "jane@example.com", ec1_name: "Sam Public", ec1_relationship: "Child", ec1_cell_phone: "919-555-0199",
};
const value = (a: Answers) => (m: string) => markValue(m, a, "October 27, 2026");

test("each PDF Mark gave is there with the letters taken from that very file (re-run scripts/extract-form-chars.py after replacing one)", () => {
  for (const key of FORM_PDF_KEYS) {
    const f = formPdfFiles(key);
    assert.ok(f, `${key}: the PDF and its letters are in data/client-forms`);
    assert.equal(createHash("sha256").update(f.pdf).digest("hex"), f.chars.sha256, `${key}: the letters belong to this PDF`);
    assert.equal(f.chars.text.length, f.chars.box.length);
    assert.equal(f.chars.style?.length, f.chars.text.length);
  }
  assert.equal(formPdfFiles("04-cancellation-policy"), null, "a document without a PDF has none");
});

test("the traveler form's blanks and boxes each find their own place on the PDF, in order, the second contact's never taken for the first's", () => {
  const f = formPdfFiles("15-emergency-contact-form")!;
  const { marks } = lineUp(f.chars, paperText("15-emergency-contact-form", ctx()), value(ANSWERS));
  const names = marks.map((m) => m.mark);
  for (const n of ["today", "in:legal_name", "in:dob", "ch:gender:female", "ch:us_citizen:yes", "in:address", "in:city_state_zip", "in:phone", "in:email",
    "in:passport_country", "in:ec1_name", "in:ec1_relationship", "in:ec1_cell_phone", "in:ec1_email", "in:ec1_city_state_zip"]) assert.ok(names.includes(n), n);
  const at = (n: string) => f.chars.box[marks.find((m) => m.mark === n)!.at[0]!]!;
  // page, then top: the order of the lines on the page
  const order = ["in:ec1_name", "in:ec1_relationship", "in:ec1_cell_phone", "in:ec1_email"].map(at);
  for (let i = 1; i < order.length; i++) assert.ok(order[i]![0] > order[i - 1]![0] || order[i]![2] > order[i - 1]![2], "one under the other");
  // the relationship goes on the line of its own label
  const label = f.chars.text.indexOf("RelationshiptoTraveler:");
  assert.ok(Math.abs(f.chars.box[label]![2] - at("in:ec1_relationship")[2]) < 4, "on the label's line");
});

test("the filled traveler form: the answers are written in, the business named, and the pages Mark cut (medical, insurance) taken out", async () => {
  const f = formPdfFiles("15-emergency-contact-form")!;
  const said: string[] = [];
  const out = await fillFormPdf({ pdf: f.pdf, chars: f.chars, text: paperText("15-emergency-contact-form", ctx()), value: value(ANSWERS), logo: stillAfloatLogo(), onWrite: (w) => said.push(w) });
  const pdf = await PDFDocument.load(out);
  assert.ok(pdf.getPageCount() < f.chars.pages.length, "a page left empty is taken out");
  const text = said.join(" | ");
  for (const s of ["Jane Quincy Public", "100 Goodsell Ct", "Fuquay Varina, NC 27526", "Sam Public", "Child", "October 27, 2026", "Still Afloat LLC dba Still Afloat Cruising", "Do you belong to any Loyalty Programs?"]) {
    assert.ok(text.includes(s), s);
  }
});

test("every PDF fills without a hitch, blank or answered", async () => {
  for (const key of FORM_PDF_KEYS) {
    const f = formPdfFiles(key)!;
    for (const a of [{}, ANSWERS]) {
      const out = await fillFormPdf({ pdf: f.pdf, chars: f.chars, text: paperText(key, ctx()), value: value(a), logo: stillAfloatLogo() });
      assert.ok((await PDFDocument.load(out)).getPageCount() >= 1, key);
    }
  }
});

test("the marked text: blanks and boxes are words of their own; rules, list dashes, bars and emphasis are not words", () => {
  const w = textWords("Name: ⟦in:legal_name⟧ Gender: ⟦ch:gender:male⟧ Male\n-----\n- *For* | Agent ⟦bl:Full legal name⟧");
  assert.deepEqual(w.map((x) => x.w), ["Name:", "_", "Gender:", "☐", "Male", "For", "Agent", "_"]);
  assert.equal(w[1]!.mark, "in:legal_name");
  assert.equal(w[7]!.mark, "bl:Full legal name");
  assert.equal(printable("☐ Yes ☒ No → ok"), "[ ] Yes [X] No ? ok");
});

test("a marked blank holds the answer or the date; a marked box is ticked by its choice", () => {
  const a: Answers = { legal_name: "  Jane  ", trusted_programs: ["tsa"], gender: "female", ok: true };
  assert.equal(markValue("in:legal_name", a, "Oct 27"), "Jane");
  assert.equal(markValue("in:missing", a, "Oct 27"), "");
  assert.equal(markValue("today", a, "Oct 27"), "Oct 27");
  assert.equal(markValue("ch:gender:female", a, ""), true);
  assert.equal(markValue("ch:gender:male", a, ""), false);
  assert.equal(markValue("ch:trusted_programs:tsa", a, ""), true);
  assert.equal(markValue("ck:ok", a, ""), true);
  assert.equal(markValue("bl:Full name", a, ""), "");
});
