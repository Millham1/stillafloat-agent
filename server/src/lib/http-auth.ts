import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";

// Single source of truth for admin/PII endpoint authentication.
//
// The dashboard sends the token three possible ways:
//   • raw fetches  → `x-affiliate-token` header (authHeaders())
//   • generated client hooks → `Authorization: Bearer <token>` (setAuthTokenGetter)
//   • editorial approval EMAIL links → `?token=<token>` query param
//
// All three are accepted. The expected value is AGENT_APPROVAL_TOKEN from the
// shared env.
//
// FAILS CLOSED (2026-09-04). This used to `return true` when AGENT_APPROVAL_TOKEN
// was unset, "so local dev works without a secret" — which meant a single missing
// env var silently opened every admin and PII endpoint on an internet-facing box:
// 103 call sites across 17 route files, no error, no alert. The hazard is not
// theoretical — `pm2 restart --update-env` replaces the process env from the
// calling shell and can drop variables, which is exactly why that flag is banned
// in the secret-rotation runbook, and the dev deploy still uses it.
//
// A missing secret now denies instead of admitting. To run locally without one,
// set AGENT_APPROVAL_TOKEN to any value — an explicit dev token is a one-line
// export, an accidentally-open production box is not recoverable.

export function extractToken(req: Request): string {
  const header = req.headers["x-affiliate-token"];
  if (typeof header === "string" && header) return header;

  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();

  const q = req.query["token"];
  if (typeof q === "string" && q) return q;

  return "";
}

let warnedMissingToken = false;

export function tokenOk(req: Request): boolean {
  const expected = process.env["AGENT_APPROVAL_TOKEN"];
  if (!expected) {
    // Loud once, not per request — a flood would bury it in the same logs someone
    // would be reading to work out why everything is 401ing.
    if (!warnedMissingToken) {
      warnedMissingToken = true;
      console.error(
        "[auth] AGENT_APPROVAL_TOKEN is not set — DENYING all token-gated requests. " +
          "Set it in /opt/stillafloat/shared.env and restart.",
      );
    }
    return false;
  }
  return extractToken(req) === expected;
}

export function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (tokenOk(req)) {
    next();
    return;
  }
  res.status(401).json({ success: false, error: "Unauthorized" });
}

// ── Scoped machine tokens (2026-09-06) ────────────────────────────────────────
// Narrow credentials for single-purpose callers — the Mac video publisher
// registering a Reel clip (SOCIAL_CLIP_TOKEN / x-social-clip-token) and Make
// posting follower/reach stats (SOCIAL_STATS_TOKEN / x-social-stats-token) — so
// the god token never leaves the boxes. The standard token is also accepted, so
// the dashboard and Mark can hit the same routes. Fails CLOSED when the env var
// is unset, for the same reason tokenOk does.
const warnedScoped = new Set<string>();

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function scopedTokenOk(req: Request, envName: string, headerName: string): boolean {
  if (tokenOk(req)) return true;
  const expected = process.env[envName];
  if (!expected) {
    if (!warnedScoped.has(envName)) {
      warnedScoped.add(envName);
      console.error(
        `[auth] ${envName} is not set — DENYING ${headerName} requests. Set it in /opt/stillafloat/shared.env and restart.`,
      );
    }
    return false;
  }
  const got = req.headers[headerName.toLowerCase()];
  return typeof got === "string" && got.length > 0 && safeEqual(got, expected);
}

export function requireScopedToken(envName: string, headerName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (scopedTokenOk(req, envName, headerName)) {
      next();
      return;
    }
    res.status(401).json({ success: false, error: "Unauthorized" });
  };
}
