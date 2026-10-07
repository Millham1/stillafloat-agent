// group-secure.ts — the security primitives for client paperwork (migration 0044).
// Pure functions over node:crypto so every rule here is unit-tested:
//
//   * BUSINESS — the one place the legal name is written. Documents and
//     signature blocks say "Still Afloat LLC dba Still Afloat Cruising"
//     (Mark 2026-10-02: "dba", not spelled out); marketing says the trade name.
//   * Traveler links: a random token goes in the emailed link; only its sha256
//     is stored (group_travelers.form_token_hash), so a database read can never
//     reconstruct a working link.
//   * Passport numbers: AES-256-GCM with GROUP_PII_KEY (64 hex chars in
//     shared.env). Ciphertext carries a version tag so the key can be rotated.
//     FAILS CLOSED: no key → no write, never a plaintext fallback.
//   * hashForAudit: IP / user agent are stored only as salted hashes.

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const BUSINESS = {
  legalName: "Still Afloat LLC dba Still Afloat Cruising",
  tradeName: "Still Afloat Cruising",
  agentName: "Mark Millham",
  email: "mark@stillafloatcruising.com",
  site: "https://stillafloatcruising.com",
  host: "Cornerstone Collective",
  /** Terms §14 venue (Mark 2026-10-03: pending Cornerstone's answer on the Texas governing-law line). */
  arbitrationCity: "Raleigh, North Carolina",
  paymentMethods: "Payments are made directly to the cruise line or supplier by the client.",
} as const;

// ── Traveler link tokens ──────────────────────────────────────────────────────

export function newLinkToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashLinkToken(token: string): string {
  return createHash("sha256").update(`saf-group-link:${token}`).digest("hex");
}

/** A token is 43 base64url characters; reject anything else before it reaches the database. */
export function looksLikeLinkToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

// ── Passport encryption ───────────────────────────────────────────────────────

const VERSION = "v1";

function keyFromHex(hex: string | undefined): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("GROUP_PII_KEY is not set (64 hex characters) — refusing to handle passport data");
  }
  return Buffer.from(hex, "hex");
}

export function piiConfigured(hex: string | undefined = process.env["GROUP_PII_KEY"]): boolean {
  return !!hex && /^[0-9a-fA-F]{64}$/.test(hex);
}

/** Normalise what a traveler typed: uppercase, no spaces or dashes. */
export function normalizePassport(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, "");
}

/** Passport numbers are 6–9 letters/digits in every country we will plausibly see. */
export function passportLooksValid(input: string): boolean {
  return /^[A-Z0-9]{6,9}$/.test(normalizePassport(input));
}

export function encryptPii(plain: string, hex: string | undefined = process.env["GROUP_PII_KEY"]): string {
  const key = keyFromHex(hex);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":");
}

export function decryptPii(stored: string, hex: string | undefined = process.env["GROUP_PII_KEY"]): string {
  const key = keyFromHex(hex);
  const [version, iv, tag, ct] = stored.split(":");
  if (version !== VERSION || !iv || !tag || !ct) throw new Error("Unrecognised ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export function last4(value: string): string {
  return normalizePassport(value).slice(-4);
}

// ── Audit hashes ──────────────────────────────────────────────────────────────

export function hashForAudit(value: string | undefined, salt: string | undefined = process.env["UNSUBSCRIBE_SECRET"]): string | null {
  if (!value) return null;
  return createHash("sha256").update(`${salt ?? "saf"}:${value}`).digest("hex").slice(0, 32);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
