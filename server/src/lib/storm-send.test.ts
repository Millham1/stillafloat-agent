// storm-send.test.ts — subscriber-facing links never point at the dashboard host.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { siteBase } from "./storm-send";

test("siteBase ignores DASHBOARD_URL and falls back to the public site", () => {
  const prev = { p: process.env["PUBLIC_URL"], d: process.env["DASHBOARD_URL"] };
  delete process.env["PUBLIC_URL"]; process.env["DASHBOARD_URL"] = "http://178.156.154.144:8080";
  assert.equal(siteBase(), "https://stillafloatcruising.com");
  process.env["PUBLIC_URL"] = "https://stillafloatcruising.com/";
  assert.equal(siteBase(), "https://stillafloatcruising.com");
  if (prev.p === undefined) delete process.env["PUBLIC_URL"]; else process.env["PUBLIC_URL"] = prev.p;
  if (prev.d === undefined) delete process.env["DASHBOARD_URL"]; else process.env["DASHBOARD_URL"] = prev.d;
});

// --- pacing (2026-09-18 Zoho block) -------------------------------------------------
// The storm loops sent to the same 11 subscribers as the newsletter, with no gap. Zoho
// took ten in 18 seconds and blocked the mailbox on the eleventh. These assert the gap
// exists, that it is skipped after the LAST recipient, and that a failure still paces.
import { sendPaced } from "./storm-send";

test("sendPaced waits between sends but not after the last one", async () => {
  const waits: number[] = [];
  const seen: string[] = [];
  const out = await sendPaced(["a", "b", "c"], async (x) => { seen.push(x); return true; },
    { paceMs: 45000, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.deepEqual(waits, [45000, 45000], "one gap BETWEEN each pair, none trailing");
  assert.deepEqual(out, { sent: 3, failed: 0 });
});

test("sendPaced never waits for a single recipient", async () => {
  const waits: number[] = [];
  const out = await sendPaced(["only"], async () => true,
    { paceMs: 45000, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, []);
  assert.deepEqual(out, { sent: 1, failed: 0 });
});

test("sendPaced counts failures and keeps pacing through them", async () => {
  const waits: number[] = [];
  const out = await sendPaced(["a", "b", "c"], async (x) => x !== "b",
    { paceMs: 1000, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(out, { sent: 2, failed: 1 }, "a refusal must not abort the rest");
  assert.equal(waits.length, 2);
});

test("paceMs 0 disables the gap entirely", async () => {
  const waits: number[] = [];
  await sendPaced(["a", "b"], async () => true,
    { paceMs: 0, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, []);
});
