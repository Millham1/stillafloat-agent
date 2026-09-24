// position-provider.ts — the provider-agnostic half of a PAID position lookup:
// what a fix looks like, when we are allowed to buy one, and the spend ledger.
// No HTTP, no provider names. Unit-tested; adapters (lib/live-ais.ts) add I/O.
//
// WHY PAID LOOKUPS EXIST AT ALL. The free terrestrial AIS feed only hears a
// ship near a shore receiver, and our subscription is capped (150 MMSIs over
// 3 aisstream keys) and seeded around US homeports. A ship outside both goes
// silent indefinitely — not for hours, for MONTHS. MSC Meraviglia sat on the
// public tracker showing a 13 July position for 71 days while she was working
// the Mediterranean, and Live-AIS had a fix for her from three minutes before
// Mark looked at the page (2026-09-22). That is the gap this buys our way out
// of, and only when someone is actually looking.
//
// Mark, 2026-09-10: "we only need to ping the information if there is a
// request for an individual ship... a follow, storm impacts, itinerary changes."

/**
 * Why a credit may be spent:
 *   request — someone asked for this ship on Where's My Ship. A page view is a
 *             NEW request each time; the only guard is a short one against the
 *             same ship being clicked twice, since the answer cannot change.
 *   storm   — pinned to a live storm alert; every six hours so course changes
 *             are caught.
 *   watch   — someone is following the sailing; same six-hour cadence.
 * Nothing else may call a paid provider.
 */
export type LookupReason = "request" | "storm" | "watch";

/** Below this age the free feed is fresh enough — do not spend. */
export const LOOKUP_AFTER_MIN = 20;
/** Two clicks inside this window buy the same answer. */
export const REQUEST_GUARD_MIN = 5;
/** Storm cone / followed sailing: every six hours (Mark, "to save credits"). */
export const STANDING_WINDOW_MIN = 360;

/**
 * Mark's design (2026-09-24): "when a ship is inquired the API grabs terrestrial
 * AIS; if the data is stale it grabs Live-AIS and projects — one inquiry, one
 * call." This is the "stale" half: no fix at all, or a fix older than the free
 * feed's freshness bar. The per-ship guard and monthly cap in lookupDecision()
 * still bound the spend when the same ship is asked for again and again.
 */
export function staleForInquiry(lastPosAt: string | null | undefined, now = new Date()): boolean {
  if (!lastPosAt) return true;
  const t = Date.parse(lastPosAt);
  return !Number.isFinite(t) || (now.getTime() - t) / 60_000 > LOOKUP_AFTER_MIN;
}

export function perShipWindowMin(reason: LookupReason): number {
  return reason === "request" ? REQUEST_GUARD_MIN : STANDING_WINDOW_MIN;
}

export interface PositionFix {
  lat: number;
  lon: number;
  courseDeg: number | null;
  speedKn: number | null;
  headingDeg: number | null;
  /** When the SHIP reported, never when we asked. See live-ais-core parseVessel. */
  at: string;
  source: "satellite" | "terrestrial" | "unknown";
  /** Crew-typed destination text as the provider saw it (may decode a port we could not). */
  destination: string | null;
  etaUtc: string | null;
}

export interface SpendLedger {
  month: string;                      // "2026-09"
  used: number;                       // CREDITS, not calls
  lastByMmsi: Record<string, string>; // ISO time of the last lookup per ship
  lastError?: { at: string; status: number | string } | null;
}

export function monthKey(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function blankLedger(now = new Date()): SpendLedger {
  return { month: monthKey(now), used: 0, lastByMmsi: {}, lastError: null };
}

/**
 * ALLOWLIST="MSC Meraviglia,Norwegian Getaway" (names or MMSIs): when set, ONLY
 * these ships may be looked up. Mark, 2026-09-10: "you shouldn't be filling the
 * DB. pick 3 cruise ships to test the API." Unset = every ship qualifies, still
 * gated by reason, window and cap.
 */
export function allowlistSet(raw: string | undefined): Set<string> | null {
  if (!raw) return null;
  // The value can arrive with its quotes intact on some paths (seen 2026-09-10:
  // pm2 passed through "\"A,B\"" and only the middle entry ever matched), so
  // strip them from the whole value AND from each entry.
  const unq = (x: string) => x.trim().replace(/^["']+|["']+$/g, "").trim();
  const entries = unq(raw).split(",").map((x) => unq(x).toLowerCase()).filter(Boolean);
  return entries.length ? new Set(entries) : null;
}

export function allowlisted(mmsi: string, name: string, raw = process.env["POSITION_ALLOWLIST"]): boolean {
  const set = allowlistSet(raw);
  if (!set) return true;
  return set.has(mmsi.toLowerCase()) || set.has(name.trim().toLowerCase());
}

/** Pure gate: may we spend on this ship right now? */
export function lookupDecision(args: {
  lastFixAt: string | null;
  ledger: SpendLedger;
  mmsi: string;
  cap: number;
  cost: number;
  now: Date;
  reason: LookupReason;
}): { ok: true } | { ok: false; why: "fresh" | "recent-lookup" | "cap" } {
  const { lastFixAt, ledger, mmsi, cap, cost, now, reason } = args;
  const fixAge = lastFixAt ? (now.getTime() - Date.parse(lastFixAt)) / 60_000 : Infinity;
  if (Number.isFinite(fixAge) && fixAge < LOOKUP_AFTER_MIN) return { ok: false, why: "fresh" };
  const last = ledger.lastByMmsi[mmsi];
  if (last && (now.getTime() - Date.parse(last)) / 60_000 < perShipWindowMin(reason)) {
    return { ok: false, why: "recent-lookup" };
  }
  // Checked against the PRICE of the call about to be made — a provider that
  // can spend fifteen credits in one request must never be capped as though
  // every call were worth one (the vidIQ auto-refill lesson).
  const used = ledger.month === monthKey(now) ? ledger.used : 0;
  if (used + Math.max(1, cost) > cap) return { ok: false, why: "cap" };
  return { ok: true };
}
