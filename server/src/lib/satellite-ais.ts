// satellite-ais.ts — paid satellite positions, ON DEMAND only. See satellite-ais-core.ts
// for the gate and parsing (pure, tested); this file is the ledger and the HTTP call.
import { PATHS, readJson, writeJson } from "./persistence";
import { logger } from "./logger";
import {
  type Ledger, type SatelliteFix, type LookupReason,
  monthKey, monthlyCap, satelliteEnabled, blankLedger, lookupDecision, parseDetail,
} from "./satellite-ais-core";
export * from "./satellite-ais-core";

// ── I/O ───────────────────────────────────────────────────────────────────────

let ledger: Ledger | null = null;
let ledgerDirty = false;

async function loadLedger(now: Date): Promise<Ledger> {
  if (!ledger) {
    const stored = await readJson<Partial<Ledger>>(PATHS.satelliteLedger, {});
    ledger = { ...blankLedger(now), ...stored, lastByMmsi: stored.lastByMmsi ?? {} };
  }
  if (ledger.month !== monthKey(now)) ledger = blankLedger(now); // new month, fresh budget
  return ledger;
}

async function saveLedger(): Promise<void> {
  if (!ledger || !ledgerDirty) return;
  ledgerDirty = false;
  try { await writeJson(PATHS.satelliteLedger, ledger); } catch (err) { logger.warn({ err }, "satellite-ais: ledger persist failed"); }
}

/** For the brief / health: how much of the month's budget is gone. */
export async function satelliteUsage(now = new Date()): Promise<{ enabled: boolean; month: string; used: number; cap: number; lastError: Ledger["lastError"] }> {
  const l = await loadLedger(now);
  return { enabled: satelliteEnabled(), month: l.month, used: l.used, cap: monthlyCap(), lastError: l.lastError ?? null };
}

/**
 * Ask the provider for one ship's current position, if the gate allows it.
 * Returns the fix (which may not be newer than what we have — the caller
 * decides) or null with the gate's reason in the log.
 */
export async function satelliteLookup(
  mmsi: string,
  lastFixAt: string | null,
  reason: LookupReason,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<SatelliteFix | null> {
  if (!satelliteEnabled()) return null;
  const l = await loadLedger(now);
  const gate = lookupDecision({ lastFixAt, ledger: l, mmsi, cap: monthlyCap(), now, reason });
  if (!gate.ok) {
    if (gate.why === "cap") logger.warn({ mmsi, reason, used: l.used, cap: monthlyCap() }, "satellite-ais: monthly cap reached — no lookup");
    return null;
  }
  l.lastByMmsi[mmsi] = now.toISOString();
  l.used += 1;                       // counted BEFORE the call: a failed call still costs the attempt
  ledgerDirty = true;
  try {
    const res = await fetchImpl(
      `https://datadocked.com/api/vessels_operations/get-vessel-location?imo_or_mmsi=${encodeURIComponent(mmsi)}`,
      { headers: { accept: "application/json", "x-api-key": process.env["DATADOCKED_API_KEY"] ?? "" }, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) {
      l.lastError = { at: now.toISOString(), status: res.status };
      logger.warn({ mmsi, reason, status: res.status }, "satellite-ais: lookup failed");
      await saveLedger();
      return null;
    }
    const body = (await res.json()) as { detail?: unknown };
    const fix = parseDetail(body?.detail);
    l.lastError = null;
    await saveLedger();
    logger.info({ mmsi, reason, source: fix?.source ?? "none", at: fix?.at ?? null, used: l.used }, "satellite-ais: lookup");
    return fix;
  } catch (err) {
    l.lastError = { at: now.toISOString(), status: (err as Error)?.name ?? "error" };
    logger.warn({ err, mmsi, reason }, "satellite-ais: lookup threw");
    await saveLedger();
    return null;
  }
}
