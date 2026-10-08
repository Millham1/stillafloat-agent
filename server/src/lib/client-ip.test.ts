import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import { clientIp } from "./client-ip";

const fake = (headers: Record<string, string | string[]>, remote?: string) =>
  ({ headers, socket: { remoteAddress: remote }, ip: remote } as unknown as Request);

describe("clientIp — the visitor, not nginx", () => {
  it("reads X-Real-IP first (what our nginx sends)", () => {
    assert.equal(clientIp(fake({ "x-real-ip": "203.0.113.9" }, "127.0.0.1")), "203.0.113.9");
  });
  it("falls back to the first hop of X-Forwarded-For", () => {
    assert.equal(clientIp(fake({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }, "127.0.0.1")), "198.51.100.4");
  });
  it("prefers X-Real-IP when both are present", () => {
    assert.equal(clientIp(fake({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.4" })), "203.0.113.9");
  });
  it("uses the socket only when no proxy header is present", () => {
    assert.equal(clientIp(fake({}, "192.0.2.7")), "192.0.2.7");
    assert.equal(clientIp(fake({})), "unknown");
  });
  it("ignores blank headers", () => {
    assert.equal(clientIp(fake({ "x-real-ip": "  ", "x-forwarded-for": "" }, "192.0.2.7")), "192.0.2.7");
  });
  it("two visitors never share a bucket (the 2026-10-08 regression)", () => {
    const a = clientIp(fake({ "x-real-ip": "203.0.113.1" }, "127.0.0.1"));
    const b = clientIp(fake({ "x-real-ip": "203.0.113.2" }, "127.0.0.1"));
    assert.notEqual(a, b);
  });
});
