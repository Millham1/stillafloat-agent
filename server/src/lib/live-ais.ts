// live-ais.ts — Live-AIS calls, ON DEMAND only, with their own credit ledger.
// See live-ais-core.ts for the config, parsing and the port-call derivation
// (pure, tested); this file is the ledger and the HTTP.
//
// Same gate as the other two providers (satellite-ais-core.lookupDecision):
// the free feed must be stale, one call per ship per window, and a hard cap.
// The DIFFERENCE is that a Live-AIS call does not cost one credit — a track
// costs one per day, a port schedule five — so the cap is checked against the
// PRICE of the call about to be made, and the ledger debits that amount. A
// provider that can spend fifteen credits in one request must never be capped
// as though every call were worth one (the vidIQ auto-refill lesson).
import { PATHS, readJson, writeJson } from "./persistence";
import { logger } from "./logger";
import {
  type SpendLedger as Ledger, type PositionFix, type LookupReason,
  monthKey, blankLedger, lookupDecision,
} from "./position-provider";
import {
  type VesselRecord, type TrackPoint, type ScheduledPort, type LiveAisCall,
  type BboxVessel, type Box, type CreditState, type CreditStatus,
  liveAisEnabled, liveAisKey, liveAisCap, liveAisUrl, trackDays, creditCost,
  parseVessel, parseTrack, parsePorts, parseBbox, fixFromTrack, bboxCreditsCharged,
  blankCreditState, foldMonthlyUsage, creditStatus, creditAlarm, monthKeyOf,
  BBOX_MAX_LIMIT,
} from "./live-ais-core";
import { notifyMark } from "./notify";
export * from "./live-ais-core";

let ledger: Ledger | null = null;
let ledgerDirty = false;

async function loadLedger(now: Date): Promise<Ledger> {
  if (!ledger) {
    const stored = await readJson<Partial<Ledger>>(PATHS.liveAisLedger, {});
    ledger = { ...blankLedger(now), ...stored, lastByMmsi: stored.lastByMmsi ?? {} };
  }
  if (ledger.month !== monthKey(now)) ledger = blankLedger(now);
  return ledger;
}

async function saveLedger(): Promise<void> {
  if (!ledger || !ledgerDirty) return;
  ledgerDirty = false;
  try { await writeJson(PATHS.liveAisLedger, ledger); } catch (err) { logger.warn({ err }, "live-ais: ledger persist failed"); }
}

export async function liveAisUsage(now = new Date()): Promise<{ enabled: boolean; month: string; used: number; cap: number; lastError: Ledger["lastError"] }> {
  const l = await loadLedger(now);
  return { enabled: liveAisEnabled(), month: l.month, used: l.used, cap: liveAisCap(), lastError: l.lastError ?? null };
}

/** Would this call fit under the cap? Checked before every spend. */
function affordable(l: Ledger, cost: number, now: Date): boolean {
  const used = l.month === monthKey(now) ? l.used : 0;
  return used + cost <= liveAisCap();
}

async function getJson(path: string, fetchImpl: typeof fetch): Promise<{ ok: true; body: unknown } | { ok: false; status: number | string }> {
  try {
    const res = await fetchImpl(liveAisUrl(path), {
      headers: { accept: "application/json", authorization: `Bearer ${liveAisKey()}` },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, body: (await res.json()) as unknown };
  } catch (err) {
    return { ok: false, status: (err as Error)?.name ?? "error" };
  }
}

/**
 * Spend `cost` credits on `path`, respecting the cap. Credits are debited
 * BEFORE the call: a failed request still consumed the attempt, and the
 * provider refunds incomplete responses at end of day rather than inline, so
 * our ledger must be the pessimistic one.
 */
async function spend(
  call: LiveAisCall, path: string, cost: number, mmsi: string | null, fetchImpl: typeof fetch, now: Date,
): Promise<unknown | null> {
  const l = await loadLedger(now);
  if (!affordable(l, cost, now)) {
    logger.warn({ call, mmsi, cost, used: l.used, cap: liveAisCap() }, "live-ais: cap reached — no call");
    return null;
  }
  l.used += cost;
  if (mmsi) l.lastByMmsi[mmsi] = now.toISOString();
  ledgerDirty = true;
  const res = await getJson(path, fetchImpl);
  if (!res.ok) {
    l.lastError = { at: now.toISOString(), status: res.status };
    logger.warn({ call, mmsi, status: res.status }, "live-ais: call failed");
    await saveLedger();
    return null;
  }
  l.lastError = null;
  await saveLedger();
  logger.info({ call, mmsi, cost, used: l.used, cap: liveAisCap() }, "live-ais: call");
  return res.body;
}

/**
 * A position for ONE ship. The 1-credit vessel endpoint carries no lat/lon
 * (confirmed against the live API 2026-09-21), so the fix comes from a
 * one-day track — the same single credit, and it brings the recent history.
 */
export async function liveAisLookup(
  mmsi: string,
  lastFixAt: string | null,
  reason: LookupReason,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<PositionFix | null> {
  if (!liveAisEnabled()) return null;
  const l = await loadLedger(now);
  const gate = lookupDecision({ lastFixAt, ledger: l, mmsi, cap: liveAisCap(), cost: creditCost("track", 1), now, reason });
  if (!gate.ok) {
    if (gate.why === "cap") logger.warn({ mmsi, reason, used: l.used, cap: liveAisCap() }, "live-ais: monthly cap reached — no lookup");
    return null;
  }
  const body = await spend("track", `vessel/${encodeURIComponent(mmsi)}/track/1`, creditCost("track", 1), mmsi, fetchImpl, now);
  if (!body) return null;
  const points = parseTrack(body);
  const fix = fixFromTrack(points, (body as Record<string, unknown>)["source"]);
  logger.info({ mmsi, reason, points: points.length, at: fix?.at ?? null }, "live-ais: position from track");
  return fix;
}

/**
 * The ship's recent track. This is the call that closes the island blind spot
 * — see the header of live-ais-core.ts. `days` costs one credit per day.
 */
export async function liveAisTrack(
  mmsi: string,
  days = trackDays(),
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<{ points: TrackPoint[]; source: unknown } | null> {
  if (!liveAisEnabled()) return null;
  const cost = creditCost("track", days);
  const body = await spend("track", `vessel/${encodeURIComponent(mmsi)}/track/${cost}`, cost, mmsi, fetchImpl, now);
  if (!body) return null;
  return { points: parseTrack(body), source: (body as Record<string, unknown>)["source"] ?? null };
}

/** Static + dynamic record: destination, ETA, nav status, last port. NO position. */
export async function liveAisVessel(
  mmsi: string, fetchImpl: typeof fetch = fetch, now = new Date(),
): Promise<VesselRecord | null> {
  if (!liveAisEnabled()) return null;
  const body = await spend("vessel", `vessel/${encodeURIComponent(mmsi)}`, creditCost("vessel"), mmsi, fetchImpl, now);
  return body ? parseVessel(body) : null;
}

/**
 * Every vessel in a box, with positions. THE cheap call for storm work: one
 * 5-credit box covers every ship a storm has pinned in that region, instead of
 * a credit each. Reconciles the ledger against the provider's own
 * `summary.credits_used` — an empty box costs nothing, and we refund our own
 * estimate rather than quietly over-count a month of sweeps.
 */
export async function liveAisBbox(
  box: Box,
  limit = 100,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<{ vessels: BboxVessel[]; creditsCharged: number } | null> {
  if (!liveAisEnabled()) return null;
  const cappedLimit = Math.min(Math.max(Math.floor(limit), 1), BBOX_MAX_LIMIT);
  const estimate = creditCost("bbox", cappedLimit);
  const q = new URLSearchParams({
    minLat: String(box.minLat), maxLat: String(box.maxLat),
    minLon: String(box.minLon), maxLon: String(box.maxLon),
    limit: String(cappedLimit), page: "1",
  });
  const body = await spend("bbox", `vessels/bbox?${q.toString()}`, estimate, null, fetchImpl, now);
  if (!body) return null;
  const charged = bboxCreditsCharged(body);
  if (charged !== null && charged !== estimate) {
    const l = await loadLedger(now);
    l.used = Math.max(0, l.used - estimate + charged);   // settle to what was really billed
    ledgerDirty = true;
    await saveLedger();
  }
  const vessels = parseBbox(body);
  const at = now.toISOString();
  for (const v of vessels) v.fix.at = at;   // a box is the live picture; stamp it once, here
  logger.info({ vessels: vessels.length, estimate, charged }, "live-ais: bbox");
  return { vessels, creditsCharged: charged ?? estimate };
}

/** The operator's own forward schedule, up to 30 days. 5 credits. */
export async function liveAisPorts(
  mmsi: string, fetchImpl: typeof fetch = fetch, now = new Date(),
): Promise<ScheduledPort[] | null> {
  if (!liveAisEnabled()) return null;
  const body = await spend("ports", `vessel/${encodeURIComponent(mmsi)}/ports`, creditCost("ports"), mmsi, fetchImpl, now);
  return body ? parsePorts(body) : null;
}

/** Free: the provider's own count, to reconcile against our ledger. */
export async function liveAisRemoteUsage(
  fetchImpl: typeof fetch = fetch,
): Promise<{ requests: number; credits: number; month: string } | null> {
  if (!liveAisEnabled()) return null;
  const res = await getJson("usage/monthly", fetchImpl);
  if (!res.ok) return null;
  const b = res.body as Record<string, unknown>;
  return {
    requests: Number(b["total_requests"]) || 0,
    credits: Number(b["total_credits_used"]) || 0,
    month: typeof b["month"] === "string" ? b["month"] : monthKeyOf(),
  };
}

/**
 * THE LOW-CREDIT LISTENER (Mark, 2026-09-21: "alert me when credits drop below
 * 50"). Reads the free usage endpoint, folds it into the running balance and
 * pushes ONE alert per crossing — see creditAlarm() for the latch. Safe to run
 * as often as you like: the read costs nothing and only a crossing notifies.
 *
 * Returns the status so the brief and /api/health can show it without a
 * second call.
 */
export async function checkLiveAisCredits(
  fetchImpl: typeof fetch = fetch, now = new Date(),
): Promise<CreditStatus | null> {
  if (!liveAisEnabled()) return null;
  const usage = await liveAisRemoteUsage(fetchImpl);
  if (!usage) {
    logger.warn("live-ais: credit check could not read usage");
    return null;
  }
  const stored = await readJson<Partial<CreditState>>(PATHS.liveAisCredits, {});
  let state: CreditState = { ...blankCreditState(), ...stored };
  state = foldMonthlyUsage(state, usage.month, usage.credits);
  const status = creditStatus(state);
  const alarm = creditAlarm(status, state.warnedAt);
  state.warnedAt = alarm.warnAt;
  try { await writeJson(PATHS.liveAisCredits, state); } catch (err) { logger.warn({ err }, "live-ais: credit state persist failed"); }

  if (alarm.clear) logger.info({ remaining: status.remaining }, "live-ais: credits back above the threshold");
  if (alarm.alert) {
    const left = status.remaining ?? 0;
    logger.warn({ remaining: left, threshold: status.threshold, used: status.used }, "live-ais: LOW CREDITS");
    await notifyMark({
      title: `Live-AIS credits low: ${left} left`,
      body: `${left} of ${status.purchased} credits remain (${status.used} used). When these run out we stop seeing ships at Nassau, Cozumel and the private islands — the gap the free feed cannot cover. Top up: dashboard.live-ais.com → Add Credits.`,
      url: "https://dashboard.live-ais.com/",
      tag: "live-ais-credits",
      // A FAULT, not a nudge: running dry silently blinds the island lookups,
      // so this one earns the email floor when no device is reachable.
      priority: "high",
    }).catch((err) => logger.warn({ err }, "live-ais: low-credit notify failed"));
  }
  return status;
}

/** For the brief / health, without spending or notifying. */
export async function liveAisCreditStatus(): Promise<CreditStatus | null> {
  if (!liveAisEnabled()) return null;
  const stored = await readJson<Partial<CreditState>>(PATHS.liveAisCredits, {});
  return creditStatus({ ...blankCreditState(), ...stored });
}
