import { test } from "node:test";
import assert from "node:assert/strict";
import { CHILDREN, GROUP_COLUMNS, looksLikeCardNumber, missingSchedule, pickWritable, slugify, summarize, type GroupFile } from "./group-file";

test("slugify makes a url-safe slug", () => {
  assert.equal(slugify("American Legion Post 12 — Alaska 2027"), "american-legion-post-12-alaska-2027");
  assert.equal(slugify("  Cumpleaños 91 de Mamá  "), "cumpleanos-91-de-mama");
});

test("card-shaped numbers are detected, ordinary references are not", () => {
  assert.equal(looksLikeCardNumber("4111 1111 1111 1111"), true);
  assert.equal(looksLikeCardNumber("card 5500-0000-0000-0004 exp 01/29"), true);
  assert.equal(looksLikeCardNumber("378282246310005"), true);
  assert.equal(looksLikeCardNumber("813-555-0142"), false);
  assert.equal(looksLikeCardNumber("booking 7K4P29 paid by phone"), false);
  assert.equal(looksLikeCardNumber("4111 1111 1111 1112"), false); // fails Luhn
});

test("pickWritable keeps whitelisted columns only and nulls empty strings", () => {
  const picked = pickWritable(CHILDREN["cabins"]!.columns, { cabin_num: " 8214 ", deck: "", id: "x", group_id: "y", hacked: 1 });
  assert.deepEqual(picked, { ok: true, row: { cabin_num: "8214", deck: null } });
});

test("pickWritable refuses a card number in any text or json field", () => {
  const a = pickWritable(CHILDREN["payments"]!.columns, { method_note: "Visa 4111111111111111" });
  assert.equal(a.ok, false);
  const b = pickWritable(GROUP_COLUMNS, { amenities: ["card 4111 1111 1111 1111"] });
  assert.equal(b.ok, false);
});

test("the dashboard can never write passport, token or consent fields", () => {
  const cols = CHILDREN["travelers"]!.columns;
  for (const banned of ["passport_enc", "passport_last4", "form_token_hash", "consent_signed_at", "consent_name", "consent_ip_hash"]) {
    assert.equal(cols.includes(banned), false, banned);
  }
  assert.equal(CHILDREN["travelers"]!.select.includes("passport_enc"), false);
  assert.equal(CHILDREN["travelers"]!.select.includes("form_token_hash"), false);
  assert.equal(CHILDREN["travelers"]!.select.includes("consent_ip_hash"), false);
});

function fixture(): GroupFile {
  return {
    group: {
      id: "g1", status: "booking", sail_date: "2027-03-01",
      deposit_due: "2026-10-20", names_due: "2026-12-01", final_payment_due: "2026-12-15", recall_date: null,
    },
    cabins: [
      { id: "c1", cabin_num: "8214", status: "booked", price_total: 2400, deposit_amount: 500 },
      { id: "c2", cabin_num: "8216", status: "held", price_total: null, deposit_amount: null },
      { id: "c3", cabin_num: "8218", status: "released", price_total: 2400, deposit_amount: 500 },
    ],
    travelers: [
      { id: "t1", cabin_id: "c1", form_sent_at: "2026-10-01", form_submitted_at: "2026-10-03", consent_signed_at: "2026-10-03" },
      { id: "t2", cabin_id: "c1", form_sent_at: "2026-10-01", form_submitted_at: null, consent_signed_at: null },
      { id: "t3", cabin_id: "c3", form_sent_at: "2026-10-01", form_submitted_at: null, consent_signed_at: null },
    ],
    documents: [
      { id: "d1", title: "Group contract", status: "filed", owner: "mark", due_date: "2026-09-01", cabin_id: null },
      { id: "d2", title: "Client terms", status: "sent", owner: "client", due_date: "2026-10-01", cabin_id: "c1" },
    ],
    payments: [
      { id: "p1", cabin_id: "c1", kind: "deposit", amount: 500, due_date: "2026-10-20", paid_at: "2026-10-02T00:00:00Z" },
      { id: "p2", cabin_id: "c1", kind: "final", amount: 1900, due_date: "2026-12-15", paid_at: null },
      { id: "p3", cabin_id: "c3", kind: "deposit", amount: 500, due_date: "2026-09-01", paid_at: null },
    ],
    checklist: [
      { id: "k1", audience: "mark", kind: "task", title: "Send invitation", due_date: "2026-10-05", done_at: null },
      { id: "k2", audience: "client", kind: "product", title: "Lanyard", due_date: null, done_at: null },
    ],
  };
}

test("summarize counts cabins, money and paperwork, ignoring released cabins", () => {
  const s = summarize(fixture(), "2026-10-10", 30);
  assert.deepEqual(s.cabins, { total: 3, held: 1, offered: 0, booked: 1, released: 1 });
  assert.deepEqual(s.travelers, { total: 4, formsIn: 1, signed: 1 });
  assert.deepEqual(s.payments, { dueTotal: 1900, paidTotal: 500, openCount: 1, overdueCount: 0 });
  assert.deepEqual(s.documents, { open: 1, overdue: 1 });
  assert.deepEqual(s.checklist, { open: 1, overdue: 1 });
  assert.equal(s.daysToSail, 142);
});

test("attention list is sorted soonest-first, flags overdue, and respects the horizon", () => {
  const s = summarize(fixture(), "2026-10-10", 30);
  const labels = s.attention.map((a) => a.label);
  assert.deepEqual(labels, [
    "Client terms (client)",          // 9 days overdue
    "Send invitation",                // 5 days overdue
    "Group deposit deadline",         // in 10 days
    "No emails sent yet on this group", // undated
  ]);
  assert.equal(s.attention[0]!.overdue, true);
  assert.equal(s.attention[2]!.overdue, false);
  // Final payment (66 days) and names due (52 days) are beyond 30 days; widen the horizon and they appear.
  const wide = summarize(fixture(), "2026-10-10", 90).attention.map((a) => a.label);
  assert.ok(wide.includes("Final payment — cabin 8214"));
  assert.ok(wide.includes("Names due to the cruise line"));
  assert.ok(wide.some((l) => /^3 of 4 traveler forms not returned/.test(l)));
});

test("payments with the same kind and due date collapse into one attention line", () => {
  const f = fixture();
  f.cabins.push({ id: "c4", cabin_num: "8220", status: "held" });
  f.payments.push({ id: "p4", cabin_id: "c2", kind: "final", amount: 100, due_date: "2026-12-15", paid_at: null });
  f.payments.push({ id: "p5", cabin_id: "c4", kind: "final", amount: 100, due_date: "2026-12-15", paid_at: null });
  const labels = summarize(f, "2026-10-10", 90).attention.map((a) => a.label);
  assert.ok(labels.includes("Final payment — 3 cabins"));
  assert.ok(!labels.includes("Final payment — cabin 8214"));
});

test("missingSchedule adds deposit + final once per live cabin and is repeat-safe", () => {
  const f = fixture();
  const rows = missingSchedule(f);
  // c1 already has both; c2 (held) needs both; c3 is released.
  assert.deepEqual(rows, [
    { group_id: "g1", cabin_id: "c2", kind: "deposit", amount: null, due_date: "2026-10-20" },
    { group_id: "g1", cabin_id: "c2", kind: "final", amount: null, due_date: "2026-12-15" },
  ]);
  f.payments.push(...rows.map((r, i) => ({ id: `n${i}`, paid_at: null, ...r })));
  assert.deepEqual(missingSchedule(f), []);
});

test("missingSchedule computes the final balance from price minus deposit", () => {
  const f = fixture();
  f.payments = [];
  const c1 = missingSchedule(f).filter((r) => r.cabin_id === "c1");
  assert.deepEqual(c1.map((r) => [r.kind, r.amount]), [["deposit", 500], ["final", 1900]]);
});

test("a block with no cabin rows yet still reads against the block size, deposits and forms", () => {
  const f = { group: { id: "g", status: "draft", sail_date: "2027-05-10", cabins_held: 16, deposit_per_person: 99, final_payment_due: "2027-02-24",
    terms: { allotment_reviews: [{ date: "2026-11-11", percent_retaken: 75 }] } },
    cabins: [], travelers: [], documents: [], payments: [], checklist: [], messages: [] } as any;
  const s = summarize(f, "2026-10-06", 3650);
  assert.equal(s.cabins.total, 16);
  assert.deepEqual(s.deposits, { total: 3168, paid: 0 });
  assert.equal(s.travelers.total, 32);
  const labels = s.attention.map((a) => a.label).join(" | ");
  assert.match(labels, /Deposits — 16 cabins, \$3,168 still to collect \(due at booking\)/);
  assert.match(labels, /32 of 32 traveler forms not returned|32 traveler forms/);
  assert.match(labels, /Group final payment deadline/);
  assert.match(labels, /Line reviews the block \(takes back 75% of unsold\)/);
  assert.match(labels, /No emails sent yet/);
});

test("a deposit due at booking (no date) still gets a payment row per cabin", () => {
  const rows = missingSchedule({ group: { id: "g", deposit_due: null, final_payment_due: null } as any,
    cabins: [{ id: "c1", status: "held", deposit_amount: 198, price_total: 1000 } as any], payments: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!["kind"], "deposit");
  assert.equal(rows[0]!["due_date"], null);
});
