import { test } from "node:test";
import assert from "node:assert/strict";
import { DOC_SHORT, buildAnalytics, fetchAll, maskEmail, maskName, type AnalyticsRaw } from "./group-analytics";
import { summarize } from "./group-file";
import { packetFor } from "./group-documents";
import { ALL_KINDS } from "./group-journey";

// "Today" for every test: 19 Oct 2026 (the group list uses the UTC date, so does the builder).
const NOW = new Date("2026-10-19T15:00:00Z");
const TODAY = "2026-10-19";

type Row = Record<string, any>;

// The secrets the dashboard must never see. They are put on the raw rows on purpose, with recognisable values.
const SECRET_KEYS = ["passport_enc", "form_token_hash", "hub_token_hash", "organizer_token_hash", "ip_hash", "ua_hash", "consent_ip_hash", "answers", "body_html", "pdf_path"];
const SECRET_VALUES = ["PASSPORT-CIPHERTEXT-XYZ", "FORM-HASH-123", "HUB-HASH-456", "ORGANIZER-HASH-789", "IP-HASH-AAA", "UA-HASH-BBB", "CONSENT-IP-CCC", "SECRET-ANSWER-DDD", "<p>BODY-HTML-EEE</p>", "signed/FILE-PATH-FFF.pdf", "PASSPORT-9999"];

const traveler = (id: string, over: Row = {}): Row => ({
  id, group_id: "g1", cabin_id: "c1", is_lead: false, first_name: "Ann", last_name: "Lee", email: "ann.lee@gmail.com", lang: "en",
  passport_last4: null, form_sent_at: null, form_submitted_at: null, consent_signed_at: null, emergency_name: null, emergency_phone: null, form_data: {},
  passport_enc: SECRET_VALUES[0], form_token_hash: SECRET_VALUES[1], hub_token_hash: SECRET_VALUES[2], consent_ip_hash: SECRET_VALUES[6], passport_number: SECRET_VALUES[10],
  ...over,
});

function fixture(): AnalyticsRaw {
  const groups: Row[] = [
    {
      id: "g1", name: "Alpha 2027", status: "booking", lang: "both", cruise_line: "Carnival", ship_name: "Mardi Gras",
      sail_date: "2027-05-09", return_date: "2027-05-16", cabins_held: 3, deposit_per_person: 100,
      deposit_due: "2026-10-29", names_due: "2026-12-18", final_payment_due: "2027-02-16", recall_date: "2027-01-15",
      fees: {}, journey: {}, marketing_approved_at: "2026-10-10T00:00:00Z", organizer_token_hash: SECRET_VALUES[3],
      terms: {
        allotment_reviews: [{ date: "2026-12-01", days_before: 159, percent_retaken: 25 }],
        deadlines: [{ date: "2026-11-15", days_before: 175, text: "Send the rooming list to groups@carnival.com by this date" }],
      },
    },
    { id: "g2", name: "Beta Sailed", status: "sailed", lang: "en", cruise_line: "Royal Caribbean", ship_name: "Icon", sail_date: "2026-08-01", return_date: "2026-08-08", cabins_held: 1, fees: {}, journey: {}, terms: {} },
  ];
  const cabins: Row[] = [
    { id: "c1", group_id: "g1", cabin_num: "8214", category: "Balcony", category_code: "8C", status: "booked", booking_number: "7K4P29", price_total: 4000, deposit_amount: 400 },
    { id: "c2", group_id: "g1", cabin_num: "8216", category: "Balcony", category_code: "8C", status: "held", booking_number: null, price_total: 4000, deposit_amount: 400 },
    { id: "c3", group_id: "g1", cabin_num: "9001", category: "Suite", category_code: "S1", status: "released", booking_number: null, price_total: 6000, deposit_amount: 600 },
    { id: "c4", group_id: "g2", cabin_num: "1", category: "Inside", category_code: "4A", status: "booked", booking_number: "Z1", price_total: 1000, deposit_amount: 100 },
  ];
  const travelers: Row[] = [
    traveler("t1", { cabin_id: "c1", is_lead: true, first_name: "Ann", last_name: "Lee", email: "ann.lee@gmail.com", passport_last4: "1234", form_sent_at: "2026-10-01T00:00:00Z", form_submitted_at: "2026-10-02T00:00:00Z" }),
    traveler("t2", { cabin_id: "c1", first_name: "Bo", last_name: "Lee", email: "bo@example.com", lang: "es", form_sent_at: "2026-10-01T00:00:00Z", form_opened_at: "2026-10-05T10:20:00Z", esign_consent_at: "2026-10-05T10:21:00Z" }),
    traveler("t3", { cabin_id: "c2", is_lead: true, first_name: "Cy", last_name: "Diaz", email: null, lang: "es" }),
    traveler("t4", { cabin_id: "c3", first_name: "Di", last_name: "Released", email: "di@example.com" }), // on a released cabin: left out
    traveler("t5", { group_id: "g2", cabin_id: "c4", first_name: "Ed", last_name: "Sailed", email: "ed@example.com" }),
  ];
  const payments: Row[] = [
    { id: "p1", group_id: "g1", cabin_id: "c1", kind: "deposit", amount: 400, due_date: "2026-10-29", paid_at: "2026-10-05T00:00:00Z" },
    { id: "p2", group_id: "g1", cabin_id: "c2", kind: "deposit", amount: 400, due_date: "2026-10-10", paid_at: null }, // overdue
    { id: "p3", group_id: "g1", cabin_id: "c1", kind: "final", amount: 3600, due_date: "2027-02-16", paid_at: null },
    { id: "p4", group_id: "g1", cabin_id: "c2", kind: "final", amount: 3600, due_date: null, paid_at: null }, // no date
    { id: "p5", group_id: "g1", cabin_id: "c3", kind: "deposit", amount: 600, due_date: "2026-10-01", paid_at: null }, // released cabin: left out
  ];
  const signatures: Row[] = [
    ...packetFor({ group: groups[0], cabin: cabins[0], traveler: travelers[0] }).map((k) => ({ group_id: "g1", traveler_id: "t1", doc_key: k, signer_role: "lead", signed_at: "2026-10-03T00:00:00Z", answers: { x: SECRET_VALUES[7] }, ip_hash: SECRET_VALUES[4], ua_hash: SECRET_VALUES[5], pdf_path: SECRET_VALUES[9] })),
    { id: "s-t2-01", sealed: true, group_id: "g1", traveler_id: "t2", doc_key: "15-emergency-contact-form", signer_role: "traveler", signed_at: "2026-10-04T00:00:00Z", answers: { x: SECRET_VALUES[7] }, ip_hash: SECRET_VALUES[4], ua_hash: SECRET_VALUES[5], pdf_path: SECRET_VALUES[9] },
  ];
  const messages: Row[] = [
    { id: "m1", group_id: "g1", traveler_id: "t1", template: "t-120", to_email: "ann.lee@gmail.com", status: "sent", sent_at: "2026-10-07T00:00:00Z", dedupe_key: "journey:t-120:t1:2027-05-09", body_html: SECRET_VALUES[8], created_at: "2026-10-07T00:00:00Z" },
    { id: "m2", group_id: "g1", traveler_id: "t2", template: "t-120", to_email: "bo@example.com", status: "failed", dedupe_key: "journey:t-120:t2:2027-05-09", meta: { attempts: 3 }, body_html: SECRET_VALUES[8], created_at: "2026-10-07T00:00:00Z" },
    { id: "m3", group_id: "g1", traveler_id: "t1", template: "confirmation", to_email: "ann.lee@gmail.com", status: "queued", dedupe_key: "journey:confirmation:t1:2027-05-09", body_html: SECRET_VALUES[8], created_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-19T14:59:00Z" },
    { id: "m4", group_id: "g1", traveler_id: "t1", template: "t-90", to_email: "ann.lee@gmail.com", status: "sent", dedupe_key: "sim:t-90:t1", body_html: SECRET_VALUES[8], created_at: "2026-10-09T00:00:00Z" }, // a dry run: left out
    { id: "m5", group_id: "g1", traveler_id: "t1", template: "paperwork-link", to_email: "ann.lee@gmail.com", status: "sent", sent_at: "2026-10-01T00:00:00Z", dedupe_key: null, body_html: SECRET_VALUES[8], created_at: "2026-10-01T00:00:00Z" },
  ];
  const interests: Row[] = [
    { id: "i1", group_id: "g1", first_name: "Jane", last_name: "Smith", email: "jane.smith@gmail.com", lang: "en", cabin_type: "Balcony", guests: 2, status: "new", created_at: "2026-10-17T12:00:00Z", ip_hash: SECRET_VALUES[4] },
    { id: "i2", group_id: "g1", first_name: "Raul", last_name: "Perez", email: "raul@example.com", lang: "es", cabin_type: null, guests: 4, status: "booked", created_at: "2026-09-01T12:00:00Z", ip_hash: SECRET_VALUES[4] },
    { id: "i3", group_id: "g1", first_name: "Bot", last_name: "Spam", email: "bot@spam.example", lang: "en", status: "spam", created_at: "2026-10-18T12:00:00Z", ip_hash: SECRET_VALUES[4] },
  ];
  return { groups, cabins, travelers, payments, travel: [], checklist: [], documents: [], signatures, messages, interests, journeyDefaults: { approved: {} } };
}

const built = () => buildAnalytics(fixture(), NOW);
const group = (a: ReturnType<typeof built>, id: string) => a.groups.find((g) => g.id === id)!;

// ── Nothing secret leaves ──

test("the output never contains a secret column, a secret value, or an unmasked email address", () => {
  const json = JSON.stringify(built());
  for (const k of SECRET_KEYS) assert.equal(json.includes(k), false, `the output contains "${k}"`);
  for (const v of SECRET_VALUES) assert.equal(json.includes(v), false, `the output contains the value ${v}`);
  // any address-shaped text must be masked: a word character before the @ means a plain address
  assert.equal(/[\w.+-]+@[\w-]+(\.[\w-]+)+/.test(json), false, `an unmasked address: ${json.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0]}`);
  assert.ok(json.includes("a•••@gmail.com"), "the masked form is there");
});

test("an address inside a quote's free-text deadline is masked too", () => {
  const a = built();
  const d = a.deadlines.find((x) => x.date === "2026-11-15")!;
  assert.ok(d, "the quoted deadline is listed");
  assert.equal(d.label, "Send the rooming list to g•••@carnival.com by this date");
});

test("masks: an address keeps its first letter and its domain, a lead keeps a surname initial", () => {
  assert.equal(maskEmail("mark@gmail.com"), "m•••@gmail.com");
  assert.equal(maskEmail("  Mark@Gmail.com "), "M•••@Gmail.com");
  assert.equal(maskEmail("not an address"), null);
  assert.equal(maskEmail(null), null);
  assert.equal(maskEmail("@gmail.com"), null);
  assert.equal(maskName("Jane", "Smith"), "Jane S.");
  assert.equal(maskName("Jane", ""), "Jane");
  assert.equal(maskName(null, null), "—");
});

test("whether a passport is on file is a yes or no, never the digits", () => {
  const a = built();
  assert.equal(a.travelers.find((t) => t.id === "t1")!.passportOnFile, true);
  assert.equal(a.travelers.find((t) => t.id === "t2")!.passportOnFile, false);
  assert.equal(JSON.stringify(a).includes("1234"), false, "the last four digits are not in the output either");
});

// ── Counts agree with the group list ──

test("a group's cabin, traveler and payment figures are the group list's own (summarize)", () => {
  const raw = fixture();
  const a = buildAnalytics(raw, NOW);
  for (const g of raw.groups) {
    const s = summarize({
      group: g, cabins: raw.cabins.filter((c) => c.group_id === g.id), travelers: raw.travelers.filter((t) => t.group_id === g.id),
      payments: raw.payments.filter((p) => p.group_id === g.id), documents: [], checklist: [], messages: raw.messages.filter((m) => m.group_id === g.id),
    }, TODAY);
    const row = group(a, g.id);
    assert.deepEqual([row.cabinsTotal, row.cabinsHeld, row.cabinsOffered, row.cabinsBooked, row.cabinsReleased], [s.cabins.total, s.cabins.held, s.cabins.offered, s.cabins.booked, s.cabins.released], g.id);
    assert.deepEqual([row.travelersExpected, row.formsReturned], [s.travelers.total, s.travelers.formsIn], g.id);
    assert.deepEqual([row.amountDue, row.amountPaid, row.paymentsOverdue], [s.payments.dueTotal, s.payments.paidTotal, s.payments.overdueCount], g.id);
    assert.deepEqual([row.depositsTotal, row.depositsPaid], [s.deposits.total, s.deposits.paid], g.id);
    assert.equal(row.daysToSail, s.daysToSail);
  }
});

test("group figures for the fixture", () => {
  const g = group(built(), "g1");
  assert.equal(g.cabinsBooked, 1);
  assert.equal(g.cabinsHeld, 1);
  assert.equal(g.cabinsReleased, 1);
  assert.equal(g.travelersOnFile, 3, "the traveler on the released cabin is not counted");
  assert.equal(g.formsSent, 2);
  assert.equal(g.formsReturned, 1);
  assert.equal(g.fullySigned, 1);
  assert.equal(g.paymentsPaid, 1);
  assert.equal(g.paymentsOpen, 3);
  assert.equal(g.paymentsOverdue, 1);
  assert.equal(g.amountOverdue, 400);
  assert.equal(g.amountPaid, 400);
  assert.equal(g.amountDue, 400 + 3600 + 3600);
  assert.equal(g.interestsTotal, 2, "a spam reply is not a lead");
  assert.equal(g.interestsNew, 1);
  assert.equal(g.interestsConverted, 1);
  assert.equal(g.marketingApproved, true);
  assert.equal(group(built(), "g2").marketingApproved, false);
});

test("rows on a released cabin are left out of the row datasets, the cabin itself is listed", () => {
  const a = built();
  assert.ok(a.cabins.some((c) => c.id === "c3" && c.status === "released"));
  assert.equal(a.travelers.some((t) => t.id === "t4"), false);
  assert.equal(a.paperwork.some((p) => p.travelerId === "t4"), false);
  assert.equal(a.payments.some((p) => p.id === "p5"), false);
});

test("a cabin lists its travelers", () => {
  const c1 = built().cabins.find((c) => c.id === "c1")!;
  assert.equal(c1.travelerCount, 2);
  assert.equal(c1.travelers, "Ann Lee, Bo Lee");
  assert.equal(c1.bookingNumber, "7K4P29");
  assert.equal(c1.priceTotal, 4000);
});

// ── Payments ──

test("payment status: paid, due, overdue, no date; days out are counted from today", () => {
  const p = (id: string) => built().payments.find((x) => x.id === id)!;
  assert.deepEqual([p("p1").status, p("p1").daysOut], ["paid", 10]);
  assert.deepEqual([p("p2").status, p("p2").daysOut], ["overdue", -9]);
  assert.deepEqual([p("p3").status, p("p3").daysOut], ["due", 120]);
  assert.deepEqual([p("p4").status, p("p4").daysOut], ["no date", null]);
  assert.equal(p("p2").cabinNum, "8216");
});

// ── Paperwork ──

test("paperwork: one row per traveler and required document, signed or pending", () => {
  const raw = fixture();
  const a = buildAnalytics(raw, NOW);
  const t1 = a.paperwork.filter((p) => p.travelerId === "t1");
  const t2 = a.paperwork.filter((p) => p.travelerId === "t2");
  const t3 = a.paperwork.filter((p) => p.travelerId === "t3");
  assert.deepEqual(t1.map((p) => p.docKey), packetFor({ group: raw.groups[0], cabin: raw.cabins[0], traveler: raw.travelers[0] }));
  assert.equal(t1.every((p) => p.status === "signed" && p.signedAt === "2026-10-03T00:00:00Z"), true);
  assert.deepEqual(t2.map((p) => p.docKey), ["15-emergency-contact-form", "01-terms-and-conditions", "05-liability-waiver", "07-travel-insurance-declination", "16-passport-document-checklist"], "every traveler owes the same five (Mark 2026-10-30)");
  assert.deepEqual(t2.filter((p) => p.status === "signed").map((p) => p.docKey), ["15-emergency-contact-form"]);
  assert.equal(t3.every((p) => p.status === "pending" && p.signedAt === null), true);
  // Mark 2026-10-25: the workspace opens a signed copy itself: the signature's id and two yes/no flags, never the file's path
  const terms2 = t2.find((p) => p.docKey === "15-emergency-contact-form")!;
  assert.deepEqual([terms2.signatureId, terms2.hasCopy, terms2.sealed], ["s-t2-01", true, true]);
  assert.equal(t3.every((p) => p.signatureId === null && !p.hasCopy && !p.sealed), true, "a pending document has no signature, copy or seal");
  assert.equal(t1.every((p) => p.signatureId === null && p.hasCopy === true && p.sealed === false), true, "a copy on file whose signature row carries no id: no id is invented (the workspace then shows no open button)");
  const tr = (id: string) => a.travelers.find((t) => t.id === id)!;
  assert.deepEqual([tr("t1").fullySigned, tr("t2").fullySigned, tr("t3").fullySigned], [true, false, false]);
  assert.deepEqual([tr("t1").formOpenedAt, tr("t1").consentAt, tr("t1").copiesSentAt], [null, null, null], "no opening, consent or copies on file: nulls, never a guess");
  assert.deepEqual([tr("t2").formOpenedAt, tr("t2").consentAt, tr("t2").copiesSentAt], ["2026-10-05T10:20:00Z", "2026-10-05T10:21:00Z", null]);
  assert.equal(tr("t2").docsSigned, 1);
  assert.equal(tr("t2").docsRequired, t2.length);
  assert.equal(tr("t2").lang, "es");
  assert.equal(t2[0]!.travelerLang, "es");
});

test("every document a packet can contain has a short matrix title, and the catalog lists them in packet order", () => {
  const a = built();
  for (const d of a.docs) assert.ok(d.title && d.title !== d.key, `${d.key} has a title`);
  assert.deepEqual(a.docs.map((d) => d.key).slice(0, 2), ["15-emergency-contact-form", "01-terms-and-conditions"]);
  for (const k of Object.keys(DOC_SHORT)) assert.ok(DOC_SHORT[k]!.length < 30, k);
});

// ── Messages and leads ──

test("messages: a dry run is left out, a body is never carried, the address is masked", () => {
  const a = built();
  assert.equal(a.messages.some((m) => m.id === "m4"), false);
  assert.deepEqual(a.messages.map((m) => m.id).sort(), ["m1", "m2", "m3", "m5"]);
  const m1 = a.messages.find((m) => m.id === "m1")!;
  assert.deepEqual([m1.kind, m1.status, m1.to, m1.travelerName, m1.journey], ["t-120", "sent", "a•••@gmail.com", "Ann Lee", true]);
  assert.equal(a.messages.find((m) => m.id === "m5")!.journey, false, "the paperwork invitation is not a journey email");
  const g = group(a, "g1");
  assert.deepEqual([g.journeyQueued, g.journeySent, g.journeyFailed], [1, 1, 1]);
});

test("interests: spam is left out, the lead's name and address are masked, age is in days", () => {
  const a = built();
  assert.deepEqual(a.interests.map((i) => i.id).sort(), ["i1", "i2"]);
  const i1 = a.interests.find((i) => i.id === "i1")!;
  assert.deepEqual([i1.name, i1.email, i1.daysAgo, i1.guests, i1.status, i1.cabinType], ["Jane S.", "j•••@gmail.com", 2, 2, "new", "Balcony"]);
});

// ── Deadlines ──

test("deadlines: the group's dates, the line's reviews and quoted deadlines, the sailing and the journey emails", () => {
  const a = built();
  const mine = a.deadlines.filter((d) => d.groupId === "g1");
  const kinds = new Set(mine.map((d) => d.kind));
  for (const k of ["deposit", "names", "final", "recall", "line", "journey", "sail"]) assert.ok(kinds.has(k as any), `kind ${k}`);
  assert.deepEqual(mine.map((d) => d.daysOut), [...mine.map((d) => d.daysOut)].sort((x, y) => x - y), "sorted by date");
  const dep = mine.find((d) => d.kind === "deposit")!;
  assert.deepEqual([dep.date, dep.daysOut, dep.done], ["2026-10-29", 10, false]);
  assert.equal(mine.find((d) => d.kind === "final")!.daysOut, 120);
  const review = mine.find((d) => d.date === "2026-12-01")!;
  assert.equal(review.label, "Line reviews the block (takes back 25% of unsold)");
  assert.equal(mine.find((d) => d.kind === "sail")!.label, "Sailing — Mardi Gras");
});

test("a finished group has no deadlines", () => {
  assert.equal(built().deadlines.some((d) => d.groupId === "g2"), false);
});

test("deadlines older than two weeks or further off than 400 days are not listed", () => {
  const raw = fixture();
  raw.groups[0]!.deposit_due = "2026-09-01"; // 48 days ago
  raw.groups[0]!.names_due = "2026-10-10"; // 9 days ago: still listed, as passed
  raw.groups[0]!.terms = { allotment_reviews: [], deadlines: [{ date: "2028-12-01", text: "far away" }] };
  const mine = buildAnalytics(raw, NOW).deadlines.filter((d) => d.groupId === "g1");
  assert.equal(mine.some((d) => d.kind === "deposit"), false);
  assert.equal(mine.find((d) => d.kind === "names")!.daysOut, -9);
  assert.equal(mine.some((d) => d.label === "far away"), false);
});

test("a recall date that is also a line review date is listed once", () => {
  const raw = fixture();
  raw.groups[0]!.recall_date = "2026-12-01";
  const mine = buildAnalytics(raw, NOW).deadlines.filter((d) => d.groupId === "g1" && d.date === "2026-12-01");
  assert.deepEqual(mine.map((d) => d.kind), ["line"]);
});

test("deposit, final and names deadlines already met are marked done", () => {
  const raw = fixture();
  for (const p of raw.payments) if (p.group_id === "g1" && p.cabin_id !== "c3") p.paid_at = "2026-10-01T00:00:00Z";
  const mine = buildAnalytics(raw, NOW).deadlines.filter((d) => d.groupId === "g1");
  assert.equal(mine.find((d) => d.kind === "deposit")!.done, true);
  assert.equal(mine.find((d) => d.kind === "final")!.done, true);
  assert.equal(mine.find((d) => d.kind === "names")!.done, false, "forms are still missing");
  const g = group(buildAnalytics(raw, NOW), "g1");
  assert.equal(g.nextDeadlineDate, "2026-11-15", "the next deadline skips the deposit that is already met");
});

test("the group's next deadline is the nearest one still to do", () => {
  const g = group(built(), "g1");
  assert.deepEqual([g.nextDeadlineLabel, g.nextDeadlineDate, g.nextDeadlineDaysOut], ["Group deposit deadline", "2026-10-29", 10]);
  const done = group(built(), "g2");
  assert.deepEqual([done.nextDeadlineLabel, done.nextDeadlineDate, done.nextDeadlineDaysOut], [null, null, null]);
});

test("journey emails with a day are deadlines, counted by traveler, and wait on the template approval", () => {
  const a = built();
  const j = a.deadlines.filter((d) => d.kind === "journey" && d.groupId === "g1");
  assert.ok(j.length >= 5, `expected the 90, 45, 20, 10, 5, 2-day emails, got ${j.length}`);
  const t90 = j.find((d) => d.label === "Email: 90 days before")!;
  assert.deepEqual([t90.date, t90.state], ["2027-02-08", "planned"]);
  assert.match(t90.detail ?? "", /^\d+ travelers?$/);
});

// ── Journey figures ──

test("journey: a row for every kind of email for every group, with counts that add up to the travelers", () => {
  const a = built();
  for (const g of ["g1", "g2"]) {
    const rows = a.journey.filter((r) => r.groupId === g);
    assert.deepEqual(rows.map((r) => r.kind).sort(), [...ALL_KINDS].sort(), g);
  }
  const t120 = a.journey.find((r) => r.groupId === "g1" && r.kind === "t-120")!;
  assert.equal(t120.sent, 1);
  assert.equal(t120.failed, 1);
  assert.equal(t120.date, "2027-01-09");
});

// ── Needs attention ──

test("needs attention: overdue payments and new leads say why; a finished group never does", () => {
  const g = group(built(), "g1");
  assert.equal(g.needsAttention, true);
  assert.ok(g.attentionReasons.includes("1 overdue payment"));
  assert.ok(g.attentionReasons.includes("1 journey email failed"));
  assert.ok(g.attentionReasons.includes("1 new lead waiting"));
  const raw = fixture();
  raw.groups[1]!.status = "sailed";
  raw.payments.push({ id: "px", group_id: "g2", cabin_id: "c4", kind: "final", amount: 10, due_date: "2026-01-01", paid_at: null });
  const g2 = group(buildAnalytics(raw, NOW), "g2");
  assert.deepEqual([g2.paymentsOverdue, g2.needsAttention, g2.attentionReasons], [1, false, []]);
});

test("groups are listed by sail date, soonest first, none without a date ahead of one with", () => {
  const raw = fixture();
  raw.groups.push({ id: "g3", name: "No date", status: "draft", lang: "en", sail_date: null, fees: {}, journey: {}, terms: {} });
  assert.deepEqual(buildAnalytics(raw, NOW).groups.map((g) => g.id), ["g2", "g1", "g3"]);
});

test("an empty database gives empty datasets, not an error", () => {
  const a = buildAnalytics({ groups: [], cabins: [], travelers: [], payments: [], travel: [], checklist: [], documents: [], signatures: [], messages: [], interests: [], journeyDefaults: { approved: {} } }, NOW);
  for (const k of ["groups", "cabins", "travelers", "payments", "paperwork", "messages", "interests", "deadlines", "journey", "docs", "warnings"] as const) {
    assert.deepEqual(a[k], [], k);
  }
  assert.equal(a.today, TODAY);
  assert.equal(a.generatedAt, NOW.toISOString());
});

test("the builder does not change the rows it is given", () => {
  const raw = fixture();
  const before = JSON.stringify(raw);
  buildAnalytics(raw, NOW);
  assert.equal(JSON.stringify(raw), before);
});

// ── Reading a whole table ──

test("fetchAll reads page after page until one comes back short, so nothing is cut off at 1,000 rows", async () => {
  const table = Array.from({ length: 2503 }, (_, i) => ({ id: i }));
  const calls: Array<[number, number]> = [];
  const rows = await fetchAll(async (from, to) => { calls.push([from, to]); return { data: table.slice(from, to + 1), error: null }; }, "things");
  assert.equal(rows.length, 2503);
  assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]]);
  assert.equal(rows[2502]!.id, 2502);
});

test("fetchAll asks once more after an exactly full page, and stops on an empty one", async () => {
  const table = Array.from({ length: 2000 }, (_, i) => ({ id: i }));
  const calls: number[] = [];
  const rows = await fetchAll(async (from, to) => { calls.push(from); return { data: table.slice(from, to + 1), error: null }; }, "things");
  assert.equal(rows.length, 2000);
  assert.deepEqual(calls, [0, 1000, 2000]);
});

test("fetchAll names the table when the database refuses", async () => {
  await assert.rejects(fetchAll(async () => ({ data: null, error: { message: "boom" } }), "group_cabins"), /group_cabins: boom/);
});

test("fetchAll treats a missing page body as empty", async () => {
  assert.deepEqual(await fetchAll(async () => ({ data: null, error: null }), "x"), []);
});
