// mailer.test.ts — which address subscriber email goes out as, and that a failed send never throws.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sendMail } from "./mailer";

const realFetch = globalThis.fetch;
const realEnv = { key: process.env["IDEAS_API_KEY"], from: process.env["MAIL_FROM"] };

function capture(ok = true): { body: () => Record<string, unknown> } {
  let sent: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent = JSON.parse(init.body) as Record<string, unknown>;
    return { ok, status: ok ? 200 : 502 } as Response;
  }) as unknown as typeof fetch;
  return { body: () => sent };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realEnv.key === undefined) delete process.env["IDEAS_API_KEY"]; else process.env["IDEAS_API_KEY"] = realEnv.key;
  if (realEnv.from === undefined) delete process.env["MAIL_FROM"]; else process.env["MAIL_FROM"] = realEnv.from;
});

describe("sendMail", () => {
  const mail = { to: "pat@example.com", subject: "Hi", html: "<p>Hi</p>", fromName: "Still Afloat Ship Watch" };

  it("sends from MAIL_FROM when the box sets one, quotes and all", async () => {
    process.env["IDEAS_API_KEY"] = "test-key";
    process.env["MAIL_FROM"] = '"mark@stillafloatcruising.com"';
    const sent = capture();
    assert.equal(await sendMail(mail), true);
    assert.equal(sent.body()["from_addr"], "mark@stillafloatcruising.com");
    assert.equal(sent.body()["from_name"], "Still Afloat Ship Watch");
    assert.equal(sent.body()["to"], "pat@example.com");
  });

  it("leaves the sender to the ops-manager when no MAIL_FROM is set (dev)", async () => {
    process.env["IDEAS_API_KEY"] = "test-key";
    delete process.env["MAIL_FROM"];
    const sent = capture();
    await sendMail(mail);
    assert.equal(sent.body()["from_addr"], undefined);
  });

  it("an address passed by the caller wins over MAIL_FROM", async () => {
    process.env["IDEAS_API_KEY"] = "test-key";
    process.env["MAIL_FROM"] = "mark@stillafloatcruising.com";
    const sent = capture();
    await sendMail({ ...mail, fromAddr: "news@stillafloatcruising.com" });
    assert.equal(sent.body()["from_addr"], "news@stillafloatcruising.com");
  });

  it("without the ops-manager key nothing is sent, and a refused send returns false, never throws", async () => {
    delete process.env["IDEAS_API_KEY"];
    let called = false;
    globalThis.fetch = (async () => { called = true; return { ok: true, status: 200 } as Response; }) as unknown as typeof fetch;
    assert.equal(await sendMail(mail), false);
    assert.equal(called, false, "no key, no call");

    process.env["IDEAS_API_KEY"] = "test-key";
    capture(false);
    assert.equal(await sendMail(mail), false);

    globalThis.fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    assert.equal(await sendMail(mail), false);
  });
});
