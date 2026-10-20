import { test } from "node:test";
import assert from "node:assert/strict";
import { CHILDREN, GROUP_COLUMNS, groupDateProblem, looksLikeCardNumber, missingSchedule, pickWritable, publicGroupRow, slugify, summarize, withGroupDeposit, withTravelUnit, PRICE_UNITS, type GroupFile } from "./group-file";

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

test("the final payment and the last review date are not listed twice", () => {
  const f = { group: { id: "g", status: "draft", sail_date: "2027-05-10", cabins_held: 1, final_payment_due: "2027-02-24", recall_date: "2027-01-10",
    terms: { allotment_reviews: [{ date: "2027-01-10", percent_retaken: 100 }] } },
    cabins: [{ id: "c1", status: "held" }], travelers: [], documents: [], checklist: [], messages: [],
    payments: [{ id: "p", cabin_id: "c1", kind: "final", amount: 100, due_date: "2027-02-24", paid_at: null }] } as any;
  const labels = summarize(f, "2026-10-06", 3650).attention.map((a) => a.label);
  assert.equal(labels.filter((l) => /final payment/i.test(l)).length, 1);
  assert.equal(labels.filter((l) => /review|go back/i.test(l)).length, 1);
});

test("the traveler rows the API reads carry what the form collected, never a secret, and the dashboard cannot write the form's fields", () => {
  const read = CHILDREN["travelers"]!.select.split(",").map((c) => c.trim());
  for (const secret of ["passport_enc", "form_token_hash", "consent_ip_hash", "prospect_id"]) assert.ok(!read.includes(secret), `${secret} must never be selected`);
  assert.ok(read.includes("form_data") && read.includes("newsletter_opt_in") && read.includes("passport_last4"));
  const writable = CHILDREN["travelers"]!.columns;
  for (const owned of ["form_data", "newsletter_opt_in", "prospect_id", "passport_enc", "passport_last4", "passport_country", "passport_expiry", "form_token_hash", "form_sent_at", "form_submitted_at", "consent_name", "consent_signed_at", "consent_ip_hash"]) {
    assert.ok(!writable.includes(owned), `${owned} is written only by the traveler's own form`);
  }
});

test("fees are Mark's own entry on the group file; the organizer's link hash never leaves the server", () => {
  assert.ok(GROUP_COLUMNS.includes("fees"));
  assert.equal(pickWritable(GROUP_COLUMNS, { fees: { planning_fee: 150 }, organizer_token_hash: "x", organizer_link_sent_at: "x", terms: {} }).ok && true, true);
  const picked = pickWritable(GROUP_COLUMNS, { fees: { planning_fee: 150 }, organizer_token_hash: "x", organizer_link_sent_at: "2026-10-16", terms: { a: 1 } });
  assert.deepEqual(picked, { ok: true, row: { fees: { planning_fee: 150 } } });
  assert.deepEqual(publicGroupRow({ id: "g", name: "n", organizer_token_hash: "secret", organizer_link_sent_at: "2026-10-16" }), { id: "g", name: "n", organizer_link_sent_at: "2026-10-16" });
  assert.equal(pickWritable(GROUP_COLUMNS, { fees: { note: "pay 4111 1111 1111 1111" } }).ok, false, "the card guard covers the fees too");
});

test("withGroupDeposit: a cabin with no deposit takes the group's deposit per person x 2, so every cabin gets a deposit row (Mark's Millham F/F 2027 quote, 2026-10-19)", () => {
  // 12 cabins opened from a quote that printed no deposit; $50 a person typed on the confirmation form.
  const opened = Array.from({ length: 12 }, () => ({ category: "Balcony Bella", price_total: 1073.58, deposit_amount: null as number | null, status: "held" }));
  const filled = withGroupDeposit(opened, 50);
  assert.ok(filled.every((c) => c.deposit_amount === 100));
  assert.equal(opened[0]!.deposit_amount, null, "the input rows are not changed");
  // The numeric column may come back from the database as text.
  assert.equal(withGroupDeposit([{ deposit_amount: null }], "49.50")[0]!.deposit_amount, 99);
  // A cabin with its own deposit keeps it; one with none beside it is filled.
  assert.deepEqual(withGroupDeposit([{ deposit_amount: 136 }, { deposit_amount: null }, {}], 50).map((c) => c.deposit_amount), [136, 100, 100]);
  // No deposit per person on the group: nothing is made up.
  for (const none of [null, undefined, "", 0, "x"]) assert.deepEqual(withGroupDeposit([{ deposit_amount: null }], none), [{ deposit_amount: null }]);

  // And the schedule that follows has a deposit row per cabin, due "at booking" (no date) when the group has no deposit date.
  const cabins = filled.map((c, i) => ({ ...c, id: `c${i}` }));
  const atBooking = missingSchedule({ group: { id: "g", deposit_due: null, final_payment_due: "2027-03-01" } as any, cabins, payments: [] });
  assert.equal(atBooking.filter((r) => r["kind"] === "deposit").length, 12);
  assert.ok(atBooking.filter((r) => r["kind"] === "deposit").every((r) => r["amount"] === 100 && r["due_date"] === null));
  const finals = atBooking.filter((r) => r["kind"] === "final");
  assert.equal(finals.length, 12);
  assert.ok(finals.every((r) => r["amount"] === 973.58), "final = cabin total less the deposit");
  const dated = missingSchedule({ group: { id: "g", deposit_due: "2026-12-01", final_payment_due: null } as any, cabins, payments: [] });
  assert.ok(dated.length === 12 && dated.every((r) => r["kind"] === "deposit" && r["due_date"] === "2026-12-01"));
  // Without the fill (the old behaviour) a quote with no deposit and no deposit date made no deposit rows at all.
  assert.equal(missingSchedule({ group: { id: "g", deposit_due: null, final_payment_due: "2027-03-01" } as any, cabins: opened.map((c, i) => ({ ...c, id: `o${i}` })), payments: [] }).filter((r) => r["kind"] === "deposit").length, 0);
});

// ── Group dates come before the sailing (Mark 2026-10-19) ─────────────────────

test("a date after the sailing is refused in plain words, naming the field and the sail date", () => {
  // Mark's file: unsold cabins go back Dec 1, 2027 for a sailing on May 9, 2027.
  assert.deepEqual(groupDateProblem({ sail_date: "2027-05-09", recall_date: "2027-12-01" }), {
    field: "recall_date",
    error: "Unsold cabins go back must be on or before the sailing, May 9, 2027",
  });
  assert.deepEqual(groupDateProblem({ sail_date: "2027-05-09", deposit_due: "2027-05-10" }), {
    field: "deposit_due",
    error: "Deposit deadline must be on or before the sailing, May 9, 2027",
  });
  assert.equal(groupDateProblem({ sail_date: "2027-05-09", names_due: "2027-06-01" })?.error, "Names due to the line must be on or before the sailing, May 9, 2027");
  assert.equal(groupDateProblem({ sail_date: "2027-05-09", final_payment_due: "2028-01-01" })?.error, "Final payment deadline must be on or before the sailing, May 9, 2027");
});

test("a date on the sailing day or earlier, a blank date, or no sail date passes", () => {
  assert.equal(groupDateProblem({ sail_date: "2027-05-09", recall_date: "2027-05-09", final_payment_due: "2027-03-10", deposit_due: null, names_due: "" }), null);
  assert.equal(groupDateProblem({ recall_date: "2027-12-01" }), null, "no sail date on the file: nothing to compare with");
  assert.equal(groupDateProblem({ sail_date: "not a date", recall_date: "2027-12-01" }), null);
  assert.equal(groupDateProblem({ sail_date: "2027-05-09", recall_date: "soon" }), null);
  assert.equal(groupDateProblem({ sail_date: "2027-05-09T00:00:00Z", recall_date: "2027-05-09T12:00:00Z" }), null, "only the day counts");
});

test("a change to part of a saved group is checked against the sail date already on the file", () => {
  const saved = { sail_date: "2027-05-09", deposit_due: "2026-12-01", names_due: "2027-02-01", final_payment_due: "2027-03-10", recall_date: "2027-01-15" };
  assert.equal(groupDateProblem({ recall_date: "2027-12-01" }, saved)?.error, "Unsold cabins go back must be on or before the sailing, May 9, 2027");
  assert.equal(groupDateProblem({ recall_date: "2027-02-01" }, saved), null);
  assert.equal(groupDateProblem({ recall_date: null }, saved), null);
  assert.equal(groupDateProblem({ names_due: "2027-05-09" }, saved), null);
});

test("moving the sail date earlier than a date on the file is refused; moving it later, or leaving it alone, is not", () => {
  const saved = { sail_date: "2027-05-09", deposit_due: "2026-12-01", names_due: "2027-02-01", final_payment_due: "2027-03-10", recall_date: "2027-04-01" };
  assert.deepEqual(groupDateProblem({ sail_date: "2027-03-20" }, saved), {
    field: "recall_date",
    error: "Unsold cabins go back must be on or before the sailing, March 20, 2027",
  });
  assert.equal(groupDateProblem({ sail_date: "2027-01-01" }, saved)?.field, "names_due", "the first date on the file that is now too late");
  assert.equal(groupDateProblem({ sail_date: "2027-06-01" }, saved), null);
  assert.equal(groupDateProblem({ sail_date: "2027-05-09" }, saved), null);
  assert.equal(groupDateProblem({ sail_date: null }, saved), null);
  // Changed together: the new dates are what count.
  assert.equal(groupDateProblem({ sail_date: "2027-03-05", recall_date: "2027-03-01" }, saved)?.field, "final_payment_due");
});

test("a file that already holds a wrong date can still have its other fields edited, and the wrong date fixed", () => {
  const bad = { sail_date: "2027-05-09", recall_date: "2027-12-01" };
  assert.equal(groupDateProblem({ notes: "x" }, bad), null);
  assert.equal(groupDateProblem({ names_due: "2027-02-01" }, bad), null, "only what is being written is checked");
  assert.equal(groupDateProblem({ sail_date: "2027-05-09", recall_date: "2027-04-01" }, bad), null, "same sail date re-saved while the fix goes in");
  assert.equal(groupDateProblem({ recall_date: "2027-04-01" }, bad), null);
});


test("a travel price says what it is per: price_unit is writable, a hotel defaults to per room, an unknown unit is refused (Mark 2026-10-20: hotel prices are per room)", () => {
  const cols = CHILDREN["travel"]!.columns;
  assert.ok(cols.includes("price_unit"), "the dashboard's travel editor can set the unit");
  assert.deepEqual([...PRICE_UNITS], ["person", "room"]);
  const picked = pickWritable(cols, { kind: "hotel", price_per_person: 125, price_unit: "room", provider: "Marriott Courtyard", hacked: 1 });
  assert.ok(picked.ok && picked.row["price_unit"] === "room" && !("hacked" in picked.row));
  // a row saved as a hotel with no unit of its own is per room; a flight or a transfer is left to the column's default (person)
  assert.deepEqual(withTravelUnit("travel", { kind: "hotel", from_place: "Miami" }), { ok: true, row: { kind: "hotel", from_place: "Miami", price_unit: "room" } });
  assert.deepEqual(withTravelUnit("travel", { kind: "flight" }), { ok: true, row: { kind: "flight" } });
  assert.deepEqual(withTravelUnit("travel", { price_per_person: 99 }), { ok: true, row: { price_per_person: 99 } }, "a price edit alone does not touch the unit");
  // Mark's own choice wins, even for a hotel
  assert.deepEqual(withTravelUnit("travel", { kind: "hotel", price_unit: "person" }), { ok: true, row: { kind: "hotel", price_unit: "person" } });
  assert.deepEqual(withTravelUnit("travel", { price_unit: "room" }), { ok: true, row: { price_unit: "room" } });
  // anything that is not a unit is refused by name instead of reaching the database's check constraint
  const bad = withTravelUnit("travel", { kind: "hotel", price_unit: "night" });
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /person or room/);
  assert.equal(withTravelUnit("travel", { price_unit: null }).ok, false, "the column is never empty");
  // other sections are never touched
  assert.deepEqual(withTravelUnit("cabins", { kind: "hotel" }), { ok: true, row: { kind: "hotel" } });
});
