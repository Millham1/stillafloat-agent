// shipfinder-ais.ts — ShipFinder lookups, ON DEMAND only, with their own call ledger.
// Same gate as Datadocked (satellite-ais-core.lookupDecision): the free feed must be
// stale, one call per ship per window, and a hard cap on calls.
import { PATHS, readJson, writeJson } from "./persistence";
import { logger } from "./logger";
import { type Ledger, type SatelliteFix, type LookupReason, monthKey, blankLedger, lookupDecision } from "./satellite-ais-core";
import { shipfinderUrl, shipfinderEndpoint, shipfinderEnabled, shipfinderCap, shipfinderTrackCap, parseShipfinder, parseShipfinderList, parseShipfinderSearch, parseShipfinderTrack, type NearbyVessel, type SearchHit, type TrackSample } from "./shipfinder-core";
export * from "./shipfinder-core";

type SfLedger = Ledger & { trackUsed?: number; nearbyCalls?: number; searchCalls?: number };
let ledger: SfLedger | null = null;
let ledgerDirty = false;

async function loadLedger(now: Date): Promise<SfLedger> {
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

export async function shipfinderUsage(now = new Date()): Promise<{ enabled: boolean; month: string; used: number; cap: number; trackUsed: number; trackCap: number; nearbyCalls: number; searchCalls: number; lastError: Ledger["lastError"] }> {
  const l = await loadLedger(now);
  return { enabled: shipfinderEnabled(), month: l.month, used: l.used, cap: shipfinderCap(), trackUsed: l.trackUsed ?? 0, trackCap: shipfinderTrackCap(), nearbyCalls: l.nearbyCalls ?? 0, searchCalls: l.searchCalls ?? 0, lastError: l.lastError ?? null };
}

function apiKey(): string {
  return (process.env["SHIPFINDER_API_KEY"] ?? "").replace(/^["']+|["']+$/g, "");
}
async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown | null> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  return (await res.json()) as unknown;
}

/**
 * Vessels within 10 nm of a ship, with full position records — UNMETERED on the
 * Starter key (console, 2026-09-11). Called right after a paid lookup so every
 * registry ship sharing her pier is refreshed for free.
 */
export async function shipfinderNearby(mmsi: string, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<NearbyVessel[]> {
  if (!shipfinderEnabled()) return [];
  const l = await loadLedger(now);
  l.nearbyCalls = (l.nearbyCalls ?? 0) + 1; ledgerDirty = true;
  try {
    const body = await getJson(`${shipfinderEndpoint("AIS/VesselsNearby")}?key=${encodeURIComponent(apiKey())}&mmsi=${encodeURIComponent(mmsi)}`, fetchImpl);
    const list = parseShipfinderList(body);
    await saveLedger();
    return list;
  } catch (err) {
    logger.warn({ err, mmsi }, "shipfinder: nearby threw");
    await saveLedger();
    return [];
  }
}

/** Name / MMSI / IMO lookup — unmetered. */
export async function shipfinderSearch(keywords: string, max = 5, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<SearchHit[]> {
  if (!shipfinderEnabled()) return [];
  const l = await loadLedger(now);
  l.searchCalls = (l.searchCalls ?? 0) + 1; ledgerDirty = true;
  try {
    const body = await getJson(`${shipfinderEndpoint("AIS/VesselSearch")}?key=${encodeURIComponent(apiKey())}&keywords=${encodeURIComponent(keywords)}&max=${max}`, fetchImpl);
    return parseShipfinderSearch(body);
  } catch (err) {
    logger.warn({ err, keywords }, "shipfinder: search threw");
    return [];
  } finally {
    await saveLedger();
  }
}

/**
 * The last `hours` of a ship's track — METERED (10 on Starter, cap
 * SHIPFINDER_TRACK_CAP). Used once, on a ship's first request, so the line
 * behind her is real from the start. null when the cap is reached.
 */
export async function shipfinderTrack(mmsi: string, hours = 24, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<TrackSample[] | null> {
  if (!shipfinderEnabled()) return null;
  const l = await loadLedger(now);
  if ((l.trackUsed ?? 0) >= shipfinderTrackCap()) {
    logger.warn({ mmsi, used: l.trackUsed, cap: shipfinderTrackCap() }, "shipfinder: track cap reached — no history");
    return null;
  }
  l.trackUsed = (l.trackUsed ?? 0) + 1; ledgerDirty = true; // counted BEFORE the call
  const end = Math.floor(now.getTime() / 1000), start = end - Math.round(hours * 3600);
  try {
    const body = await getJson(`${shipfinderEndpoint("History/VesselHistoryTrack")}?key=${encodeURIComponent(apiKey())}&mmsi=${encodeURIComponent(mmsi)}&start_time=${start}&end_time=${end}`, fetchImpl);
    const pts = parseShipfinderTrack(body);
    logger.info({ mmsi, hours, points: pts.length, trackUsed: l.trackUsed }, "shipfinder: history track");
    return pts;
  } catch (err) {
    logger.warn({ err, mmsi }, "shipfinder: track threw");
    return null;
  } finally {
    await saveLedger();
  }
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
  const url = `${shipfinderUrl()}?key=${encodeURIComponent(apiKey())}&mmsi=${encodeURIComponent(mmsi)}`;
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      l.lastError = { at: now.toISOString(), status: res.status };
      logger.warn({ mmsi, reason, status: res.status }, "shipfinder: lookup failed");
      await saveLedger();
      return null;
    }
    const body = (await res.json()) as unknown;
    const fix = parseShipfinder(body);
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    l.lastError = fix ? null : { at: now.toISOString(), status: `status ${String(b["status"])} ${String(b["msg"] ?? "")}`.trim() };
    await saveLedger();
    logger.info({ mmsi, reason, source: fix?.source ?? "none", at: fix?.at ?? null, used: l.used, status: b["status"], msg: b["msg"] }, "shipfinder: lookup");
    return fix;
  } catch (err) {
    l.lastError = { at: now.toISOString(), status: (err as Error)?.name ?? "error" };
    logger.warn({ err, mmsi, reason }, "shipfinder: lookup threw");
    await saveLedger();
    return null;
  }
}
