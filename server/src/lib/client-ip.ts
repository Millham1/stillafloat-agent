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
export function clientIp(req: Request): string {
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  if (first) return first;
  return req.socket?.remoteAddress || req.ip || "unknown";
}
