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

// ── startAlertSend: one send per alert, caller never waits ────────────────────
import { startAlertSend, _resetInFlightForTests } from "./storm-send";

function fakeDeps(overrides: Partial<Parameters<typeof startAlertSend>[1]> = {}) {
  const calls = { claim: 0, send: 0, sent: [] as unknown[], failed: [] as unknown[] };
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const deps = {
    claim: async () => { calls.claim++; return true; },
    send: async () => { calls.send++; await gate; return { sent: 11, failed: 0, total: 11 }; },
    markSent: async (c: unknown) => { calls.sent.push(c); },
    markFailed: async (e: unknown) => { calls.failed.push(e); },
    ...overrides,
  };
  return { deps, calls, release };
}

test("a second approve while the first send is still going out does not send again", async () => {
  _resetInFlightForTests();
  const { deps, calls, release } = fakeDeps();
  assert.equal(await startAlertSend("fay", deps), "started");
  assert.equal(await startAlertSend("fay", deps), "already");   // the 03:43:07 click
  assert.equal(calls.send, 1);
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls.sent, [{ sent: 11, failed: 0, total: 11 }]);
});

test("the caller gets an answer before the paced send finishes", async () => {
  _resetInFlightForTests();
  const { deps, calls } = fakeDeps();
  const t0 = Date.now();
  await startAlertSend("nolo", deps);            // send() is parked on the gate — would hang if awaited
  assert.ok(Date.now() - t0 < 50);
  assert.equal(calls.send, 1);
});

test("a lost claim (another process already flipped the row) sends nothing", async () => {
  _resetInFlightForTests();
  const { deps, calls } = fakeDeps({ claim: async () => false });
  assert.equal(await startAlertSend("fay", deps), "already");
  assert.equal(calls.send, 0);
});

test("a failed send is recorded and the alert can be tried again", async () => {
  _resetInFlightForTests();
  const { deps, calls } = fakeDeps({ send: async () => { throw new Error("relay down"); } });
  assert.equal(await startAlertSend("fay", deps), "started");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.failed.length, 1);
  assert.equal(await startAlertSend("fay", deps), "started", "lock released after the failure");
});
