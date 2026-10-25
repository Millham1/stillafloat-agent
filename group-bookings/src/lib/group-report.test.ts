import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFilters, defaultFilters, type WGroup, type WorkspaceData } from "./group-workspace";
import {
  PAGES, cabinDetail, cabinKpis, cabinStatusCounts, deadlineKpis, docStatusCounts, groupDetail, journeyKpis, leadDetail, leadKpis, moneyKpis,
  paperworkKpis, parseDrill, parsePage, paymentDetail, reportQuery, travelerDetail, waitingLongest,
} from "./group-report";

// Mark 2026-10-25: the workspace as one-screen report pages, with a click opening the item's own page.

const TODAY = "2026-10-25";
const group = (id: string, over: Partial<WGroup> = {}): WGroup => ({
  id, name: `Group ${id}`, status: "marketing", lang: "en", cruiseLine: "MSC Cruises", shipName: "MSC Seashore", sailDate: "2027-05-09", returnDate: "2027-05-13", daysToSail: 196,
  cabinsTotal: 12, cabinsHeld: 10, cabinsOffered: 0, cabinsBooked: 2, cabinsReleased: 0, travelersExpected: 6, travelersOnFile: 3, formsSent: 2, formsReturned: 1, fullySigned: 1,
  depositsTotal: 0, depositsPaid: 0, paymentsOpen: 2, paymentsPaid: 1, paymentsOverdue: 1, amountDue: 100, amountPaid: 50, amountOverdue: 25,
  interestsTotal: 2, interestsNew: 1, interestsConverted: 0, journeyQueued: 1, journeySent: 2, journeyFailed: 1,
  nextDeadlineLabel: null, nextDeadlineDate: null, nextDeadlineDaysOut: null, marketingApproved: true, needsAttention: false, attentionReasons: [], ...over,
});
const trav = (id: string, over: Record<string, unknown> = {}) => ({
  id, groupId: "a", groupName: "Group a", cabinId: "c1", cabinNum: "8214", firstName: id, lastName: "X", name: `Trav ${id}`, email: "x•••@x.com", lang: "en", isLead: false,
  formSentAt: null as string | null, formSubmittedAt: null as string | null, formStatus: "not sent" as const, docsRequired: 2, docsSigned: 0, fullySigned: false, passportOnFile: false,
  formOpenedAt: null as string | null, consentAt: null as string | null, copiesSentAt: null as string | null, ...over,
});
const pw = (travelerId: string, docKey: string, status: "signed" | "pending", sealed = false) => ({
  groupId: "a", groupName: "Group a", travelerId, travelerName: `Trav ${travelerId}`, cabinNum: "8214", travelerLang: "en", docKey, docTitle: docKey, status,
  signedAt: status === "signed" ? "2026-10-20" : null, signatureId: status === "signed" ? `s-${travelerId}-${docKey}` : null, hasCopy: status === "signed", sealed,
});

function data(): WorkspaceData {
  return {
    generatedAt: `${TODAY}T12:00:00Z`, today: TODAY,
    groups: [group("a")],
    cabins: [
      { id: "c1", groupId: "a", groupName: "Group a", cabinNum: "8214", category: "Balcony", categoryCode: "BB", status: "booked", bookingNumber: "B1", priceTotal: 1073.58, depositAmount: 100, travelerCount: 2, travelers: "Trav t1, Trav t2" },
      { id: "c2", groupId: "a", groupName: "Group a", cabinNum: null, category: "Balcony", categoryCode: "BB", status: "held", bookingNumber: null, priceTotal: 1073.58, depositAmount: 100, travelerCount: 0, travelers: "" },
      { id: "c3", groupId: "a", groupName: "Group a", cabinNum: null, category: "Aurea", categoryCode: "BA", status: "released", bookingNumber: null, priceTotal: 1373.58, depositAmount: 100, travelerCount: 0, travelers: "" },
    ],
    travelers: [
      trav("t1", { formSentAt: "2026-10-15T09:00:00Z", formOpenedAt: "2026-10-15T10:00:00Z", formStatus: "returned", formSubmittedAt: "2026-10-16T00:00:00Z", docsSigned: 2, fullySigned: true }),
      trav("t2", { formSentAt: "2026-10-16T09:00:00Z", formStatus: "sent", docsSigned: 1 }),
      trav("t3", { cabinId: null, cabinNum: null, formSentAt: "2026-10-23T09:00:00Z", formStatus: "sent" }),
      trav("t4", { cabinId: null, cabinNum: null }),
    ],
    payments: [
      { id: "p1", groupId: "a", groupName: "Group a", cabinId: "c1", cabinNum: "8214", kind: "deposit", dueDate: null, amount: 100, paidAt: "2026-10-10", status: "paid", daysOut: null },
      { id: "p2", groupId: "a", groupName: "Group a", cabinId: "c1", cabinNum: "8214", kind: "final", dueDate: "2026-11-10", amount: 973.58, paidAt: null, status: "due", daysOut: 16 },
      { id: "p3", groupId: "a", groupName: "Group a", cabinId: "c2", cabinNum: null, kind: "deposit", dueDate: null, amount: 100, paidAt: null, status: "no date", daysOut: null },
    ],
    paperwork: [pw("t1", "terms", "signed", true), pw("t1", "waiver", "signed"), pw("t2", "terms", "signed", true), pw("t2", "waiver", "pending"), pw("t3", "terms", "pending"), pw("t3", "waiver", "pending"), pw("t4", "terms", "pending"), pw("t4", "waiver", "pending")],
    messages: [
      { id: "m1", groupId: "a", groupName: "Group a", travelerId: "t1", travelerName: "Trav t1", travelerLang: "en", kind: "t-120", status: "sent", scheduledFor: null, sentAt: "2026-10-07", createdAt: "2026-10-07", to: null, journey: true },
      { id: "m2", groupId: "a", groupName: "Group a", travelerId: "t2", travelerName: "Trav t2", travelerLang: "en", kind: "t-120", status: "failed", scheduledFor: null, sentAt: null, createdAt: "2026-10-07", to: null, journey: true },
      { id: "m3", groupId: "a", groupName: "Group a", travelerId: null, travelerName: null, travelerLang: null, kind: "paperwork-link", status: "sent", scheduledFor: null, sentAt: "2026-10-08", createdAt: "2026-10-08", to: null, journey: false },
    ],
    interests: [
      { id: "i1", groupId: "a", groupName: "Group a", createdAt: "2026-10-24", daysAgo: 1, status: "new", guests: 2, cabinType: "Balcony", lang: "en", name: "Ann L.", email: "a•••@x.com" },
      { id: "i2", groupId: "a", groupName: "Group a", createdAt: "2026-10-01", daysAgo: 24, status: "contacted", guests: 4, cabinType: null, lang: "es", name: "Rosa M.", email: null },
    ],
    deadlines: [
      { groupId: "a", groupName: "Group a", kind: "recall", label: "Cabins go back", date: "2026-12-01", daysOut: 37, done: false, state: null, detail: null },
      { groupId: "a", groupName: "Group a", kind: "final", label: "Final payment", date: "2026-11-10", daysOut: 16, done: false, state: null, detail: null },
      { groupId: "a", groupName: "Group a", kind: "deposit", label: "Deposit", date: "2026-10-20", daysOut: -5, done: false, state: null, detail: null },
      { groupId: "a", groupName: "Group a", kind: "names", label: "Names", date: "2026-10-01", daysOut: -24, done: true, state: null, detail: null },
    ],
    journey: [{ groupId: "a", groupName: "Group a", kind: "t-90", label: "90 days", date: "2027-02-08", planned: 3, due: 0, sent: 0, failed: 0, skipped: 0, blocked: 0 }],
    docs: [{ key: "terms", title: "Terms" }, { key: "waiver", title: "Waiver" }],
    warnings: [],
  };
}
const slice = () => applyFilters(data(), defaultFilters());

test("the address names the page and the drill; old ?tab= links land on the matching page; anything else is the overview with no drill", () => {
  assert.equal(parsePage(""), "overview");
  for (const p of PAGES) assert.equal(parsePage(`page=${p}`), p);
  assert.equal(parsePage("tab=payments"), "money");
  assert.equal(parsePage("tab=travelers"), "paperwork");
  assert.equal(parsePage("tab=interests"), "leads");
  assert.equal(parsePage("page=nonsense"), "overview");
  assert.deepEqual(parseDrill("d=traveler%3Adab0381e-f2f0-42db-b1a6-fb2c521dc717"), { kind: "traveler", id: "dab0381e-f2f0-42db-b1a6-fb2c521dc717" });
  assert.equal(parseDrill("d=traveler:"), null);
  assert.equal(parseDrill("d=secret:abc"), null);
  assert.equal(parseDrill("d=traveler:a%2F..%2Fb"), null, "only an id: no slashes or dots");
  const f = { ...defaultFilters(), groups: ["g1"] };
  const q = reportQuery(f, "paperwork", { kind: "traveler", id: "t1" });
  assert.equal(parsePage(q), "paperwork");
  assert.deepEqual(parseDrill(q), { kind: "traveler", id: "t1" });
  assert.match(q, /(^|&)g=g1(&|$)/);
  assert.equal(reportQuery(defaultFilters(), "overview"), "", "the overview with no filters leaves no trace");
});

test("the Paperwork page's numbers: on file of expected, fully signed, sent but never opened (and the oldest), sealed copies", () => {
  assert.deepEqual(paperworkKpis(slice()), { onFile: 4, expected: 6, fullySigned: 1, sentNotOpened: 2, oldestUnopenedDays: 9, signedDocs: 3, sealedDocs: 2 });
});

test("documents by status: signed, pending once a link went out, not sent before it did", () => {
  assert.deepEqual(docStatusCounts(slice()), { signed: 3, pending: 3, notSent: 2 });
});

test("waiting the longest: travelers with a link who have not finished, longest first; the finished and the never-sent are not waiting", () => {
  assert.deepEqual(waitingLongest(slice()).map((w) => [w.travelerId, w.days, `${w.signed} of ${w.required}`]), [["t2", 9, "1 of 2"], ["t3", 2, "0 of 2"]]);
  assert.equal(waitingLongest(slice(), 1).length, 1);
});

test("cabins, money, deadlines, journey and leads pages count what they say", () => {
  const s = slice();
  assert.deepEqual(cabinStatusCounts(s), [{ status: "booked", count: 1 }, { status: "held", count: 1 }, { status: "released", count: 1 }]);
  assert.deepEqual(cabinKpis(s), { booked: 1, held: 1, offered: 0, released: 1, bookedValue: 1073.58 });
  const m = moneyKpis(s);
  assert.deepEqual([m.collected, m.collectedCount, m.due30, m.due30Count, m.noDate, m.noDateCount], [100, 1, 973.58, 1, 100, 1]);
  assert.deepEqual(deadlineKpis(s), { next30: 1, missed: 1, met: 1, nextLabel: "Final payment · Group a", nextDate: "2026-11-10" });
  assert.deepEqual(journeyKpis(s), { sent: 1, failed: 1, queued: 0, planned: 3 }, "the paperwork-link email is not a journey email");
  const l = leadKpis(s);
  assert.equal(l.newThisWeek, 1); assert.equal(l.total, 2);
  assert.deepEqual(l.byStatus.filter((x) => x.count), [{ status: "new", count: 1 }, { status: "contacted", count: 1 }]);
});

test("a drill-through page gathers one item from ALL the data, so a slicer never hides the page that was opened", () => {
  const d = data();
  const t = travelerDetail(d, "t2")!;
  assert.equal(t.t.id, "t2"); assert.equal(t.group!.id, "a"); assert.equal(t.cabin!.id, "c1");
  assert.deepEqual(t.mates.map((x) => x.id), ["t1"], "the other people in the cabin");
  assert.deepEqual(t.docs.map((x) => `${x.docKey}:${x.status}`), ["terms:signed", "waiver:pending"]);
  assert.deepEqual(t.messages.map((x) => x.id), ["m2"]);
  assert.deepEqual(t.payments.map((x) => x.id), ["p1", "p2"], "the cabin's payments");
  assert.deepEqual(travelerDetail(d, "t4")!.mates, [], "no cabin, no cabin mates");
  assert.equal(travelerDetail(d, "nope"), null);

  const g = groupDetail(d, "a")!;
  assert.deepEqual([g.cabins.length, g.travelers.length, g.payments.length, g.interests.length], [3, 4, 3, 2]);
  assert.deepEqual(g.deadlines.map((x) => x.label), ["Deposit", "Final payment", "Cabins go back"], "open deadlines only, soonest first (a missed one first)");
  assert.equal(groupDetail(d, "zzz"), null);

  const c = cabinDetail(d, "c1")!;
  assert.deepEqual([c.travelers.map((x) => x.id), c.payments.map((x) => x.id)], [["t1", "t2"], ["p1", "p2"]]);
  assert.equal(paymentDetail(d, "p3")!.cabin!.id, "c2");
  assert.equal(paymentDetail(d, "p1")!.group!.name, "Group a");
  assert.equal(leadDetail(d, "i2")!.i.name, "Rosa M.");
  assert.equal(leadDetail(d, "i9"), null);

  // a slicer that hides the group does not hide the drill page
  const hidden = applyFilters(d, { ...defaultFilters(), groups: ["other"] });
  assert.equal(hidden.travelers.length, 0);
  assert.ok(travelerDetail(d, "t2"));
});
