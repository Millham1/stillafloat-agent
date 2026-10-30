import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksFor, buildCtx, type Answers, type Block } from "./group-documents";
import { BUSINESS } from "./group-secure";
import { markSignature, pieces, renderFormPdf } from "./group-form-pdf";

const NOW = new Date("2026-10-28T15:00:00Z");
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
  ec1_name: "Sam Public", ec1_relationship: "Child", ec1_cell_phone: "919-555-0199", loyalty_1_program: "MSC Voyagers Club", loyalty_1_number: "123456789",
};
const KEYS = ["20-about-you", "21-your-booking", "22-card-authorization", "15-emergency-contact-form", "01-terms-and-conditions", "07-travel-insurance-declination", "05-liability-waiver", "16-passport-document-checklist", "12-cruise-booking-agreement"];

test("a line of the form: words in their print, each blank with its answer or a line, each box ticked by its choice", () => {
  const p = pieces("**Gender:** {{ch:gender:male}} Male {{ch:gender:female}} Female *Date Completed: {{today}}* Name: {{in:legal_name}} Zip: {{in:zip}} ___ ☐ Yes", { answers: ANSWERS, today: "October 28, 2026" });
  assert.deepEqual(p.filter((x) => x.k !== "text"), [
    { k: "box", on: false }, { k: "box", on: true }, { k: "answer", text: "October 28, 2026" }, { k: "answer", text: "Jane Quincy Public" }, { k: "answer", text: "N/A — left intentionally blank" }, { k: "blank" }, { k: "box", on: false },
  ]);
  assert.ok(p.some((x) => x.k === "text" && x.bold && x.text === "Gender:"));
  assert.ok(p.some((x) => x.k === "text" && x.italic && /Date Completed/.test(x.text)), "an italic run keeps its blank inside it");
  assert.ok(!p.some((x) => x.k === "text" && x.text.includes("*")), "no markdown marks are printed");
});

test("the client's own signature block takes the typed name and the date; the co-traveler's, parent's and agent's stay blank lines", () => {
  const blocks: Block[] = [
    { t: "p", text: "**Primary Traveler:**" }, { t: "p", text: "Signature: ______" }, { t: "p", text: "Date: ______" }, { t: "p", text: "Print Name: ______" },
    { t: "p", text: "**Co-Traveler (if applicable):**" }, { t: "p", text: "Signature: ______" },
    { t: "p", text: "**Travel Agent:**" }, { t: "p", text: "Signature: ______" },
  ];
  const out = markSignature(blocks).map((b) => (b.t === "p" ? b.text : ""));
  assert.deepEqual(out.slice(1, 4), ["Signature: {{sig}}", "Date: {{sigdate}}", "Print Name: {{signame}}"]);
  assert.equal(out[5], "Signature: ______");
  assert.equal(out[7], "Signature: ______");
  const named = pieces("Signature: {{sig}} Date: {{sigdate}}", { answers: {}, today: "Oct 28", signer: "Jane Public" }).filter((x) => x.k === "answer");
  assert.deepEqual(named, [{ k: "answer", text: "/s/ Jane Public" }, { k: "answer", text: "Oct 28" }]);
  assert.deepEqual(pieces("Signature: {{sig}}", { answers: {}, today: "Oct 28" }).filter((x) => x.k !== "text"), [{ k: "blank" }], "a line until the name is typed");
});

test("every document prints as a clean form, blank or answered, with the business named and no template placeholder left", async () => {
  for (const key of KEYS) {
    for (const answers of [{}, ANSWERS]) {
      const said: string[] = [];
      const { spec, blocks } = blocksFor(key, ctx(), { paper: true });
      const pdf = await renderFormPdf({ title: spec.title, businessName: BUSINESS.legalName, blocks, answers, today: "October 28, 2026", signer: "Jane Public", onText: (w) => said.push(w) });
      assert.equal(pdf.subarray(0, 5).toString(), "%PDF-", key);
      const text = said.join(" ");
      assert.ok(text.includes("Still Afloat LLC dba Still Afloat Cruising"), `${key}: the business is named`);
      assert.ok(!/\[AGENT|\[INSERT|\[City, State\]/.test(text), `${key}: no placeholder is printed`);
    }
  }
});

test("the traveler form carries the answers, the loyalty programs in their table and the signature, and none of the sections Mark cut", async () => {
  const said: string[] = [];
  const { spec, blocks } = blocksFor("15-emergency-contact-form", ctx(), { paper: true });
  await renderFormPdf({ title: spec.title, businessName: BUSINESS.legalName, blocks, answers: ANSWERS, today: "October 28, 2026", signer: "Jane Public", onText: (w) => said.push(w) });
  const text = said.join(" ");
  for (const s of ["Jane Quincy Public", "100 Goodsell Ct", "Sam Public", "Child", "MSC Voyagers Club", "123456789", "/s/ Jane Public", "Loyalty Programs?"]) assert.ok(text.includes(s), s);
  for (const cut of ["MEDICAL INFORMATION", "Secondary Emergency Contact", "power of attorney", "Blood Type"]) assert.ok(!text.includes(cut), `cut: ${cut}`);
});

test("Mark 2026-10-30: on a document shown with the client's answers, a line left empty reads as intentionally blank; a form printed with no answers keeps its blanks", () => {
  const withAnswers = pieces("**Dietary Restrictions:** {{in:dietary}} **Notes:** {{ta:notes}}", { answers: { dietary: "none", notes: "" }, today: "October 30, 2026", signer: null });
  assert.deepEqual(withAnswers.filter((p) => p.k === "answer").map((p) => (p as { text: string }).text), ["none", "N/A — left intentionally blank"]);
  const blankForm = pieces("**Dietary Restrictions:** {{in:dietary}}", { answers: {}, today: "October 30, 2026", signer: null });
  assert.ok(blankForm.some((p) => p.k === "blank") && !blankForm.some((p) => p.k === "answer"));
});
