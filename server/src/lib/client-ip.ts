import type { Request } from "express";

// The ONE way to learn a visitor's address.
//
// nginx on both boxes forwards the visitor's address as `X-Real-IP` and does NOT
// set `X-Forwarded-For`. Until 2026-10-08 seven routes each read X-Forwarded-For
// first and fell back to the socket address, which is always nginx (127.0.0.1).
// Every visitor therefore shared ONE rate-limit bucket: 931 newsletter sign-up
// attempts answered 429 between Oct 1 and Oct 5, and no sign-up succeeded after
// Oct 2, because any five attempts in an hour (bots included) locked everyone out.
// Click reports showed a single IP hash per day for the same reason.
//
// Order: X-Real-IP (what our nginx sends) → first hop of X-Forwarded-For (any other
// proxy) → the socket. Never add a new header read in a route; extend this.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) {
    // nginx sets X-Real-IP to the connecting address. When that address is the box itself
    // (the release gate and the box's own jobs call through nginx from 127.0.0.1) a caller-set
    // X-Forwarded-For is the better answer: it lets local probes be told apart instead of
    // sharing one rate-limit bucket (2026-10-09: the gate's sign-up refusal probes 429'd each
    // other). Only loopback is trusted this way — a real visitor's X-Forwarded-For is ignored.
    if (LOOPBACK.has(real.trim()) && first) return first;
    return real.trim();
  }
  if (first) return first;
  return req.socket?.remoteAddress || req.ip || "unknown";
}
