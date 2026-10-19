import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_STATUSES, activeFilterCount, applyFilters, bigPicture, computeKpis, crossLabel, csvCell, defaultFilters, funnel, gridRows, hasFilterParams,
  isDefaultFilters, journeyBars, missable, moneyByWeek, nextDeadlines, paperworkMatrix, parseFilters, parseTab, removeCross, serializeFilters, shipKey, timeline,
  toCsv, toggleCross, toggleGroup, weekStart, type WGroup, type WPayment, type WorkspaceData,
} from "./group-workspace";

// Monday 19 October 2026.
const TODAY = "2026-10-19";

const group = (id: string, over: Partial<WGroup> = {}): WGroup => ({
  id, name: `Group ${id}`, status: "booking", lang: "en", cruiseLine: "Carnival", shipName: "Mardi Gras", sailDate: "2027-05-09", returnDate: "2027-05-16", daysToSail: 202,
  cabinsTotal: 4, cabinsHeld: 1, cabinsOffered: 1, cabinsBooked: 2, cabinsReleased: 0, travelersExpected: 8, travelersOnFile: 3, formsSent: 3, formsReturned: 2, fullySigned: 1,
  depositsTotal: 800, depositsPaid: 400, paymentsOpen: 2, paymentsPaid: 1, paymentsOverdue: 1, amountDue: 700, amountPaid: 400, amountOverdue: 400,
  interestsTotal: 2, interestsNew: 1, interestsConverted: 1, journeyQueued: 2, journeySent: 3, journeyFailed: 1,
  nextDeadlineLabel: null, nextDeadlineDate: null, nextDeadlineDaysOut: null, marketingApproved: true, needsAttention: false, attentionReasons: [], ...over,
});

const pay = (id: string, groupId: string, over: Partial<WPayment> = {}): WPayment => ({
  id, groupId, groupName: `Group ${groupId}`, cabinId: null, cabinNum: null, kind: "final", dueDate: "2026-11-02", amount: 100, paidAt: null, status: "due", daysOut: 14, ...over,
});

function data(): WorkspaceData {
  const g1 = group("a", { needsAttention: true });
  const g2 = group("b", { name: "Bravo", status: "marketing", cruiseLine: "Royal Caribbean", shipName: "Icon", sailDate: "2027-08-01", cabinsBooked: 0, cabinsTotal: 2, cabinsHeld: 2, cabinsOffered: 0, travelersExpected: 4, fullySigned: 0, journeyQueued: 0, journeyFailed: 0, journeySent: 0 });
  const g3 = group("c", { name: "Charlie", status: "sailed", sailDate: "2026-06-01" });
  const trav = (id: string, groupId: string, over: Record<string, any> = {}) => ({
    id, groupId, groupName: `Group ${groupId}`, cabinId: null, cabinNum: "8214", firstName: "A", lastName: id, name: `Trav ${id}`, email: "a•••@x.com", lang: "en", isLead: false,
    formSentAt: null, formSubmittedAt: null, formStatus: "not sent" as const, docsRequired: 2, docsSigned: 0, fullySigned: false, passportOnFile: false, ...over,
  });
  const pw = (travelerId: string, groupId: string, docKey: string, status: "signed" | "pending", lang = "en") => ({
    groupId, groupName: `Group ${groupId}`, travelerId, travelerName: `Trav ${travelerId}`, cabinNum: "8214", travelerLang: lang, docKey, docTitle: docKey, status, signedAt: status === "signed" ? "2026-10-03" : null,
  });
  return {
    generatedAt: "2026-10-19T15:00:00.000Z", today: TODAY,
    groups: [g1, g2, g3],
    cabins: [
      { id: "c1", groupId: "a", groupName: "Group a", cabinNum: "8214", category: "Balcony", categoryCode: "8C", status: "booked", bookingNumber: "X", priceTotal: 4000, depositAmount: 400, travelerCount: 2, travelers: "Trav t1, Trav t2" },
      { id: "c2", groupId: "a", groupName: "Group a", cabinNum: "8216", category: "Balcony", categoryCode: "8C", status: "held", bookingNumber: null, priceTotal: 4000, depositAmount: 400, travelerCount: 0, travelers: "" },
      { id: "c3", groupId: "b", groupName: "Bravo", cabinNum: null, category: null, categoryCode: null, status: "held", bookingNumber: null, priceTotal: null, depositAmount: null, travelerCount: 0, travelers: "" },
    ],
    travelers: [
      trav("t1", "a", { isLead: true, fullySigned: true, docsSigned: 2 }),
      trav("t2", "a", { lang: "es", docsSigned: 1 }),
      trav("t3", "b", { lang: "es", cabinNum: null }),
    ],
    payments: [
      pay("p1", "a", { kind: "deposit", status: "paid", paidAt: "2026-10-05", dueDate: "2026-10-29", daysOut: 10, amount: 400 }),
      pay("p2", "a", { kind: "deposit", status: "overdue", dueDate: "2026-10-10", daysOut: -9, amount: 400 }),
      pay("p3", "a", { kind: "final", status: "due", dueDate: "2026-11-02", daysOut: 14, amount: 300 }),
      pay("p4", "a", { kind: "final", status: "due", dueDate: "2027-02-16", daysOut: 120, amount: 3000 }),
      pay("p5", "b", { kind: "final", status: "paid", paidAt: "2026-10-01", dueDate: "2026-11-30", daysOut: 42, amount: 500 }),
      pay("p6", "b", { kind: "other", status: "no date", dueDate: null, daysOut: null, amount: 50 }),
    ],
    paperwork: [
      pw("t1", "a", "terms", "signed"), pw("t1", "a", "booking", "signed"),
      pw("t2", "a", "terms", "signed", "es"), pw("t2", "a", "waiver", "pending", "es"),
      pw("t3", "b", "terms", "pending", "es"),
    ],
    messages: [
      { id: "m1", groupId: "a", groupName: "Group a", travelerId: "t1", travelerName: "Trav t1", travelerLang: "en", kind: "t-120", status: "sent", scheduledFor: null, sentAt: "2026-10-07", createdAt: "2026-10-07", to: "a•••@x.com", journey: true },
      { id: "m2", groupId: "a", groupName: "Group a", travelerId: "t2", travelerName: "Trav t2", travelerLang: "es", kind: "t-120", status: "failed", scheduledFor: null, sentAt: null, createdAt: "2026-10-07", to: "b•••@x.com", journey: true },
      { id: "m3", groupId: "a", groupName: "Group a", travelerId: null, travelerName: null, travelerLang: null, kind: "change-notice", status: "sent", scheduledFor: null, sentAt: "2026-10-08", createdAt: "2026-10-08", to: null, journey: true },
    ],
    interests: [
      { id: "i1", groupId: "a", groupName: "Group a", createdAt: "2026-10-17", daysAgo: 2, status: "new", guests: 2, cabinType: null, lang: "en", name: "Jane S.", email: "j•••@x.com" },
      { id: "i2", groupId: "a", groupName: "Group a", createdAt: "2026-09-01", daysAgo: 48, status: "booked", guests: 4, cabinType: null, lang: "es", name: "Raul P.", email: "r•••@x.com" },
      { id: "i3", groupId: "b", groupName: "Bravo", createdAt: "2026-10-19", daysAgo: 0, status: "new", guests: 1, cabinType: null, lang: "en", name: "Kim L.", email: null },
    ],
    deadlines: [
      { groupId: "a", groupName: "Group a", kind: "deposit", label: "Group deposit deadline", date: "2026-10-29", daysOut: 10, done: false, state: null, detail: null },
      { groupId: "a", groupName: "Group a", kind: "final", label: "Group final payment deadline", date: "2027-02-16", daysOut: 120, done: false, state: null, detail: null },
      { groupId: "a", groupName: "Group a", kind: "names", label: "Names due to the cruise line", date: "2026-10-12", daysOut: -7, done: false, state: null, detail: null },
      { groupId: "a", groupName: "Group a", kind: "recall", label: "Unsold cabins go back to the line", date: "2026-12-01", daysOut: 43, done: true, state: null, detail: null },
      { groupId: "a", groupName: "Group a", kind: "journey", label: "Email: 90 days before", date: "2027-02-08", daysOut: 112, done: false, state: "planned", detail: "2 travelers" },
      { groupId: "a", groupName: "Group a", kind: "sail", label: "Sailing — Mardi Gras", date: "2027-05-09", daysOut: 202, done: false, state: null, detail: null },
      { groupId: "b", groupName: "Bravo", kind: "line", label: "Line reviews the block", date: "2026-11-15", daysOut: 27, done: false, state: null, detail: null },
    ],
    journey: [
      { groupId: "a", groupName: "Group a", kind: "t-120", label: "120 days before", date: "2027-01-09", planned: 0, due: 0, sent: 1, failed: 1, skipped: 1, blocked: 0 },
      { groupId: "a", groupName: "Group a", kind: "t-90", label: "90 days before", date: "2027-02-08", planned: 2, due: 0, sent: 0, failed: 0, skipped: 1, blocked: 0 },
      { groupId: "b", groupName: "Bravo", kind: "t-90", label: "90 days before", date: "2027-05-03", planned: 0, due: 1, sent: 0, failed: 0, skipped: 0, blocked: 1 },
      { groupId: "a", groupName: "Group a", kind: "payment-due", label: "Payment due", date: null, planned: 5, due: 0, sent: 0, failed: 0, skipped: 0, blocked: 0 },
    ],
    docs: [{ key: "terms", title: "Terms" }, { key: "waiver", title: "Waiver" }, { key: "booking", title: "Booking agreement" }],
    warnings: [],
  };
}

const slice = (f = defaultFilters()) => applyFilters(data(), f);

// ── URL state ──

test("filters at their default leave nothing in the address, and the address reads back to the same filters", () => {
  const f = defaultFilters();
  assert.equal(serializeFilters(f), "");
  assert.deepEqual(parseFilters(""), f);
  assert.equal(isDefaultFilters(f), true);
  assert.equal(hasFilterParams(""), false);
});

test("every slicer and cross-filter survives the trip through the address", () => {
  const f = { groups: ["a", "b"], status: ["booking", "sailed"], ships: ["Carnival · Mardi Gras"], from: "2027-01-01", to: "2027-12-31", lang: ["es"], attention: true, x: [{ dim: "pay" as const, value: "no date" }, { dim: "doc" as const, value: "01-terms" }] };
  const qs = serializeFilters(f, "payments");
  assert.deepEqual(parseFilters(qs), f);
  assert.equal(parseTab(qs), "payments");
  assert.equal(hasFilterParams(qs), true);
  assert.equal(new URLSearchParams(qs).getAll("g").length, 2, "one g= per group, so a name with a comma cannot break the list");
});

test("every status is written as status=all and reads back as no status limit", () => {
  const f = { ...defaultFilters(), status: [] };
  assert.equal(serializeFilters(f), "status=all");
  assert.deepEqual(parseFilters("status=all").status, []);
  assert.deepEqual(parseFilters("g=a").status, [...ACTIVE_STATUSES], "an address with no status keeps the default");
});

test("a hand-edited address cannot break the page: unknown statuses, dates, languages and cross-filters are ignored", () => {
  const f = parseFilters("status=booking&status=nonsense&from=tomorrow&to=2027-02-30x&lang=fr&lang=es&x=bogus:1&x=pay:&x=pay:overdue&attn=yes");
  assert.deepEqual(f.status, ["booking"]);
  assert.equal(f.from, "");
  assert.equal(f.to, "");
  assert.deepEqual(f.lang, ["es"]);
  assert.deepEqual(f.x, [{ dim: "pay", value: "overdue" }]);
  assert.equal(f.attention, false);
  assert.equal(parseTab("tab=hacked"), "groups");
  assert.equal(parseTab(""), "groups");
});

test("the number of slicers narrowing the data ignores the default status set", () => {
  assert.equal(activeFilterCount(defaultFilters()), 0);
  assert.equal(activeFilterCount({ ...defaultFilters(), status: ["sailed"], attention: true, groups: ["a"] }), 3);
  assert.equal(activeFilterCount({ ...defaultFilters(), from: "2027-01-01", to: "2027-02-01" }), 1, "the two dates are one slicer");
  assert.equal(isDefaultFilters({ ...defaultFilters(), x: [{ dim: "pay", value: "paid" }] }), false);
});

test("clicking a group selects it alone, clicking it again clears it, an additive click adds and removes", () => {
  const f0 = defaultFilters();
  const f1 = toggleGroup(f0, "a", false);
  assert.deepEqual(f1.groups, ["a"]);
  assert.deepEqual(toggleGroup(f1, "b", false).groups, ["b"]);
  assert.deepEqual(toggleGroup(f1, "b", true).groups, ["a", "b"]);
  assert.deepEqual(toggleGroup(toggleGroup(f1, "b", true), "a", true).groups, ["b"]);
  assert.deepEqual(toggleGroup(f1, "a", false).groups, []);
  assert.deepEqual(toggleGroup(toggleGroup(f1, "b", true), "a", false).groups, ["a"], "a plain click on one of several selects that one alone");
});

test("a cross-filter holds one value per kind; the same click again takes it off", () => {
  const f1 = toggleCross(defaultFilters(), { dim: "pay", value: "overdue" });
  assert.deepEqual(f1.x, [{ dim: "pay", value: "overdue" }]);
  assert.deepEqual(toggleCross(f1, { dim: "pay", value: "paid" }).x, [{ dim: "pay", value: "paid" }]);
  assert.deepEqual(toggleCross(f1, { dim: "pay", value: "overdue" }).x, []);
  assert.equal(toggleCross(f1, { dim: "cab", value: "booked" }).x.length, 2);
  assert.deepEqual(removeCross(toggleCross(f1, { dim: "cab", value: "booked" }), { dim: "pay", value: "overdue" }).x, [{ dim: "cab", value: "booked" }]);
});

// ── Slicers ──

test("by default only the active groups are in", () => {
  assert.deepEqual(slice().groups.map((g) => g.id), ["a", "b"]);
  assert.deepEqual(slice({ ...defaultFilters(), status: [] }).groups.map((g) => g.id), ["a", "b", "c"]);
});

test("each slicer narrows the groups, and everything under them", () => {
  const all = { ...defaultFilters(), status: [] };
  assert.deepEqual(slice({ ...all, groups: ["b"] }).groups.map((g) => g.id), ["b"]);
  assert.deepEqual(slice({ ...all, status: ["sailed"] }).groups.map((g) => g.id), ["c"]);
  assert.deepEqual(slice({ ...all, ships: ["Royal Caribbean · Icon"] }).groups.map((g) => g.id), ["b"]);
  assert.deepEqual(slice({ ...all, from: "2027-06-01" }).groups.map((g) => g.id), ["b"]);
  assert.deepEqual(slice({ ...all, to: "2026-12-31" }).groups.map((g) => g.id), ["c"]);
  assert.deepEqual(slice({ ...all, attention: true }).groups.map((g) => g.id), ["a"]);
  const s = slice({ ...all, groups: ["b"] });
  assert.ok(s.cabins.every((c) => c.groupId === "b") && s.payments.every((p) => p.groupId === "b") && s.deadlines.every((d) => d.groupId === "b") && s.journey.every((j) => j.groupId === "b"));
  assert.equal(s.travelers.length, 1);
});

test("a group with no sail date is left out when a date range is set", () => {
  const d = data();
  d.groups.push(group("d", { sailDate: null, status: "draft" }));
  assert.equal(applyFilters(d, { ...defaultFilters(), from: "2020-01-01" }).groups.some((g) => g.id === "d"), false);
  assert.equal(applyFilters(d, defaultFilters()).groups.some((g) => g.id === "d"), true);
});

test("the language slicer narrows travelers, paperwork, emails and leads, and leaves groups and payments whole", () => {
  const s = slice({ ...defaultFilters(), lang: ["es"] });
  assert.deepEqual(s.groups.map((g) => g.id), ["a", "b"]);
  assert.deepEqual(s.travelers.map((t) => t.id), ["t2", "t3"]);
  assert.deepEqual(s.paperwork.map((p) => p.travelerId), ["t2", "t2", "t3"]);
  assert.deepEqual(s.messages.map((m) => m.id), ["m2"], "a group-level notice has no language, so it is out");
  assert.deepEqual(s.interests.map((i) => i.id), ["i2"]);
  assert.equal(s.payments.length, 6);
  assert.equal(s.byLanguage, true);
  assert.deepEqual(s.docs.map((d) => d.key), ["terms", "waiver"], "a column nobody in the slice owes is dropped");
});

// ── Grids and cross-filters ──

test("a cross-filter narrows only its own grid", () => {
  const s = slice();
  const x = [{ dim: "pay" as const, value: "overdue" }];
  assert.deepEqual(gridRows("payments", s, x).map((p) => p.id), ["p2"]);
  assert.equal(gridRows("cabins", s, x).length, 3, "the cabins grid is untouched by a payments cross-filter");
  assert.deepEqual(gridRows("cabins", s, [{ dim: "cab", value: "booked" }]).map((c) => c.id), ["c1"]);
  assert.deepEqual(gridRows("travelers", s, [{ dim: "tf", value: "signed" }]).map((t) => t.id), ["t1"]);
  assert.deepEqual(gridRows("travelers", s, [{ dim: "tf", value: "unsigned" }]).map((t) => t.id), ["t2", "t3"]);
  assert.deepEqual(gridRows("paperwork", s, [{ dim: "doc", value: "terms" }, { dim: "pws", value: "pending" }]).map((p) => p.travelerId), ["t3"]);
  assert.deepEqual(gridRows("messages", s, [{ dim: "mk", value: "t-120" }, { dim: "ms", value: "failed" }]).map((m) => m.id), ["m2"]);
  assert.deepEqual(gridRows("interests", s, [{ dim: "ix", value: "booked" }]).map((i) => i.id), ["i2"]);
  assert.deepEqual(gridRows("deadlines", s, [{ dim: "dk", value: "journey" }]).map((d) => d.kind), ["journey"]);
  assert.equal(gridRows("groups", s, x).length, 2);
});

// ── Cards ──

test("cards: cabins, signed travelers, money and leads", () => {
  const k = computeKpis(slice());
  assert.deepEqual([k.cabinsBooked, k.cabinsHeld, k.cabinsOffered, k.cabinsBlock], [2, 3, 1, 6]);
  assert.deepEqual([k.signedPeople, k.signedOf, k.signedPct], [1, 12, 8], "1 of the 12 travelers the two files expect");
  assert.deepEqual([k.dueNext30, k.dueNext30Count], [300, 1], "only the payment due in 14 days; the one in 120 days and the paid one are not");
  assert.deepEqual([k.overdue, k.overdueCount], [400, 1]);
  assert.deepEqual([k.collected, k.collectedCount], [900, 2]);
  assert.equal(k.newInterests, 2, "the lead 48 days ago is not new this week");
  assert.deepEqual([k.journeyQueued, k.journeyFailed], [2, 1]);
});

test("a payment due exactly 30 days out counts, 31 does not; a payment with no amount counts as nothing", () => {
  const d = data();
  d.payments = [pay("x1", "a", { daysOut: 30, amount: 10 }), pay("x2", "a", { daysOut: 31, amount: 20 }), pay("x3", "a", { daysOut: 5, amount: null })];
  const k = computeKpis(applyFilters(d, defaultFilters()));
  assert.deepEqual([k.dueNext30, k.dueNext30Count], [10, 2]);
});

test("with the language slicer on, the share signed is of the named travelers", () => {
  const k = computeKpis(slice({ ...defaultFilters(), lang: ["es"] }));
  assert.deepEqual([k.signedPeople, k.signedOf, k.signedPct], [0, 2, 0]);
});

test("no travelers expected gives no percentage, not 0 or NaN", () => {
  const d = data();
  d.groups = [];
  const k = computeKpis(applyFilters(d, defaultFilters()));
  assert.equal(k.signedPct, null);
  assert.deepEqual([k.cabinsBooked, k.dueNext30, k.overdue, k.collected, k.newInterests], [0, 0, 0, 0, 0]);
});

// ── Funnel ──

test("funnel: five steps with their units, each pointing at the grid that holds its rows", () => {
  const f = funnel(slice());
  assert.deepEqual(f.map((s) => [s.label, s.value, s.unit]), [
    ["Interests", 3, "replies"], ["Cabins booked", 2, "cabins"], ["Travelers on file", 3, "people"], ["Paperwork complete", 1, "people"], ["Final payment paid", 1, "cabins"],
  ]);
  assert.deepEqual(f.map((s) => s.tab), ["interests", "cabins", "travelers", "travelers", "payments"]);
  assert.deepEqual(f[3]!.cross, { dim: "tf", value: "signed" });
});

// ── Money by week ──

test("weeks start on Monday", () => {
  assert.equal(weekStart("2026-10-19"), "2026-10-19");
  assert.equal(weekStart("2026-10-25"), "2026-10-19", "Sunday belongs to the week before");
  assert.equal(weekStart("2026-10-26"), "2026-10-26");
});

test("money by week: an Overdue bar, then 26 weeks of paid and still-due dollars", () => {
  const m = moneyByWeek(slice().payments, TODAY);
  assert.equal(m.buckets.length, 27);
  assert.deepEqual([m.buckets[0]!.key, m.buckets[0]!.label, m.buckets[0]!.overdue, m.buckets[0]!.overdueCount], ["overdue", "Overdue", 400, 1]);
  assert.deepEqual([m.buckets[1]!.label, m.buckets[1]!.weekOf], ["Oct 19", "2026-10-19"]);
  // p1: paid, due 29 Oct → week of 26 Oct (index 2 after the overdue bar)
  assert.deepEqual([m.buckets[2]!.paid, m.buckets[2]!.paidCount], [400, 1]);
  // p3: due 2 Nov → week of 2 Nov
  assert.deepEqual([m.buckets[3]!.due, m.buckets[3]!.dueCount], [300, 1]);
  // p5: paid, due 30 Nov → week of 30 Nov (6 weeks after 19 Oct)
  assert.deepEqual([m.buckets[7]!.paid, m.buckets[7]!.weekOf], [500, "2026-11-30"]);
  // p4: due 16 Feb 2027 is 17 weeks out
  assert.equal(m.buckets[1 + 17]!.due, 3000);
  assert.deepEqual([m.noDate, m.noDateCount], [50, 1]);
  assert.deepEqual([m.later, m.laterCount], [0, 0]);
});

test("money by week: a paid payment from before this week is left out, a payment beyond 26 weeks is counted as later", () => {
  const rows = [
    pay("p1", "a", { status: "paid", paidAt: "2026-09-01", dueDate: "2026-09-10", daysOut: -39, amount: 100 }),
    pay("p2", "a", { status: "due", dueDate: "2027-06-01", daysOut: 225, amount: 250 }),
    pay("p3", "a", { status: "paid", paidAt: "2026-10-01", dueDate: null, daysOut: null, amount: 70 }),
  ];
  const m = moneyByWeek(rows, TODAY);
  assert.equal(m.buckets.reduce((n, b) => n + b.paid + b.due + b.overdue, 0), 0);
  assert.deepEqual([m.later, m.laterCount], [250, 1]);
  assert.deepEqual([m.noDate, m.noDateCount], [0, 0], "a paid payment with no date is not an unpaid payment with no date");
});

test("money by week: a payment due today falls in this week, not in the Overdue bar", () => {
  const m = moneyByWeek([pay("p1", "a", { dueDate: TODAY, daysOut: 0, amount: 80 })], TODAY);
  assert.deepEqual([m.buckets[0]!.overdue, m.buckets[1]!.due], [0, 80]);
});

// ── Timeline ──

test("timeline: a row for each group with something dated, markers placed by days out, sorted into lanes", () => {
  const t = timeline(slice());
  assert.deepEqual(t.rows.map((r) => [r.groupName, r.y]), [["Group a", 0], ["Bravo", 1]]);
  const dep = t.points.find((p) => p.kind === "deposit")!;
  assert.deepEqual([dep.x, dep.y > 0, dep.groupId], [10, true, "a"]);
  const email = t.points.find((p) => p.kind === "journey")!;
  assert.equal(email.y < 0, true, "journey emails sit in their own lane");
  assert.equal(t.points.some((p) => p.kind === "sail"), false, "the sailing is 202 days out, beyond the 120-day window");
  assert.equal(t.points.find((p) => p.kind === "names")!.x, -7, "a deadline that just passed is still shown");
  assert.deepEqual([t.from, t.to], [-14, 120]);
});

test("timeline: no deadlines in the window gives no rows", () => {
  const d = data();
  d.deadlines = [];
  assert.deepEqual(timeline(applyFilters(d, defaultFilters())).rows, []);
});

// ── Journey ──

test("journey bars: planned (planned and due), sent, failed and skipped for the eight milestones", () => {
  const bars = journeyBars(slice());
  assert.deepEqual(bars.map((b) => b.label), ["Confirmation", "T-120", "T-90", "T-45", "T-20", "T-10", "T-5", "T-2"]);
  assert.deepEqual(bars.find((b) => b.kind === "t-120"), { kind: "t-120", label: "T-120", planned: 0, sent: 1, failed: 1, skipped: 1 });
  assert.deepEqual(bars.find((b) => b.kind === "t-90"), { kind: "t-90", label: "T-90", planned: 3, sent: 0, failed: 0, skipped: 1 });
  assert.equal(bars.some((b) => b.kind === "payment-due"), false);
});

// ── Matrix ──

test("paperwork matrix: travelers by documents, 'n/a' where a document is not theirs to sign", () => {
  const m = paperworkMatrix(slice());
  assert.deepEqual(m.columns.map((c) => c.key), ["terms", "waiver", "booking"]);
  assert.deepEqual(m.groups.map((g) => g.groupName), ["Group a", "Bravo"]);
  const [t1, t2] = m.groups[0]!.rows;
  assert.deepEqual(t1!.cells, { terms: "signed", waiver: "n/a", booking: "signed" });
  assert.deepEqual(t2!.cells, { terms: "signed", waiver: "pending", booking: "n/a" });
  assert.deepEqual([t2!.signed, t2!.required], [1, 2]);
  assert.equal(t1!.name, "Trav t1", "the lead of the cabin comes first");
});

// ── Big picture ──

test("next deadlines skip met ones, emails and the sailing, put a missed one first, and stop at five", () => {
  const n = nextDeadlines(slice());
  assert.deepEqual(n.map((d) => [d.groupName, d.daysOut]), [["Group a", -7], ["Group a", 10], ["Bravo", 27], ["Group a", 120]]);
  const past = data();
  past.deadlines.push({ groupId: "b", groupName: "Bravo", kind: "recall", label: "Cabins go back", date: "2026-10-12", daysOut: -7, done: false, state: null, detail: null });
  assert.equal(nextDeadlines(applyFilters(past, defaultFilters())).some((d) => d.label === "Cabins go back"), false, "a passed recall date is history, not a missed deadline");
  assert.equal(missable("deposit") && missable("final") && missable("names"), true);
  assert.equal(missable("recall") || missable("line") || missable("journey") || missable("sail"), false);
  const d = data();
  for (let i = 0; i < 8; i++) d.deadlines.push({ groupId: "b", groupName: "Bravo", kind: "line", label: `L${i}`, date: "2026-12-01", daysOut: 50 + i, done: false, state: null, detail: null });
  assert.equal(nextDeadlines(applyFilters(d, defaultFilters())).length, 5);
});

test("the big picture is the active groups only", () => {
  const b = bigPicture(data());
  assert.equal(b.activeGroups, 2);
  assert.equal(b.needAttention, 1);
  assert.equal(b.kpis.cabinsBooked, 2);
});

// ── Labels and export ──

test("chips read in plain words", () => {
  assert.equal(crossLabel({ dim: "pay", value: "overdue" }), "Payments: overdue");
  assert.equal(crossLabel({ dim: "pay", value: "due" }), "Payments: still to come");
  assert.equal(crossLabel({ dim: "doc", value: "terms" }, [{ key: "terms", title: "Terms" }]), "Paperwork: Terms");
  assert.equal(crossLabel({ dim: "mk", value: "t-120" }), "Emails: T-120");
  assert.equal(crossLabel({ dim: "dk", value: "journey" }), "Deadlines: Journey email");
  assert.equal(crossLabel({ dim: "tf", value: "signed" }), "Travelers: fully signed");
  assert.equal(shipKey({ cruiseLine: null, shipName: null }), "Ship not set");
});

test("a CSV cell is quoted when it has a comma, a quote or a line break, and a formula is made text", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
  assert.equal(csvCell("=HYPERLINK(\"x\")"), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell("+1 555"), "'+1 555");
  assert.equal(csvCell("@here"), "'@here");
  assert.equal(csvCell(-9), "-9", "a negative number is a number");
  assert.equal(csvCell(true), "yes");
  assert.equal(csvCell(false), "no");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell("m•••@gmail.com"), "m•••@gmail.com");
});

test("a CSV is a header row and a row per record, with Windows line endings", () => {
  assert.equal(toCsv(["A", "B"], [[1, "x,y"], [null, true]]), 'A,B\r\n1,"x,y"\r\n,yes\r\n');
  assert.equal(toCsv(["A"], []), "A\r\n");
});
