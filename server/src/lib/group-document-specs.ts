// group-document-specs.ts — the data behind each Cornerstone template: which blank is which fact,
// which blanks and ☐ boxes become the traveler's inputs, where each answer is kept, and the
// structural edits (tables built from the group file, the sections Mark's rulings change).
// The engine is group-documents.ts. Every rule's `after` text is matched against the template, in
// document order, and group-documents.test.ts renders every document so a template that drifts from
// its spec fails the build instead of printing a wrong page.
//
// WHO SIGNS WHAT (Mark 2026-10-29, "simplify the documents"; Cornerstone's templates are recommended, not required):
//   every traveler        20 About you (the data), 21 Your booking (cabin + price from the file, the terms, risks, documents
//                         and insurance choice condensed from 01/05/07/12/16, one signature)
//   the cabin's lead      + 22 Credit card authorization (last four + expiry only, modelled on Cornerstone's e-signed form)
//   (before 10/29, from the templates: 15, 01, 05, 07, 16 for every traveler; + 12 for the cabin's lead. The specs stay so
//    signed copies from before still render, and so Mark can switch back.)
//   the group organizer   09 group travel contract (the agent's countersignature is a later dashboard step)
//   only with fees on file 02 travel planning agreement, 03 service fee agreement
//   in no packet          04 cancellation policy, 06 card authorization (clients pay the line directly),
//                         13 and 14 questionnaires
//
// The language is English only in v1; templates are keyed by document, and docSource() prefers
// "<key>.es" when Cornerstone sends Spanish versions.

import {
  amountText, bookingReference, cabinTotal, cleanValue, depositPerPerson, destinationText, fee, finalPaymentDays,
  fmtLong, fmtMoney, fullName, mapTable, perPersonPrice, TEMPLATE_VERSION_DATE,
  type Answers, type Block, type DocCtx, type DocSpec, type FieldSpec, type Option, type Row,
} from "./group-document-kit";
import { displayName } from "./group-marketing";

// ── small lookups ─────────────────────────────────────────────────────────────

const formText = (ctx: DocCtx, path: string): string => {
  let node: unknown = ctx.traveler?.form_data;
  for (const p of path.split(".")) node = node && typeof node === "object" ? (node as Row)[p] : undefined;
  return typeof node === "string" ? cleanValue(node) : "";
};

/** The name as the traveler wrote it on form 15, else the name on the file. */
const legalName = (ctx: DocCtx): string => formText(ctx, "legal_name") || fullName(ctx.traveler);

const dobText = (ctx: DocCtx) => fmtLong(ctx.traveler?.dob);

/** Drop the paragraphs matching any pattern, and never leave two rules in a row behind. */
function dropLines(blocks: Block[], patterns: RegExp[]): Block[] {
  const kept = blocks.filter((b) => !(b.t === "p" && patterns.some((p) => p.test(b.text))));
  return kept.filter((b, i) => !(b.t === "hr" && kept[i - 1]?.t === "hr"));
}

/** The highest State Department level among the itinerary's countries, as the waiver's box value; "unknown" when none could be read. */
function highestAdvisory(ctx: DocCtx): string {
  const levels = ctx.advisories.map((a) => a.level).filter((l): l is 1 | 2 | 3 | 4 => l != null);
  return levels.length ? String(Math.max(...levels)) : "unknown";
}

/** One line per country of the itinerary, with its ports, as the waiver prints them. */
function advisoryLines(ctx: DocCtx): string {
  const byCountry = new Map<string, { title: string; ports: string[] }>();
  for (const a of ctx.advisories) {
    const row = byCountry.get(a.country) ?? { title: a.title, ports: [] };
    if (!row.ports.includes(a.port)) row.ports.push(a.port);
    byCountry.set(a.country, row);
  }
  // {{today}} keeps the hashed text stable from day to day: the signing date is written in when the copy is made.
  if (!byCountry.size) return "The advisory levels for this itinerary could not be read from travel.state.gov on {{today}}; please check them there before you go.";
  const list = [...byCountry.entries()].map(([country, r]) => `${country}: ${r.title} (${r.ports.join(", ")})`).join("; ");
  return `Advisory levels for this itinerary on {{today}}, from the U.S. Department of State (travel.state.gov): ${list}.`;
}

/** The cabin's dining on the file, as the booking agreement's box value. */
function diningFromFile(ctx: DocCtx): string | undefined {
  const d = cleanValue(ctx.cabin?.dining).toLowerCase();
  if (!d) return undefined;
  if (/early|first|main/.test(d)) return "early";
  if (/late|second/.test(d)) return "late";
  if (/any|my ?time|flex|open/.test(d)) return "anytime";
  return undefined;
}

/** The group's occasion, as Mark wrote it on the file (the sign-up's "What is the occasion?"). */
function occasionFromFile(ctx: DocCtx): string | undefined {
  const m = ctx.group.marketing;
  const o = m && typeof m === "object" ? cleanValue((m as Record<string, unknown>)["occasion"]) : "";
  return o || undefined;
}
const mateNames = (ctx: DocCtx) => ctx.mates.map(fullName).filter(Boolean);

function nights(group: Row): number | null {
  const n = Number(group.nights);
  if (Number.isInteger(n) && n > 0) return n;
  const a = Date.parse(`${String(group.sail_date ?? "").slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(group.return_date ?? "").slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? Math.round((b - a) / 86_400_000) : null;
}

const opt = (value: string, label: string, match?: string): Option => ({ value, label, ...(match ? { match } : {}) });

const text = (name: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ name, label, kind: "text", ...extra });

/** The common top lines of the client-information blocks (05, 12): name, birth date, address, phone, email. */
const CLIENT_LINES = (nameAnchor: string) => [
  { after: nameAnchor, fill: legalName, label: "Full legal name" },
  { after: "Date of Birth:", fill: dobText, label: "Date of birth" },
  { after: "Address:", fill: (c: DocCtx) => formText(c, "address"), label: "Address" },
  { after: "City, State, ZIP:", fill: (c: DocCtx) => formText(c, "city_state_zip"), label: "City, state, ZIP" },
  { after: "Phone:", fill: (c: DocCtx) => cleanValue(c.traveler?.phone), label: "Phone" },
  { after: "Email:", fill: (c: DocCtx) => cleanValue(c.traveler?.email), label: "Email" },
];

const TRIP_LINES = [
  { after: "Destination(s):", fill: (c: DocCtx) => destinationText(c.group), label: "Destination" },
  { after: "Travel Dates:** From", fill: (c: DocCtx) => fmtLong(c.group.sail_date), label: "Sail date" },
  { after: " To ", fill: (c: DocCtx) => fmtLong(c.group.return_date), label: "Return date" },
];

/** Rewrite a table whose rows are empty (the Google tables arrive with blank rows to fill by hand). */
const withRows = (headerFirstCell: string, rows: (ctx: DocCtx) => string[][]) =>
  (blocks: Block[], ctx: DocCtx): Block[] =>
    mapTable(blocks, (t) => t.header[0] === headerFirstCell, (t) => [{ ...t, rows: rows(ctx) }]);

// ── 15 — emergency contact and traveler information ───────────────────────────

const GENDER = [opt("male", "Male"), opt("female", "Female"), opt("nonbinary", "Non-binary / Other"), opt("na", "Prefer not to say")];
const PROGRAMS = [opt("none", "No", "No"), opt("tsa", "TSA PreCheck"), opt("global", "Global Entry"), opt("nexus", "NEXUS"), opt("clear", "CLEAR")];

// Mark 2026-10-26: one emergency contact, asked for a cell phone only; no second contact, no power-of-attorney question.
const CONTACT_FIELDS: FieldSpec[] = [
  text("ec1_name", "Emergency contact: full name", { required: true, form: "emergency.primary.name", col: "emergency_name" }),
  text("ec1_relationship", "Relationship to you", { required: true, form: "emergency.primary.relationship" }),
  { name: "ec1_cell_phone", label: "Cell phone", kind: "tel", required: true, form: "emergency.primary.cell_phone" },
  { name: "ec1_email", label: "Email", kind: "email", form: "emergency.primary.email" },
  text("ec1_address", "Address", { form: "emergency.primary.address" }),
  text("ec1_city_state_zip", "City, state, ZIP", { form: "emergency.primary.city_state_zip" }),
];

const LOYALTY = [1, 2, 3].flatMap((i) => [
  text(`loyalty_${i}_program`, `Loyalty program ${i}`, { form: `loyalty.${i}.program` }),
  text(`loyalty_${i}_number`, `Membership number ${i}`, { form: `loyalty.${i}.number` }),
]);
// Rules run in document order (the cursor in applyRules moves forward only), so this list reads top to bottom like the form.
const RULES_15: DocSpec["rules"] = [
  { after: "Date Completed:", today: true },
  { after: "**Full Legal Name:**", slot: "legal_name" },
  { after: "**Date of Birth:**", slot: "dob" },
  { after: "**Gender:**", choice: "gender" },
  { after: "**U.S. Citizen?**", choice: "us_citizen" },
  { after: "Citizenship:", slot: "citizenship" },
  { after: "**Home Address:**", slot: "address" },
  { after: "**City, State, ZIP:**", slot: "city_state_zip" },
  { after: "**Personal Cell Phone:**", slot: "phone" },
  { after: "**Email Address:**", slot: "email" },
  { after: "**Passport Number:**", slot: "passport_number" },
  { after: "**Country of Issue:**", slot: "passport_country" },
  { after: "**Issue Date:**", slot: "passport_issue" },
  { after: "**Expiration Date:**", slot: "passport_expiry" },
  { after: "Do you have Global Entry / TSA PreCheck?", choice: "trusted_programs" },
  { after: "(KTN):", slot: "ktn" },
  { after: "Membership Number:", slot: "global_entry_number" },
  // Mark 2026-10-26: the loyalty heading reads as a question
  { sub: "FREQUENT FLYER / LOYALTY PROGRAMS", with: () => "Do you belong to any Loyalty Programs?" },
  { sub: "*Please list at least two individuals who can be reached in case of emergency during your travels. These individuals are NOT traveling with you.*",
    with: () => "*Please list one person who can be reached in case of emergency during your travels. This person is NOT traveling with you.*" },
  { after: "**Full Name:**", slot: "ec1_name" },
  { after: "**Relationship to Traveler:**", slot: "ec1_relationship" },
  { sub: /\*\*Home Phone:\*\*[^\n]*\n+/, with: () => "" },
  { after: "**Cell Phone:**", slot: "ec1_cell_phone" },
  { sub: /\*\*Work Phone:\*\*[^\n]*\n+/, with: () => "" },
  { after: "**Email Address:**", slot: "ec1_email" },
  { after: "**Address:**", slot: "ec1_address" },
  { after: "**City, State, ZIP:**", slot: "ec1_city_state_zip" },
  { sub: /\*\*Does this person have your power of attorney[\s\S]*?☐ Yes ☐ No\n*/, with: () => "" },
  // Mark 2026-10-26: no second contact, and nothing medical, no health or travel insurance, prescriptions, EpiPen, medical alert
  // card or dietary questions (the cruise line's booking covers what it needs): all of it, up to ADDITIONAL NOTES, is left out.
  { sub: /### Secondary Emergency Contact[\s\S]*?(?=## ADDITIONAL NOTES)/, with: () => "" },
];

const FIELDS_15: FieldSpec[] = [
  text("legal_name", "Full legal name (as on your passport or ID)", { required: true, form: "legal_name", prefill: (c) => fullName(c.traveler) || undefined }),
  { name: "dob", label: "Date of birth", kind: "date", required: true, date: "dob", col: "dob" },
  { name: "gender", label: "Gender", kind: "choice", required: true, options: GENDER, col: "gender" },
  { name: "us_citizen", label: "U.S. citizen?", kind: "choice", required: true, options: [opt("yes", "Yes"), opt("no", "No", "No")], form: "us_citizen" },
  text("citizenship", "Citizenship", { required: (a) => a["us_citizen"] === "no", col: "citizenship" }),
  text("address", "Home address", { required: true, form: "address" }),
  text("city_state_zip", "City, state, ZIP", { required: true, form: "city_state_zip" }),
  { name: "phone", label: "Personal cell phone", kind: "tel", required: true, col: "phone" },
  { name: "email", label: "Email address", kind: "email", required: true, col: "email" },
  // The passport is optional (a closed-loop cruise may not need one); if a number is given, its country and expiry are required.
  { name: "passport_number", label: "Passport number", kind: "passport" },
  text("passport_country", "Passport country of issue", { required: (a) => typeof a["passport_number"] === "string", col: "passport_country" }),
  { name: "passport_issue", label: "Passport issue date", kind: "date", date: "past", form: "passport.issue_date" },
  { name: "passport_expiry", label: "Passport expiration date", kind: "date", date: "future", required: (a) => typeof a["passport_number"] === "string", col: "passport_expiry" },
  { name: "trusted_programs", label: "Global Entry / TSA PreCheck", kind: "multi", options: PROGRAMS, form: "trusted.programs" },
  text("ktn", "Known Traveler Number (KTN)", { form: "trusted.ktn" }),
  text("global_entry_number", "Global Entry membership number", { form: "trusted.global_entry_number" }),
  ...LOYALTY,
  ...CONTACT_FIELDS,
  { name: "notes", label: "Anything else your agent or emergency contacts should know", kind: "textarea", form: "notes" },
];

const EDITS_15: NonNullable<DocSpec["edits"]> = [
  // Mark 2026-10-30: no passport place-of-issue question, and the agent-only lines at the foot are not the client's to see.
  (blocks) => dropLines(blocks, [/^\*\*Place of Issue \(City\):\*\*/, /^\*For Agent Use Only:\*/, /^Entered into Client File:/]),
  withRows("Program", () => [1, 2, 3].map((i) => [`{{in:loyalty_${i}_program}}`, `{{in:loyalty_${i}_number}}`])),
  // "ADDITIONAL NOTES" was four rules to write between: one box instead
  (blocks) => {
    const h = blocks.findIndex((b) => b.t === "h" && b.text === "ADDITIONAL NOTES");
    if (h < 0) throw new Error("client document 15 no longer matches its spec: ADDITIONAL NOTES not found");
    let j = h + 2; // heading, the italic prompt
    while (blocks[j]?.t === "hr" && blocks[j + 1]?.t === "hr") j++;
    return [...blocks.slice(0, h + 2), { t: "p", text: "{{ta:notes}}" }, ...blocks.slice(j)];
  },
];

const DERIVE_15: NonNullable<DocSpec["derive"]> = (a, ctx) => {
  const patch: Row = {};
  const phone = typeof a["ec1_cell_phone"] === "string" ? a["ec1_cell_phone"] : undefined;
  if (phone) patch["emergency_phone"] = phone;
  if (a["us_citizen"] === "yes" && typeof a["citizenship"] !== "string") patch["citizenship"] = "United States";
  // The file's name columns are Mark's to edit: fill them from the form only when they are empty.
  const t = ctx.traveler;
  const legal = typeof a["legal_name"] === "string" ? a["legal_name"] : "";
  if (legal && !t?.first_name && !t?.last_name) {
    const parts = legal.split(/\s+/);
    patch["first_name"] = parts[0];
    if (parts.length > 1) patch["last_name"] = parts[parts.length - 1];
    if (parts.length > 2) patch["middle_name"] = parts.slice(1, -1).join(" ");
  }
  return patch;
};

const FORM_15: DocSpec = {
  key: "15-emergency-contact-form",
  title: "Traveler information and emergency contacts",
  signerRole: "traveler",
  sigStart: /^\*\*Traveler Signature:\*\*/,
  rules: RULES_15,
  fields: FIELDS_15,
  edits: EDITS_15,
  derive: DERIVE_15,
};

// ── 01 — terms and conditions ─────────────────────────────────────────────────

const TERMS_01: DocSpec = {
  key: "01-terms-and-conditions",
  title: "Terms and Conditions of Travel Services",
  signerRole: "traveler",
  sigStart: /^\*\*Client Signature:\*\*/,
  feesAfter: /^\*\*3\.4 Service Fees\*\*/,
  rules: [{ after: "Last Updated:", fill: () => fmtLong(TEMPLATE_VERSION_DATE), label: "Last updated" }],
  fields: [],
};

// ── 04 — cancellation policy (in no packet; renders for the day it is switched on) ────

const CANCELLATION_04: DocSpec = {
  key: "04-cancellation-policy",
  title: "Cancellation Policy",
  signerRole: "traveler",
  sigStart: /^\*\*Client Signature:\*\*/,
  cancellationHeading: /^CRUISE LINES$/,
  rules: [{ after: "Effective Date:", fill: () => fmtLong(TEMPLATE_VERSION_DATE), label: "Effective date" }],
  fields: [],
};

// ── 05 — liability waiver ─────────────────────────────────────────────────────

const WAIVER_05: DocSpec = {
  key: "05-liability-waiver",
  title: "Liability Waiver and Release",
  signerRole: "traveler",
  sigStart: /^\*\*Primary Traveler:\*\*$/,
  rules: [
    { after: "Date:", today: true },
    ...CLIENT_LINES("**Full Name:**"),
    ...TRIP_LINES,
    { after: "Booking Reference Number:", fill: bookingReference, label: "Booking reference" },
    { after: "Current Advisory Level:", choice: "advisory_level" },
    { after: "I/We understand that purchasing comprehensive travel insurance", choice: "insurance_status" },
    { after: "Policy Provider:", slot: "ins_provider" },
    { after: "Policy Number:", slot: "ins_policy" },
    { after: "HEALTH DECLARATION", choice: "health_ack" },
  ],
  fields: [
    // Mark 2026-10-30: "we are supposed to be pulling the travel advisory levels for each port in the itinerary": the highest level
    // among the itinerary's countries (travel.state.gov, read when the page opens), never a question.
    { name: "advisory_level", label: "Current travel advisory level", kind: "choice", prefill: (c) => highestAdvisory(c), options: [opt("1", "Level 1", "Level 1"), opt("2", "Level 2", "Level 2"), opt("3", "Level 3", "Level 3"), opt("4", "Level 4", "Level 4"), opt("unknown", "Unknown", "Unknown")] },
    { name: "insurance_status", label: "Travel insurance", kind: "choice", options: [opt("have", "I have purchased travel insurance", "**I/We HAVE purchased"), opt("declined", "I have declined travel insurance", "**I/We have DECLINED")] },
    text("ins_provider", "Insurance provider"),
    text("ins_policy", "Policy number"),
    // Mark 2026-10-30: "we haven't shown them a health declaration … this should show in the signing stage on the actual document":
    // ticked on the waiver's own signing screen, under Cornerstone's Health Declaration, in its words.
    {
      name: "health_ack", label: "I am aware of and accept the health-related risks associated with my intended destination.", kind: "check", required: true,
      onDocument: {
        heading: "Health declaration",
        text: "I/We confirm that to the best of our knowledge, there are no known medical conditions that would prevent us from traveling to our intended destination(s). I/We have consulted or will consult with a qualified healthcare provider regarding any necessary vaccinations, medications, or health precautions for my/our destination.",
      },
    },
  ],
  edits: [
    // The advisory level of every country on the itinerary, written under the acknowledgment (Mark 2026-10-30).
    (blocks, ctx) => {
      const at = blocks.findIndex((b) => b.t === "p" && b.text.startsWith("I/We acknowledge that I/we have been advised"));
      if (at < 0) throw new Error("client document 05 no longer matches its spec: the advisory acknowledgment not found");
      return [...blocks.slice(0, at + 1), { t: "p", text: advisoryLines(ctx) }, ...blocks.slice(at + 1)];
    },
    // The traveler's cabin-mates, by name; the waiver does not need anyone else's birth date.
    (blocks, ctx) => mapTable(blocks, (t) => t.header[0] === "Name" && t.header[1] === "Date of Birth", (t) => [{
      ...t,
      rows: mateNames(ctx).length ? mateNames(ctx).map((n) => [n, "—", "—"]) : [["No other travelers are listed on this cabin", "—", "—"]],
    }]),
  ],
};

// ── 07 — travel insurance: a quote, or a declination ──────────────────────────

const INSURANCE_07: DocSpec = {
  key: "07-travel-insurance-declination",
  title: "Travel Insurance: Your Choice",
  signerRole: "traveler",
  sigStart: /^\*\*Primary Traveler:\*\*$/,
  rules: [
    { after: "Date:", today: true },
    { after: "Primary Traveler Name:", fill: legalName, label: "Traveler name" },
    { sub: "**Additional Traveler(s):**", with: (c) => `**Additional Traveler(s):** ${mateNames(c).join(", ") || "None on this cabin"}` },
    ...TRIP_LINES,
    { after: "**Total Trip Cost (approximate):**", fill: (c) => (cabinTotal(c) ? amountText(cabinTotal(c)!) : ""), label: "Trip cost" },
    { after: "Booking Reference Number:", fill: bookingReference, label: "Booking reference" },
    { after: "REASONS FOR DECLINATION", choice: "decline_reasons" },
    { after: "Other:", slot: "decline_other" },
  ],
  fields: [
    {
      name: "insurance_choice", label: "Your travel insurance choice", kind: "choice", required: true, form: "insurance.choice",
      options: [
        opt("quote", "Yes: Allianz travel insurance through Mark, at the quoted price"),
        opt("line", "The cruise line's own protection plan"),
        opt("own", "I have my own travel insurance policy"),
        opt("decline", "No, I decline travel insurance for this trip"),
      ],
    },
    {
      name: "decline_reasons", label: "Reasons for declining (optional)", kind: "multi", form: "insurance.reasons",
      options: [
        opt("existing", "I have existing coverage through another policy", "I have existing coverage"),
        opt("not_concerned", "I am not concerned about the financial risks", "I am not concerned"),
        opt("premium", "The insurance premium cost is a concern", "The insurance premium"),
        opt("traveled", "I have traveled without insurance before", "I have traveled without"),
        opt("refundable", "My trip is fully refundable", "My trip is fully refundable"),
        opt("other", "Other", "Other:"),
      ],
    },
    text("decline_other", "Other reason", { form: "insurance.other_reason" }),
    // Mark 2026-10-30: "they should be able to select the policy/price here": the Allianz plan picked on the insurance step, with its
    // price, printed under the Yes line. The page asks for it whenever plans are offered; it is kept only when Allianz was chosen.
    text("insurance_plan", "The Allianz plan you chose", { maxLength: 160, form: "insurance.plan" }),
  ],
  complete: (a) => { if (a["insurance_choice"] === "quote") return a; const { insurance_plan: _drop, ...rest } = a; return rest; },
  edits: [
    // The choice goes first: the Declination Statement and Acknowledgment apply only to someone who declines.
    (blocks) => {
      const at = blocks.findIndex((b) => b.t === "h" && /^CLIENT AND TRIP INFORMATION/.test(b.text));
      if (at < 0) throw new Error("client document 07 no longer matches its spec: CLIENT AND TRIP INFORMATION not found");
      const choice: Block[] = [
        { t: "h", level: 2, text: "YOUR CHOICE" },
        { t: "p", text: "Please choose one before you sign. The Declination Statement, the reasons and the Acknowledgment further down apply only if you choose to decline." },
        { t: "p", text: "{{ch:insurance_choice:quote}} **Yes.** I want Allianz travel insurance through Mark at the price quoted to me (subject to change until finalized). I am not declining insurance, and the Declination Statement below does not apply to me." },
        { t: "p", text: "Plan chosen: {{in:insurance_plan}}" },
        { t: "p", text: "{{ch:insurance_choice:line}} **The cruise line's plan.** I want the cruise line's own protection plan added to my booking. The Declination Statement below does not apply to me." },
        { t: "p", text: "{{ch:insurance_choice:own}} **My own policy.** I have travel insurance of my own; its provider and policy number are on my Liability Waiver. The Declination Statement below does not apply to me." },
        { t: "p", text: "{{ch:insurance_choice:decline}} **No.** I decline travel insurance for this trip. The Declination Statement and the Acknowledgment below apply to me." },
        { t: "hr" },
      ];
      return [...blocks.slice(0, at), ...choice, ...blocks.slice(at)];
    },
  ],
};

// ── 16 — passport and travel document checklist (read, then acknowledge) ──────

const CHECKLIST_16: DocSpec = {
  key: "16-passport-document-checklist",
  title: "Passport and Travel Document Checklist",
  signerRole: "traveler",
  rules: [
    { after: "Client Name:", fill: legalName, label: "Traveler name" },
    { after: "Destination(s):", fill: (c) => destinationText(c.group), label: "Destination" },
    { after: "Travel Dates:** From", fill: (c) => fmtLong(c.group.sail_date), label: "Sail date" },
    { after: " To ", fill: (c) => fmtLong(c.group.return_date), label: "Return date" },
    { after: "Date Checklist Completed:", today: true },
  ],
  fields: [],
};

// ── 12 — cruise booking agreement (the cabin's lead signs) ────────────────────

const BOOKING_12: DocSpec = {
  key: "12-cruise-booking-agreement",
  title: "Cruise Booking Agreement",
  signerRole: "lead",
  sigStart: /^\*\*Primary Guest:\*\*$/,
  cancellationHeading: /^CRUISE LINE CANCELLATION POLICY$/,
  // TODO(group-signing): the pre/post-cruise hotel, air and transfer boxes and the scope-of-services boxes print as the
  // template has them (unticked): the group's own air / hotel / transfer offer is not wired into this document yet.
  rules: [
    { after: "Date:", today: true },
    ...CLIENT_LINES("Primary Guest (Full Legal Name as on Passport/ID):**"),
    { after: "Cruise Line:", fill: (c) => cleanValue(displayName(c.group.cruise_line)), label: "Cruise line" },
    { after: "Ship Name:", fill: (c) => cleanValue(displayName(c.group.ship_name)), label: "Ship" },
    { after: "Sailing Date:", fill: (c) => fmtLong(c.group.sail_date), label: "Sail date" },
    { after: "Return Date:", fill: (c) => fmtLong(c.group.return_date), label: "Return date" },
    { after: "Departure Port:", fill: (c) => cleanValue(c.group.embark_port), label: "Departure port" },
    { after: "Itinerary / Destination(s):", fill: (c) => destinationText(c.group), label: "Itinerary" },
    { after: "Cruise Line Booking Number:", fill: (c) => cleanValue(c.cabin?.booking_number) || cleanValue(c.group.group_number), label: "Booking number" },
    { after: "Cabin Category:", fill: (c) => [c.cabin?.category, c.cabin?.category_code ? `(${c.cabin.category_code})` : ""].map(cleanValue).filter(Boolean).join(" "), label: "Cabin category" },
    { after: "Cabin Number (if assigned):", fill: (c) => cleanValue(c.cabin?.cabin_num), label: "Cabin number" },
    { after: "Number of Nights:", fill: (c) => (nights(c.group) ? String(nights(c.group)) : ""), label: "Nights" },
    { after: "Dining Preference:", choice: "dining" },
    { after: "Special Occasions:", choice: "occasions" },
    { after: "Other:", slot: "occasion_other" },
    { after: "Date of Occasion:", slot: "occasion_date" },
    { after: "Special Needs / Accessibility Requirements:", area: "special_needs" },
    { after: "Dietary Restrictions:", area: "dietary" },
    { after: "Final payment is due no later than", fill: (c) => (finalPaymentDays(c.group) ? String(finalPaymentDays(c.group)) : ""), label: "Final payment days" },
    {
      sub: "The following are typical cruise line cancellation penalties.",
      with: (c) => (c.group.terms?.cancellation_schedule?.length || c.group.cancellation_schedule?.length)
        ? "The following is the cruise line's own cancellation schedule for this sailing."
        : "The following are typical cruise line cancellation penalties.",
    },
    { after: "Agent Cancellation/Processing Fee:", fill: (c) => (fee(c, "cancellation_fee") ? amountText(fee(c, "cancellation_fee")!.amount) : ""), label: "Cancellation processing fee" },
  ],
  fields: [
    { name: "dining", label: "Dining preference", kind: "choice", prefill: (c) => diningFromFile(c), options: [opt("early", "Early Seating"), opt("late", "Late Seating"), opt("anytime", "Anytime Dining"), opt("none", "No Preference")], form: "cabin_preferences.dining" },
    { name: "occasions", label: "Special occasions", kind: "multi", prefill: (c) => (occasionFromFile(c) ? ["other"] : undefined), options: [opt("honeymoon", "Honeymoon"), opt("anniversary", "Anniversary"), opt("birthday", "Birthday"), opt("other", "Other", "Other:")], form: "cabin_preferences.occasions" },
    text("occasion_other", "Other occasion", { form: "cabin_preferences.occasion_other", prefill: (c) => occasionFromFile(c) }),
    { name: "occasion_date", label: "Date of the occasion", kind: "date", form: "cabin_preferences.occasion_date" },
    { name: "special_needs", label: "Special needs and accessibility requirements", kind: "textarea", form: "cabin_preferences.special_needs" },
    { name: "dietary", label: "Dietary restrictions", kind: "textarea", form: "cabin_preferences.dietary" },
  ],
  edits: [
    // Additional guests: the cabin's other travelers from the file. Passport shows its LAST FOUR only, never the number.
    (blocks, ctx) => mapTable(blocks, (t) => t.header[0].startsWith("Full Legal Name"), (t) => [{
      ...t,
      rows: ctx.mates.length
        ? ctx.mates.map((m) => [
          fullName(m) || "—",
          fmtLong(m.dob) || "—",
          m.passport_last4 ? `ending ${cleanValue(m.passport_last4)}` : "—",
          fmtLong(m.passport_expiry) || "—",
          "—",
        ])
        : [["No other guests are listed on this cabin", "—", "—", "—", "—"]],
    }]),
    // Estimated cost: only the amounts the quote on the file gives; a row with no known amount is left out.
    (blocks, ctx) => mapTable(blocks, (t) => t.header[0] === "Component", (t) => {
      const rows: string[][] = [];
      const perPerson = perPersonPrice(ctx);
      if (perPerson) rows.push(["Cruise Fare (per person, taxes and fees as quoted)", fmtMoney(perPerson)]);
      const f = fee(ctx, "planning_fee") ?? fee(ctx, "service_fee");
      if (f) rows.push(["Agent Planning / Service Fee", fmtMoney(f.amount)]);
      const total = cabinTotal(ctx);
      if (total) rows.push(["**Estimated Total (this cabin)**", `**${fmtMoney(total)}**`]);
      if (!rows.length) return [{ t: "p", text: "*The amounts for this cabin are shown on your cruise line booking confirmation.*" }];
      return [{ ...t, rows }];
    }),
    (blocks, ctx) => mapTable(blocks, (t) => t.header[0] === "Payment" && t.header[2] === "Due Date", (t) => {
      const deposit = depositPerPerson(ctx);
      const depositDue = fmtLong(ctx.group.deposit_due) || (ctx.group.terms?.deposit_timing === "at_booking" ? "At booking" : "—");
      return [{
        ...t,
        rows: [
          ["Cruise deposit (per person)", deposit ? fmtMoney(deposit) : "As shown on your quote", depositDue],
          ["Final payment", "The balance, as invoiced by the cruise line", fmtLong(ctx.group.final_payment_due) || "—"],
        ],
      }];
    }),
    // The two onboard-credit lines print only what the file's own amenity list says.
    (blocks, ctx) => {
      const amenities: unknown[] = Array.isArray(ctx.group.amenities) ? ctx.group.amenities : [];
      const credit = amenities.find((a): a is string => typeof a === "string" && /onboard credit|\bOBC\b/i.test(a));
      const kept = blocks.filter((b) => !(b.t === "p" && /^(\*\*Confirmed Onboard Credit|\(OBC from:)/.test(b.text)));
      if (!credit) return kept;
      const at = kept.findIndex((b) => b.t === "h" && /ONBOARD CREDITS AND PERKS/.test(b.text));
      const after = at < 0 ? kept.length : at + 2;
      return [...kept.slice(0, after), { t: "p", text: `**Confirmed on this group's file:** ${cleanValue(credit)}` }, ...kept.slice(after)];
    },
  ],
};

// ── 09 — group travel contract (the organizer signs; the agent countersigns later) ────

const CONTRACT_09: DocSpec = {
  key: "09-group-travel-contract",
  title: "Group Travel Contract",
  signerRole: "organizer",
  // TODO(group-signing): the agent's countersignature. The template's agent signature lines are not
  // rendered; recording Mark's countersignature on this contract is a later dashboard step
  // (group_signatures signer_role = 'agent', same doc_key and content hash).
  agentCountersign: true,
  // TODO(group-signing): "Full Group Cancellation" below is Cornerstone's own typical table for the ORGANIZER cancelling
  // the whole trip (percent of group total). Mark's ruling replaces the typical cruise-line tables in 04 and 12 with the
  // line's own schedule; this one is left as the template prints it until Mark / Cornerstone say whether it should follow.
  sigStart: /^\*\*Group Organizer:\*\*$/,
  feeLines: [/retainer fee/i, /substitution processing fee/i],
  rules: [
    { after: "Date:", today: true },
    { after: "Name:", fill: (c) => cleanValue(c.group.organizer_name), label: "Organizer name" },
    { after: "Organization / Group Name:", fill: (c) => cleanValue(c.group.name), label: "Group name" },
    { after: "Address:", slot: "org_address" },
    { after: "City, State, ZIP:", slot: "org_city_state_zip" },
    { after: "Phone:", slot: "org_phone" },
    { after: "Email:", slot: "org_email" },
    { after: "Name:", slot: "sec_name" },
    { after: "Phone:", slot: "sec_phone" },
    { after: "Email:", slot: "sec_email" },
    { after: "**Destination(s):**", fill: (c) => destinationText(c.group), label: "Destination" },
    { after: "Departure:", fill: (c) => fmtLong(c.group.sail_date), label: "Sail date" },
    { after: "Return:", fill: (c) => fmtLong(c.group.return_date), label: "Return date" },
    { after: "**Trip Duration:**", fill: (c) => (nights(c.group) ? String(nights(c.group)) : ""), label: "Nights" },
    { after: "nights / ", fill: (c) => (nights(c.group) ? String(nights(c.group)! + 1) : ""), label: "Days" },
    { after: "**Group Type:**", choice: "group_type" },
    { after: "Other:", slot: "group_type_other" },
    { after: "**Minimum Group Size for This Contract:**", fill: () => "", label: "Minimum group size" },
    { after: "**Current Confirmed Travelers:**", fill: (c) => (c.counts.travelers ? String(c.counts.travelers) : ""), label: "Confirmed travelers" },
    { after: "**Maximum Capacity:**", fill: (c) => (Number(c.group.cabins_held) > 0 ? String(Number(c.group.cabins_held) * 2) : ""), label: "Maximum capacity" },
    { after: "**Accommodation Preference:**", choice: "accommodation" },
    { after: "**Transportation Preference:**", choice: "transportation" },
    { after: "**Overall Group Budget (approximate per person):**", slot: "budget_pp" },
    { after: "a minimum of", fill: () => "", label: "Minimum group size" },
    { after: "**Group Booking Deadline:**", fill: (c) => fmtLong(c.group.deposit_due), label: "Group booking deadline" },
    {
      after: "**Per-Person Estimated Cost:**",
      fill: (c) => {
        const prices: number[] = (Array.isArray(c.group.terms?.cabin_categories) ? c.group.terms.cabin_categories : [])
          .map((l: Row) => Number(l.price_per_person)).filter((n: number) => Number.isFinite(n) && n > 0);
        return prices.length ? amountText(Math.min(...prices)) : "";
      },
      label: "Per-person estimated cost",
    },
    { after: "**4.3 Agent Planning Fee**", fill: (c) => (fee(c, "planning_fee") ? amountText(fee(c, "planning_fee")!.amount) : ""), label: "Planning fee" },
    { after: "one complimentary berth or accommodation for every", fill: () => "", label: "Complimentary berth ratio" },
    { after: "A substitution processing fee of", fill: (c) => (fee(c, "substitution_fee") ? amountText(fee(c, "substitution_fee")!.amount) : ""), label: "Substitution fee" },
  ],
  fields: [
    text("org_address", "Your address", { required: true }),
    text("org_city_state_zip", "City, state, ZIP", { required: true }),
    { name: "org_phone", label: "Your phone", kind: "tel", required: true, prefill: (c) => cleanValue(c.group.organizer_phone) || undefined },
    { name: "org_email", label: "Your email", kind: "email", required: true, prefill: (c) => cleanValue(c.group.organizer_email) || undefined },
    text("sec_name", "Secondary contact: name"),
    { name: "sec_phone", label: "Secondary contact: phone", kind: "tel" },
    { name: "sec_email", label: "Secondary contact: email", kind: "email" },
    {
      name: "group_type", label: "Group type", kind: "choice",
      options: [
        opt("family", "Family Reunion"), opt("faith", "Church / Faith Group"), opt("social", "Social Group / Club"), opt("corporate", "Corporate Retreat"),
        opt("celebration", "Birthday / Anniversary Celebration"), opt("sports", "Sports Team"), opt("school", "School / Educational"),
        opt("trip", "Girls’ / Guys’ Trip"), opt("incentive", "Incentive Travel"), opt("other", "Other", "Other:"),
      ],
    },
    text("group_type_other", "Other group type"),
    { name: "accommodation", label: "Accommodation preference", kind: "choice", options: [opt("resort", "All-Inclusive Resort"), opt("cruise", "Cruise"), opt("hotel", "Hotel"), opt("rentals", "Vacation Rentals"), opt("mix", "Mix"), opt("tbd", "TBD")], prefill: () => "cruise" },
    { name: "transportation", label: "Transportation preference", kind: "choice", options: [opt("flights", "Commercial Flights"), opt("charter", "Charter"), opt("self", "Self-Arranged"), opt("ground", "Ground Transport Only"), opt("tbd", "TBD")] },
    text("budget_pp", "Overall group budget, approximate per person ($)", { maxLength: 20 }),
  ],
  edits: [
    // 4.2: the amounts and dates the file holds; the second payment is not part of a group quote.
    (blocks, ctx) => mapTable(blocks, (t) => t.header[0] === "Payment" && t.header[2] === "Due Date", (t) => {
      const deposit = depositPerPerson(ctx);
      const depositDue = fmtLong(ctx.group.deposit_due) || (ctx.group.terms?.deposit_timing === "at_booking" ? "At booking" : "—");
      const retainer = fee(ctx, "retainer_fee");
      const rows: string[][] = [];
      if (retainer) rows.push(["Group organizer retainer fee", fmtMoney(retainer.amount), "Upon signing"]);
      rows.push(["Individual traveler deposits (per person)", deposit ? fmtMoney(deposit) : "As shown on the cruise line quote", depositDue]);
      rows.push(["Final payment (per person)", "The balance, as invoiced by the cruise line", fmtLong(ctx.group.final_payment_due) || "—"]);
      return [{ ...t, rows }];
    }),
  ],
};

// ── 06 — credit card authorization: kept working, in NO packet ────────────────
// Clients pay the cruise line or supplier directly (Mark 2026-10-03); whether Cornerstone's card form is ever
// needed is an open question for them. No route offers this document and no card number is ever an input.

const CARD_06: DocSpec = {
  key: "06-credit-card-authorization",
  title: "Credit Card Authorization",
  signerRole: "traveler",
  sigStart: /^\*\*Cardholder Signature:\*\*/,
  rules: [{ after: "Date:", today: true }],
  fields: [],
};

// ── 02 and 03 — only when Mark has entered a fee on the file ──────────────────
// TODO(group-signing): untested against a real fee arrangement (Mark: no fees by default). They render from the
// file's own fees; blanks the file cannot fill stay blank and are reported, and Cornerstone should confirm the wording.

const PLANNING_02: DocSpec = {
  key: "02-travel-planning-agreement",
  title: "Travel Planning Agreement",
  signerRole: "traveler",
  requiresFees: true,
  sigStart: /^\*\*CLIENT:\*\*$/,
  rules: [
    { after: "This agreement is entered into on:", today: true },
    { sub: "**Client:**", with: () => "**Client:**" },
    { after: "Name:", fill: legalName, label: "Client name" },
    { after: "Address:", fill: (c) => formText(c, "address"), label: "Address" },
    { after: "City, State, ZIP:", fill: (c) => formText(c, "city_state_zip"), label: "City, state, ZIP" },
    { after: "Phone:", fill: (c) => cleanValue(c.traveler?.phone), label: "Phone" },
    { after: "Email:", fill: (c) => cleanValue(c.traveler?.email), label: "Email" },
    { after: "**Destination(s):**", fill: (c) => destinationText(c.group), label: "Destination" },
    { after: "**Estimated Travel Dates:** From:", fill: (c) => fmtLong(c.group.sail_date), label: "Sail date" },
    { after: " To:", fill: (c) => fmtLong(c.group.return_date), label: "Return date" },
    { after: "**Number of Travelers:**", fill: (c) => String(1 + c.mates.length), label: "Number of travelers" },
    { after: "**6.1 Planning Fee**", fill: (c) => (fee(c, "planning_fee") ? amountText(fee(c, "planning_fee")!.amount) : ""), label: "Planning fee" },
    { after: "**6.3 Change/Rebooking Fees**", fill: (c) => (fee(c, "change_fee") ? amountText(fee(c, "change_fee")!.amount) : ""), label: "Change fee" },
  ],
  fields: [],
};

const FEE_03: DocSpec = {
  key: "03-service-fee-planning-fee-agreement",
  title: "Service Fee / Planning Fee Agreement",
  signerRole: "traveler",
  requiresFees: true,
  sigStart: /^\*\*Client:\*\*$/,
  rules: [
    { after: "Date:", today: true },
    { after: "**Client Name(s):**", fill: legalName, label: "Client name" },
    { after: "**Address:**", fill: (c) => formText(c, "address"), label: "Address" },
    { after: "**City, State, ZIP:**", fill: (c) => formText(c, "city_state_zip"), label: "City, state, ZIP" },
    { after: "**Phone:**", fill: (c) => cleanValue(c.traveler?.phone), label: "Phone" },
    { after: "**Email:**", fill: (c) => cleanValue(c.traveler?.email), label: "Email" },
    { after: "**Trip Destination(s):**", fill: (c) => destinationText(c.group), label: "Destination" },
    { after: "**Travel Dates:** From", fill: (c) => fmtLong(c.group.sail_date), label: "Sail date" },
    { after: " To ", fill: (c) => fmtLong(c.group.return_date), label: "Return date" },
    { after: "**Number of Travelers:**", fill: (c) => String(1 + c.mates.length), label: "Number of travelers" },
  ],
  fields: [],
  edits: [
    // The template's three blank fee tables become the fees Mark entered on the file.
    (blocks, ctx) => {
      const h = blocks.findIndex((b) => b.t === "h" && b.text === "FEE SCHEDULE");
      if (h < 0) throw new Error("client document 03 no longer matches its spec: FEE SCHEDULE not found");
      let j = h + 1;
      while (j < blocks.length && blocks[j]!.t !== "hr") j++;
      const table: Block = { t: "table", header: ["Fee", "Amount", "Applies to"], rows: ctx.fees.map((f) => [f.label, fmtMoney(f.amount), f.per ?? f.note ?? "—"]) };
      return [...blocks.slice(0, h + 1), table, ...blocks.slice(j)];
    },
    // Fee Type / Amount / Due Date / Payment Method are the schedule above; the bare lines would only print blanks.
    (blocks) => blocks.filter((b) => !(b.t === "p" && /^\*\*(Fee Type|Fee Amount|Payment Due Date|Payment Method):\*\*/.test(b.text))),
  ],
};

// ── 20 — About you (Mark 2026-10-29: "simplify the documents"; the data document, no legal wording) ──
// One screen per question on the page (like the form tools Mark compared), the whole record on one printed sheet.

const CRUISE_LINES: DocSpec["rules"] = [
  { after: "**Group:**", fill: (c) => cleanValue(displayName(c.group.name)), label: "Group name" },
  { after: "**Ship:**", fill: (c) => [displayName(c.group.cruise_line), displayName(c.group.ship_name)].map(cleanValue).filter(Boolean).join(" · "), label: "Ship" },
  { after: "**Sailing:**", fill: (c) => fmtLong(c.group.sail_date), label: "Sail date" },
  { after: "**Returning:**", fill: (c) => fmtLong(c.group.return_date), label: "Return date" },
];

const FIELDS_20: FieldSpec[] = [
  text("legal_name", "Full legal name, exactly as on your passport or ID", { required: true, form: "legal_name", prefill: (c) => fullName(c.traveler) || undefined }),
  { name: "dob", label: "Date of birth", kind: "date", required: true, date: "dob", col: "dob" },
  { name: "gender", label: "Gender", kind: "choice", required: true, options: GENDER, col: "gender" },
  { name: "us_citizen", label: "Are you a U.S. citizen?", kind: "choice", required: true, options: [opt("yes", "Yes"), opt("no", "No", "No")], form: "us_citizen" },
  text("citizenship", "Your country of citizenship", { required: (a) => a["us_citizen"] === "no", col: "citizenship" }),
  text("address", "Home address", { required: true, form: "address" }),
  text("city_state_zip", "City, state, ZIP", { required: true, form: "city_state_zip" }),
  { name: "phone", label: "Mobile phone", kind: "tel", required: true, col: "phone" },
  { name: "email", label: "Email address", kind: "email", required: true, col: "email" },
  { name: "passport_number", label: "Passport number", kind: "passport" },
  text("passport_country", "Passport country of issue", { required: (a) => typeof a["passport_number"] === "string", col: "passport_country" }),
  { name: "passport_issue", label: "Passport issue date", kind: "date", date: "past", form: "passport.issue_date" },
  { name: "passport_expiry", label: "Passport expiration date", kind: "date", date: "future", required: (a) => typeof a["passport_number"] === "string", col: "passport_expiry" },
  ...[1, 2].flatMap((i) => [
    text(`loyalty_${i}_program`, `Loyalty program ${i}`, { form: `loyalty.${i}.program` }),
    text(`loyalty_${i}_number`, `Membership number ${i}`, { form: `loyalty.${i}.number` }),
  ]),
  text("ec1_name", "Emergency contact: full name", { required: true, form: "emergency.primary.name", col: "emergency_name" }),
  text("ec1_relationship", "Relationship to you", { required: true, form: "emergency.primary.relationship" }),
  { name: "ec1_cell_phone", label: "Emergency contact: mobile phone", kind: "tel", required: true, form: "emergency.primary.cell_phone" },
  { name: "notes", label: "Anything we should know: dietary needs, mobility, medical, a birthday or anniversary on board", kind: "textarea", form: "notes" },
];

const ABOUT_20: DocSpec = {
  key: "20-about-you",
  title: "About you",
  signerRole: "traveler",
  sigStart: /^\*\*Traveler Signature:\*\*/,
  rules: [...CRUISE_LINES, { after: "**Date completed:**", today: true }],
  fields: FIELDS_20,
  derive: (a, ctx) => {
    const patch = DERIVE_15(a, ctx);
    if (typeof a["notes"] === "string" && a["notes"].trim()) patch["special_needs"] = a["notes"].trim().slice(0, 1000);
    return patch;
  },
};

// ── 21 — Your booking (Mark 2026-10-29): the cabin and price from the file, then the terms, the risks, the documents and the
// insurance choice, condensed from Cornerstone's 01, 05, 07, 12 and 16, under ONE signature. Every traveler signs it.

const BOOKING_21: DocSpec = {
  key: "21-your-booking",
  title: "Your booking",
  signerRole: "traveler",
  sigStart: /^\*\*Traveler Signature:\*\*/,
  cancellationHeading: /^THE CRUISE LINE'S CANCELLATION SCHEDULE$/,
  rules: [
    { after: "**Traveler:**", fill: legalName, label: "Traveler name" },
    { after: "**Address:**", fill: (c) => [formText(c, "address"), formText(c, "city_state_zip")].filter(Boolean).join(", "), label: "Address" },
    ...CRUISE_LINES,
    { after: "**From:**", fill: (c) => cleanValue(c.group.embark_port), label: "Departure port" },
    { after: "**Ports:**", fill: (c) => destinationText(c.group), label: "Ports" },
    { after: "**Cabin category:**", fill: (c) => [c.cabin?.category, c.cabin?.category_code ? `(${c.cabin.category_code})` : ""].map(cleanValue).filter(Boolean).join(" "), label: "Cabin category" },
    { after: "**Cabin number:**", fill: (c) => cleanValue(c.cabin?.cabin_num) || "To be assigned", label: "Cabin number" },
    { after: "as quoted (taxes included):** $", fill: (c) => (perPersonPrice(c) ? amountText(perPersonPrice(c)!) : ""), label: "Cruise fare per person" },
    { after: "**Deposit per person:** $", fill: (c) => (depositPerPerson(c) ? amountText(depositPerPerson(c)!) : ""), label: "Deposit per person" },
    { after: "**Deposit due:**", fill: (c) => fmtLong(c.group.deposit_due) || (c.group.terms?.deposit_timing === "at_booking" ? "When you book" : ""), label: "Deposit due" },
    { after: "**Final payment due:**", fill: (c) => fmtLong(c.group.final_payment_due), label: "Final payment due" },
    { after: "**Booking number:**", fill: (c) => bookingReference(c) || "Assigned when the line confirms", label: "Booking number" },
    { after: "**Date:**", today: true },
    { after: "valid at least six months past", fill: (c) => fmtLong(c.group.return_date), label: "Return date" },
    { after: "CDC notices for", fill: (c) => destinationText(c.group), label: "Destination" },
  ],
  fields: [
    {
      name: "insurance_choice", label: "Travel insurance: your choice", kind: "choice", required: true, form: "insurance.choice",
      options: [
        opt("quote", "Yes, quote me insurance through Mark"),
        opt("own", "I have my own policy"),
        opt("decline", "I decline travel insurance. I understand I am accepting those costs myself, and that Still Afloat Cruising and Cornerstone Collective are not liable for losses insurance would have covered."),
      ],
    },
    text("insurance_policy", "Your own policy: provider and policy number", { required: (a) => a["insurance_choice"] === "own", form: "insurance.policy" }),
  ],
};

// ── 22 — Credit card authorization (Mark 2026-10-29: "a credit card authorization every time"), modelled on Cornerstone's own
// e-signed form: the last four digits and the expiry only, never the number or the security code; the cabin's lead signs it.
// The driver's licence (Cornerstone's identity check) is taken too: the state in clear, the number encrypted (dl_enc, migration 0059).

// Mark 2026-10-30: "the driver's license is for the person who owns the credit card, not necessarily the traveller. we need a check box
// if it is the traveller, continue, if it is someone else we need the information requested on the form": the traveler's own card takes
// its cardholder lines from the file; someone else's card asks for that person's details. The licence is the cardholder's either way.
const otherCard = (a: Answers) => a["cardholder"] === "other";
const CARD_FIELDS: FieldSpec[] = [
  { name: "cardholder", label: "Is the card in your name?", kind: "choice", required: true, form: "card.holder", options: [opt("me", "Yes, it is my card"), opt("other", "No, it belongs to someone else")] },
  text("card_name", "Cardholder's name, as it appears on the card", { required: otherCard, form: "card.name" }),
  text("card_address", "Cardholder's billing address", { required: otherCard, form: "card.address" }),
  text("card_city_state_zip", "Cardholder's city, state, ZIP", { required: otherCard, form: "card.city_state_zip" }),
  { name: "card_phone", label: "Cardholder's phone", kind: "tel", required: otherCard, form: "card.phone" },
  { name: "card_type", label: "Card type", kind: "choice", required: true, options: [opt("visa", "Visa"), opt("mastercard", "Mastercard"), opt("amex", "American Express"), opt("discover", "Discover")], form: "card.type" },
  text("card_last4", "Card ending in (last four digits only)", { required: true, maxLength: 4, form: "card.last4" }),
  text("card_expiry", "Expires (MM/YY)", { required: true, maxLength: 5, form: "card.expiry" }),
  // Mark 2026-10-30: the driver's licence, as on Cornerstone's form — to verify identity; the number is encrypted like the passport
  text("dl_state", "Cardholder's driver's licence: state", { required: true, maxLength: 2, col: "dl_state" }),
  { name: "dl_number", label: "Cardholder's driver's licence: number", kind: "license", required: true },
];
/** The traveler's own card: the cardholder is the traveler on file (name, address, city/state/ZIP, phone), nothing asked twice. */
function ownCard(a: Answers, c: DocCtx): Answers {
  if (a["cardholder"] !== "me") return a;
  const own: Answers = { ...a };
  const from: Array<[string, string]> = [["card_name", legalName(c)], ["card_address", formText(c, "address")], ["card_city_state_zip", formText(c, "city_state_zip")], ["card_phone", cleanValue(c.traveler?.phone)]];
  for (const [k, v] of from) if (v) own[k] = v; else delete own[k];
  return own;
}

const CARD_22: DocSpec = {
  key: "22-card-authorization",
  title: "Credit card authorization",
  signerRole: "lead",
  sigStart: /^\*\*Cardholder Signature:\*\*/,
  rules: [
    ...CRUISE_LINES,
    { after: "**Cabin category:**", fill: (c) => [c.cabin?.category, c.cabin?.category_code ? `(${c.cabin.category_code})` : ""].map(cleanValue).filter(Boolean).join(" "), label: "Cabin category" },
    { after: "**Booking number:**", fill: (c) => bookingReference(c) || "Assigned when the line confirms", label: "Booking number" },
    { after: "**Total authorized:** $", fill: (c) => (cabinTotal(c) ? amountText(cabinTotal(c)!) : ""), label: "Total authorized" },
    { after: "**Date:**", today: true },
  ],
  fields: CARD_FIELDS,
  complete: ownCard,
  validate: (a) => {
    const errors: Record<string, string> = {};
    if (typeof a["card_last4"] === "string" && !/^\d{4}$/.test(a["card_last4"])) errors["card_last4"] = "Just the last four digits of the card.";
    if (typeof a["card_expiry"] === "string") {
      const m = /^(\d{2})\/(\d{2})$/.exec(a["card_expiry"]);
      if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) errors["card_expiry"] = "The expiry as MM/YY, for example 03/30.";
    }
    return errors;
  },
};

export const DOC_SPECS: Record<string, DocSpec> = Object.fromEntries(
  [ABOUT_20, BOOKING_21, CARD_22, FORM_15, TERMS_01, PLANNING_02, FEE_03, CANCELLATION_04, WAIVER_05, CARD_06, INSURANCE_07, CONTRACT_09, BOOKING_12, CHECKLIST_16].map((s) => [s.key, s]),
);
