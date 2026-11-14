import { test } from "node:test";
import assert from "node:assert/strict";
import { isProductionUrl, isTestBox } from "./site-kind";

test("the production site is the domain and every name under it, except the dev mirror's own name", () => {
  for (const u of ["https://stillafloatcruising.com", "https://stillafloatcruising.com/", "https://www.stillafloatcruising.com", "https://dashboard.stillafloatcruising.com/x",
    "http://stillafloatcruising.com:8080", "stillafloatcruising.com", "HTTPS://WWW.STILLAFLOATCRUISING.COM", "https://staging.stillafloatcruising.com", "https://dev.www.stillafloatcruising.com"]) {
    assert.equal(isProductionUrl(u), true, u);
  }
  for (const u of ["https://dev.stillafloatcruising.com", "https://dev.stillafloatcruising.com/group.html?g=x", "http://DEV.stillafloatcruising.com:8080", "dev.stillafloatcruising.com",
    "http://178.156.154.144", "http://178.156.154.144:8080", "http://localhost:5000", "https://notstillafloatcruising.com", "https://stillafloatcruising.com.example.org", "", null, undefined]) {
    assert.equal(isProductionUrl(u as string), false, String(u));
  }
  // an address that merely mentions the dev name is still production
  assert.equal(isProductionUrl("https://stillafloatcruising.com/?next=//dev.stillafloatcruising.com"), true);
});

test("a dev-only tool may run only on a box that says where it is and is not production", () => {
  assert.equal(isTestBox({ PUBLIC_URL: "http://178.156.154.144" }), true);
  assert.equal(isTestBox({ PUBLIC_URL: "https://dev.stillafloatcruising.com" }), true, "the dev mirror under its own name is still the dev mirror");
  assert.equal(isTestBox({ PUBLIC_URL: "https://stillafloatcruising.com" }), false);
  assert.equal(isTestBox({}), false, "a box that does not say where it is gets no dev-only tool (prod's default)");
});
