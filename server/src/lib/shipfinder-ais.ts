// shipfinder-ais.ts — ShipFinder lookups, ON DEMAND only, with their own call ledger.
// Same gate as Datadocked (satellite-ais-core.lookupDecision): the free feed must be
// stale, one call per ship per window, and a hard cap on calls.
import { PATHS, readJson, writeJson } from "./persistence";
import { logger } from "./logger";
import { type Ledger, type SatelliteFix, type LookupReason, monthKey, blankLedger, lookupDecision } from "./satellite-ais-core";
import { SHIPFINDER_URL, shipfinderEnabled, shipfinderCap, parseShipfinder } from "./shipfinder-core";
export * from "./shipfinder-core";

let ledger: Ledger | null = null;
let ledgerDirty = false;

async function loadLedger(now: Date): Promise<Ledger> {
  if (!ledger) {
    const stored = await readJson<Partial<Ledger>>(PATHS.shipfinderLedger, {});
    ledger = { ...blankLedger(now), ...stored, lastByMmsi: stored.lastByMmsi ?? {} };
  }
  if (ledger.month !== monthKey(now)) ledger = blankLedger(now);
  return ledger;
}
async function saveLedger(): Promise<void> {
  if (!ledger || !ledgerDirty) return;
  ledgerDirty = false;
  try { await writeJson(PATHS.shipfinderLedger, ledger); } catch (err) { logger.warn({ err }, "shipfinder: ledger persist failed"); }
}

export async function shipfinderUsage(now = new Date()): Promise<{ enabled: boolean; month: string; used: number; cap: number; lastError: Ledger["lastError"] }> {
  const l = await loadLedger(now);
  return { enabled: shipfinderEnabled(), month: l.month, used: l.used, cap: shipfinderCap(), lastError: l.lastError ?? null };
}

export async function shipfinderLookup(
  mmsi: string,
  lastFixAt: string | null,
  reason: LookupReason,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<SatelliteFix | null> {
  if (!shipfinderEnabled()) return null;
  const l = await loadLedger(now);
  const gate = lookupDecision({ lastFixAt, ledger: l, mmsi, cap: shipfinderCap(), now, reason });
  if (!gate.ok) {
    if (gate.why === "cap") logger.warn({ mmsi, reason, used: l.used, cap: shipfinderCap() }, "shipfinder: call cap reached — no lookup");
    return null;
  }
  l.lastByMmsi[mmsi] = now.toISOString();
  l.used += 1; // counted BEFORE the call
  ledgerDirty = true;
  const key = (process.env["SHIPFINDER_API_KEY"] ?? "").replace(/^["']+|["']+$/g, "");
  const url = `${SHIPFINDER_URL}?v=2&k=${encodeURIComponent(key)}&enc=1&id=${encodeURIComponent(mmsi)}&idtype=0`;
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      l.lastError = { at: now.toISOString(), status: res.status };
      logger.warn({ mmsi, reason, status: res.status }, "shipfinder: lookup failed");
      await saveLedger();
      return null;
    }
    const body = (await res.json()) as unknown;
    const fix = parseShipfinder(body, now);
    const status = body && typeof body === "object" ? (body as Record<string, unknown>)["status"] : undefined;
    l.lastError = fix ? null : { at: now.toISOString(), status: `status ${String(status)}` };
    await saveLedger();
    logger.info({ mmsi, reason, source: fix?.source ?? "none", at: fix?.at ?? null, used: l.used, status }, "shipfinder: lookup");
    return fix;
  } catch (err) {
    l.lastError = { at: now.toISOString(), status: (err as Error)?.name ?? "error" };
    logger.warn({ err, mmsi, reason }, "shipfinder: lookup threw");
    await saveLedger();
    return null;
  }
}
