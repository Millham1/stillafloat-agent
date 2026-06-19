import type { Request, Response, NextFunction } from "express";

// Single source of truth for admin/PII endpoint authentication.
//
// The dashboard sends the token three possible ways:
//   • raw fetches  → `x-affiliate-token` header (authHeaders())
//   • generated client hooks → `Authorization: Bearer <token>` (setAuthTokenGetter)
//   • editorial approval EMAIL links → `?token=<token>` query param
//
// All three are accepted. The expected value is AGENT_APPROVAL_TOKEN from the
// shared env. If that env var is unset (e.g. local dev), auth is open so the
// dashboard still works without a configured secret.

export function extractToken(req: Request): string {
  const header = req.headers["x-affiliate-token"];
  if (typeof header === "string" && header) return header;

  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();

  const q = req.query["token"];
  if (typeof q === "string" && q) return q;

  return "";
}

export function tokenOk(req: Request): boolean {
  const expected = process.env["AGENT_APPROVAL_TOKEN"];
  if (!expected) return true; // no token configured → open (dev)
  return extractToken(req) === expected;
}

export function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (tokenOk(req)) {
    next();
    return;
  }
  res.status(401).json({ success: false, error: "Unauthorized" });
}
