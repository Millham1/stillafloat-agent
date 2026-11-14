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
  assert.match(got.plan.source_en, /policy document GR452 for North Carolina residents\. The policy itself governs\./);
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
