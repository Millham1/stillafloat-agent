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
