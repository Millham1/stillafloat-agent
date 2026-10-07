import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUSINESS, decryptPii, encryptPii, hashForAudit, hashLinkToken, last4, looksLikeLinkToken, newLinkToken,
  normalizePassport, passportLooksValid, piiConfigured,
} from "./group-secure";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

test("the legal name is written exactly as Mark specified", () => {
  assert.equal(BUSINESS.legalName, "Still Afloat LLC dba Still Afloat Cruising");
  assert.equal(BUSINESS.tradeName, "Still Afloat Cruising");
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
