import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUSINESS, decryptPii, deriveHubToken, encryptPii, hashForAudit, hashLinkToken, hubKey, last4, looksLikeLinkToken, newLinkToken,
  normalizePassport, passportLooksValid, piiConfigured,
} from "./group-secure";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

test("the legal name is written exactly as Mark specified", () => {
  assert.equal(BUSINESS.legalName, "Still Afloat LLC dba Still Afloat Cruising");
  assert.equal(BUSINESS.tradeName, "Still Afloat Cruising");
});

test("the contact line and logo that fill every client document are Mark's wording and a file that exists", async () => {
  assert.equal(BUSINESS.contactLine, `${BUSINESS.agentName} · ${BUSINESS.email} · ${BUSINESS.phone} · ${BUSINESS.arbitrationCity}`);
  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(`${process.cwd()}/public${BUSINESS.logoPath}`), "the logo file the documents point at must exist in server/public");
});

test("link tokens are random, well-formed, and stored only as a hash", () => {
  const a = newLinkToken();
  const b = newLinkToken();
  assert.notEqual(a, b);
  assert.ok(looksLikeLinkToken(a));
  assert.equal(hashLinkToken(a).length, 64);
  assert.notEqual(hashLinkToken(a), hashLinkToken(b));
  assert.equal(hashLinkToken(a), hashLinkToken(a));
  assert.ok(!hashLinkToken(a).includes(a));
  for (const bad of ["", "short", a + "x", "../../etc/passwd", null, 42, a.slice(0, 42) + "!"]) {
    assert.equal(looksLikeLinkToken(bad), false);
  }
});

test("passport numbers encrypt and decrypt, and never appear in the ciphertext", () => {
  const stored = encryptPii("A12345678", KEY);
  assert.ok(stored.startsWith("v1:"));
  assert.ok(!stored.includes("A12345678"));
  assert.equal(decryptPii(stored, KEY), "A12345678");
  // Same value twice gives different ciphertext (random IV).
  assert.notEqual(encryptPii("A12345678", KEY), stored);
});

test("a wrong key or a tampered value fails loudly instead of returning garbage", () => {
  const stored = encryptPii("A12345678", KEY);
  assert.throws(() => decryptPii(stored, OTHER));
  const parts = stored.split(":");
  parts[3] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => decryptPii(parts.join(":"), KEY));
  assert.throws(() => decryptPii("plain-text-not-encrypted", KEY));
});

test("no key means no passport handling — never a plaintext fallback", () => {
  assert.equal(piiConfigured(undefined), false);
  assert.equal(piiConfigured("abc"), false);
  assert.equal(piiConfigured(KEY), true);
  assert.throws(() => encryptPii("A12345678", undefined), /GROUP_PII_KEY/);
  assert.throws(() => encryptPii("A12345678", "tooshort"), /GROUP_PII_KEY/);
});

test("passport input is normalised and sanity-checked", () => {
  assert.equal(normalizePassport(" a12 345-678 "), "A12345678");
  assert.equal(passportLooksValid("a12 345-678"), true);
  assert.equal(passportLooksValid("12345"), false);
  assert.equal(passportLooksValid("A1234567890"), false);
  assert.equal(passportLooksValid("A1234$678"), false);
  assert.equal(last4("a12 345-678"), "5678");
});

test("audit hashes are stable, salted and short", () => {
  assert.equal(hashForAudit(undefined, "s"), null);
  const h = hashForAudit("203.0.113.9", "s");
  assert.equal(h, hashForAudit("203.0.113.9", "s"));
  assert.notEqual(h, hashForAudit("203.0.113.9", "t"));
  assert.equal(h!.length, 32);
  assert.ok(!h!.includes("203"));
});

// ── the cruise-page link (migration 0053) ─────────────────────────────────────

test("a traveler's cruise-page link is derived: the same every time, different for each traveler and key, and shaped like every other link", () => {
  const a = deriveHubToken("11111111-1111-4111-8111-111111111111", KEY);
  assert.ok(looksLikeLinkToken(a));
  assert.equal(deriveHubToken("11111111-1111-4111-8111-111111111111", KEY), a);
  assert.notEqual(deriveHubToken("22222222-2222-4222-8222-222222222222", KEY), a);
  assert.notEqual(deriveHubToken("11111111-1111-4111-8111-111111111111", OTHER), a);
  // only the hash is ever kept, and it finds the traveler the way a paperwork link's hash does
  assert.match(hashLinkToken(a), /^[0-9a-f]{64}$/);
  assert.throws(() => deriveHubToken("x", "short"), /link key is not set/);
});

test("the link key is GROUP_LINK_KEY when set and GROUP_PII_KEY otherwise; anything malformed is no key", () => {
  assert.equal(hubKey({ GROUP_LINK_KEY: KEY, GROUP_PII_KEY: OTHER }), KEY);
  assert.equal(hubKey({ GROUP_PII_KEY: OTHER }), OTHER);
  assert.equal(hubKey({ GROUP_LINK_KEY: "nope", GROUP_PII_KEY: OTHER }), OTHER);
  assert.equal(hubKey({}), null);
  assert.equal(hubKey({ GROUP_PII_KEY: "zz" }), null);
});
