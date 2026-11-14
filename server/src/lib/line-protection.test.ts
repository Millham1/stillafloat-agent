// line-protection.test.ts — a cruise line's own plan: its coverages are pulled from its insurer's plan-document page and read out of the document.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { lineSource, pullLinePlanCoverage, scheduleFromPolicyText, stateOf } from "./line-protection";

// the Schedule of Benefits exactly as the server's PDF reader renders page 3 of MSC's policy document GR452 (read 2026-11-13)
const POLICY = "Policy Number:   Product Name:   Product Code:\nSample   MSC Cruises   GR452\nThis Policy provides travel insurance benefits\n\n--- page break ---\n\nSCHEDULE OF BENEFITS\nCoverage   Benefits Limit\nPer Person   Per Plan\nTrip Cancellation   100% of Trip Cost   100% of Trip Cost\nTravel Delay   $600.00   $6,000.00\nDaily Limit   $200.00   $2,000.00\nTrip Interruption   100% of Trip Cost   100% of Trip Cost\nEmergency Assistance & Transportation   $75,000.00   $500,000.00\nEmergency Companion Hospitality Expenses   $10,000.00   $10,000.00\nMedical and Dental   $75,000.00   $250,000.00\nEmergency Dental Expense Limit   $500.00   $5,000.00\nAccidental Death and Dismemberment - Air Flight Accident   $25,000.00   $250,000.00\nBaggage   $1,000.00   $10,000.00\nBaggage Delay   $100.00   $1,000.00\nFORMS AND ENDORSEMENTS\nThe coverages provided to you";

test("the Schedule of Benefits is read as the document prints it: the per-person figure, the per-plan figure under it, a Limit line under its benefit", () => {
  const s = scheduleFromPolicyText(POLICY);
  assert.equal(s.length, 9);
  assert.deepEqual(s[0], { name: "Trip Cancellation", coverage: "100% of Trip Cost", limits: [] });
  assert.deepEqual(s[1], { name: "Travel Delay", coverage: "$600.00", limits: [{ name: "Daily Limit", value: "$200.00" }, { name: "Per plan", value: "$6,000.00" }] });
  assert.deepEqual(s.find((b) => b.name === "Medical and Dental"), { name: "Medical and Dental", coverage: "$75,000.00", limits: [{ name: "Emergency Dental Expense Limit", value: "$500.00" }, { name: "Per plan", value: "$250,000.00" }] });
  assert.deepEqual(s[8], { name: "Baggage Delay", coverage: "$100.00", limits: [{ name: "Per plan", value: "$1,000.00" }] });
  assert.deepEqual(scheduleFromPolicyText("no schedule here"), []);
});

test("Mark 2026-11-13: the cruise line's plan document is pulled from its insurer's page for the lead's state, and nothing is made up when it cannot be", async () => {
  const calls: string[] = [];
  const pdf = new Uint8Array([...Buffer.from("%PDF-1.7 "), ...new Uint8Array(2000)]);
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}${init?.body ? ` ${String(init.body)}` : ""}`);
    if (url.includes("certpolicy.do")) return new Response("<form>", { status: 200, headers: { "set-cookie": "JSESSIONID=abc; Path=/" } });
    if (url.includes("certpolicyglobalsubmit")) return new Response(`<a href="/certpolicyglobaldownload.do?download=true&certLinkName=GR452111426NC">here</a>`, { status: 200 });
    return new Response(pdf, { status: 200 });
  }) as unknown as typeof fetch;
  const got = await pullLinePlanCoverage("MSC Cruises", "nc", { fetchImpl, pdfText: async () => POLICY, today: new Date(2026, 10, 13) });
  assert.equal(got.status, "ready");
  if (got.status !== "ready") return;
  assert.deepEqual([got.plan.cruise_line, got.plan.plan_name, got.plan.product_code, got.plan.state, got.plan.benefits.length], ["MSC Cruises", "MSC Cruises Travel Insurance", "GR452", "NC", 9]);
  assert.match(got.plan.source_en, /plan document GR452 for North Carolina residents\. The policy itself governs\./);
  assert.ok(calls[1]!.includes("certstate=NC") && calls[1]!.includes("product=GR452") && calls[1]!.includes("appdate=11%2F13%2F2026"), calls[1]);
  assert.ok(calls[2]!.endsWith("certLinkName=GR452111426NC"));
  // what cannot be read is said, never filled in
  for (const [line, state, why] of [["Carnival Cruise Line", "NC", /no published source/], ["MSC Cruises", "", /state is not on file/]] as const) {
    const no = await pullLinePlanCoverage(line, state, { fetchImpl, pdfText: async () => POLICY });
    assert.ok(no.status === "unavailable" && why.test(no.reason), JSON.stringify(no));
  }
  const wrong = await pullLinePlanCoverage("MSC Cruises", "NC", { fetchImpl, pdfText: async () => "a different product XX999 SCHEDULE OF BENEFITS" });
  assert.ok(wrong.status === "unavailable" && /not product GR452/.test(wrong.reason));
  const down = await pullLinePlanCoverage("MSC Cruises", "NC", { fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, pdfText: async () => POLICY });
  assert.ok(down.status === "unavailable" && /could not be read while opening the plan-document page: offline/.test(down.reason));
});

test("a known source, and the state out of the address line", () => {
  assert.equal(lineSource("MSC Cruises")?.product, "GR452");
  assert.equal(lineSource("Carnival Cruise Line"), null);
  assert.equal(stateOf("Fuquay Varina, NC 27526"), "NC");
  assert.equal(stateOf("Miami, fl 33101-1234"), "FL");
  assert.equal(stateOf("somewhere"), null);
});

// Norwegian's NorwegianCare document (Ed. 12/2024, policy NWENCL04) exactly as the server's PDF reader renders its summary and Schedule of Benefits
// (read 2026-11-13 from the administrator's page; figures spaced apart are the PDF's own)
const NCL = "NorwegianCare\nCover Page\nCancellation Penalty Waiver Program……Cash Refund Up to Total Cruise Vacation Cost\nThis Cancellation Penalty Waiver Program is an addendum\nYou must purchase NorwegianCare to receive this program benefit.\nCancel for Any Reason NorwegianCare Credit Program .... ..provides 90%** of the non - refundable pre - paid travel\narrangements booked with Norwegian Cruise Line +   in the form of a NorwegianCare Credit.\nSCHEDULE OF BENEFITS\nCOVERAGES   MAXIMUM BENEFIT\nPER PERSON PER   TRIP\nTrip Interruption\nMaximum Benefit\nReasonable Expenses Per Day\n150 % of Trip Cost\n$200\nTrip Delay\nMaximum Benefit   $ 1,000\nAccident Medical Expense\nMaximum Benefit\nDental Expenses\nSickness Medical Expense\nMaximum Benefit\n$ 50,000\n$ 2,500\n$ 50,000\nEmergency Evacuation\nMaximum Benefit\nHospital Companion\n$ 250,000\n$ 2 , 5 00\nRepatriation of Remains\nMaximum Benefit   $ 25,000\nBaggage/Personal Effects\nMaximum Benefit\nPer Article Limit\nCombined Article Limit\n$ 1,500\n$ 250\n$ 400\nBaggage Delay\nMaximum Benefit   $ 500\nNSITC 2200\nThere are also Non - Insurance and Emergency Travel Assistance Services\n\n--- page break ---\n\nNSI G TC 2 5 00   6   NorwegianCare   –   Ed. 1 2 /2024\nPolicy # NWENCL04\nNationwide Mutual Insurance Company";

test("Mark 2026-11-13 (\"do a test by pulling the plans for Norwegian\"): Norwegian's stacked schedule is read line for line, with the cruise line's own cancellation programs first", () => {
  const s = scheduleFromPolicyText(NCL);
  assert.deepEqual(s, [
    { name: "Trip Cancellation: Cancellation Penalty Waiver Program (provided by the cruise line, not insurance)", coverage: "Cash Refund Up to Total Cruise Vacation Cost", limits: [] },
    { name: "Cancel for Any Reason: NorwegianCare Credit Program (provided by the cruise line, not insurance)", coverage: "90% as a NorwegianCare Credit", limits: [] },
    { name: "Trip Interruption", coverage: "150% of Trip Cost", limits: [{ name: "Reasonable Expenses Per Day", value: "$200" }] },
    { name: "Trip Delay", coverage: "$1,000", limits: [] },
    { name: "Accident Medical Expense", coverage: "$50,000", limits: [{ name: "Dental Expenses", value: "$2,500" }] },
    { name: "Sickness Medical Expense", coverage: "$50,000", limits: [] },
    { name: "Emergency Evacuation", coverage: "$250,000", limits: [{ name: "Hospital Companion", value: "$2,500" }] },
    { name: "Repatriation of Remains", coverage: "$25,000", limits: [] },
    { name: "Baggage/Personal Effects", coverage: "$1,500", limits: [{ name: "Per Article Limit", value: "$250" }, { name: "Combined Article Limit", value: "$400" }] },
    { name: "Baggage Delay", coverage: "$500", limits: [] },
  ]);
});

test("Norwegian's document is asked of its administrator's page by state, then downloaded and read", async () => {
  const calls: string[] = [];
  const pdf = new Uint8Array([...Buffer.from("%PDF-1.7 "), ...new Uint8Array(2000)]);
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return url.includes("getDocumentUrlForState") ? new Response("/document/pdfs/NorwegianCare_Generic_12_24.pdf", { status: 200 }) : new Response(pdf, { status: 200 });
  }) as unknown as typeof fetch;
  const got = await pullLinePlanCoverage("Norwegian Cruise Line", "NC", { fetchImpl, pdfText: async () => NCL });
  assert.equal(got.status, "ready");
  if (got.status !== "ready") return;
  assert.deepEqual([got.plan.cruise_line, got.plan.plan_name, got.plan.product_code, got.plan.state, got.plan.benefits.length], ["Norwegian Cruise Line", "NorwegianCare Travel Protection", "NWENCL04", "NC", 10]);
  assert.deepEqual(calls, ["POST https://affinitytravelcert.com/api/getDocumentUrlForState?splr=NCL&carrier=NWE&product=NWENCL04&state=NC", "GET https://affinitytravelcert.com/document/pdfs/NorwegianCare_Generic_12_24.pdf"]);
  assert.match(got.plan.about, /underwritten by Nationwide/);
  const none = await pullLinePlanCoverage("NCL", "NC", { fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch, pdfText: async () => NCL });
  assert.ok(none.status === "unavailable" && /gave no NWENCL04 document for NC/.test(none.reason));
  assert.equal(lineSource("Norwegian Cruise Line")?.product, "NWENCL04");
});
