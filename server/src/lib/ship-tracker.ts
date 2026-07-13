// ship-tracker.ts — live cruise-ship positions for "Where's My Ship?" (WMS).
//
// One persistent websocket to the free aisstream.io feed, subscribed to the
// MMSIs in the `ships` table, keeps an in-memory position cache that the whole
// site reads from — marginal cost per visitor is zero. Terrestrial AIS only:
// ships go quiet mid-ocean, so every consumer must honor `lastPosAt` (the page
// shows "last reported Xh ago — tracking picks back up in coverage").
//
// The tracker also derives itineraries from what it observes (port calls +
// declared destinations) and maintains one rolling source='ais' row per ship
// in the `sailings` table — the same table the storm feature matches impacted
// ships against, so storm alerts get real itinerary data for free.
//
// Requires AISSTREAM_API_KEY in shared.env (free key — aisstream.io). Without
// it the tracker no-ops and the WMS page reports tracking offline.

import { getSupabase, readJson, writeJson } from "./persistence";
import { logger } from "./logger";
import {
  matchDestination, nearestPort, distanceKm, portBySlug, type CruiseLocation,
} from "./ports";
import { groundsForPoint } from "./storm-grounds";

const STATE_KEY = "wms-positions";
const AIS_URL = "wss://stream.aisstream.io/v0/stream";
const PORT_RADIUS_KM = 4;      // within this of a known port + slow = "in port"
const IN_PORT_MAX_KN = 0.7;    // at/under this speed counts as moored/anchored
const DEPART_MIN_KN = 2.0;     // above this (or out of radius) = departed
const PERSIST_EVERY_MS = 5 * 60 * 1000;
const SAILINGS_EVERY_MS = 6 * 60 * 60 * 1000;

export interface TrackedShip {
  mmsi: string;
  name: string;          // ships.name (site-canonical)
  cruiseLine: string;
}

export interface ShipPosition {
  mmsi: string;
  name: string;
  cruiseLine: string;
  lat: number | null;
  lon: number | null;
  cogDeg: number | null;      // course over ground
  sogKn: number | null;       // speed over ground
  headingDeg: number | null;
  destinationRaw: string | null;   // crew-typed AIS destination
  destinationSlug: string | null;  // matched cruise-port slug (weather card key)
  etaUtc: string | null;           // AIS-reported arrival estimate
  lastPortSlug: string | null;     // last observed port call
  lastPortDepartedAt: string | null;
  lastPosAt: string | null;        // when the last position report arrived
  // itinerary derivation (internal — not for display)
  currentSailingStart: string | null; // date the ship left its embarkation port
  currentDepartPort: string | null;
  regionsSeen: string[];              // storm-ground keys observed this sailing
  inPortSlug: string | null;
}

const positions = new Map<string, ShipPosition>(); // by MMSI
let shipsByMmsi = new Map<string, TrackedShip>();
let started = false;
let socketAlive = false;
let lastMessageAt = 0;

function blankPosition(ship: TrackedShip): ShipPosition {
  return {
    mmsi: ship.mmsi, name: ship.name, cruiseLine: ship.cruiseLine,
    lat: null, lon: null, cogDeg: null, sogKn: null, headingDeg: null,
    destinationRaw: null, destinationSlug: null, etaUtc: null,
    lastPortSlug: null, lastPortDepartedAt: null, lastPosAt: null,
    currentSailingStart: null, currentDepartPort: null, regionsSeen: [],
    inPortSlug: null,
  };
}

// ── Public reads ──────────────────────────────────────────────────────────────

export function trackerEnabled(): boolean {
  return Boolean(process.env["AISSTREAM_API_KEY"]);
}

export function trackerHealthy(): boolean {
  return socketAlive && Date.now() - lastMessageAt < 15 * 60 * 1000;
}

export function getPosition(shipName: string): ShipPosition | null {
  for (const pos of positions.values()) {
    if (pos.name.toLowerCase() === shipName.toLowerCase()) return pos;
  }
  return null;
}

export function allPositions(): ShipPosition[] {
  return [...positions.values()];
}

// ── Ship registry ─────────────────────────────────────────────────────────────

async function loadShips(): Promise<TrackedShip[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("ships")
    .select("name, cruise_line, mmsi")
    .eq("active", true)
    .not("mmsi", "is", null);
  if (error) throw new Error(`loadShips: ${error.message}`);
  return ((data ?? []) as { name: string; cruise_line: string; mmsi: string }[])
    .map((r) => ({ mmsi: String(r.mmsi), name: r.name, cruiseLine: r.cruise_line }));
}

// ── AIS message handling ─────────────────────────────────────────────────────

interface AisEta { Month?: number; Day?: number; Hour?: number; Minute?: number }

function etaToIso(eta: AisEta | undefined): string | null {
  if (!eta || !eta.Month || !eta.Day) return null;
  // AIS ETA has no year: assume the next occurrence of that month/day.
  const now = new Date();
  let year = now.getUTCFullYear();
  const candidate = Date.UTC(year, eta.Month - 1, eta.Day, eta.Hour ?? 0, eta.Minute ?? 0);
  if (candidate < now.getTime() - 7 * 86_400_000) year += 1;
  const d = new Date(Date.UTC(year, eta.Month - 1, eta.Day, eta.Hour ?? 0, eta.Minute ?? 0));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function handlePositionReport(pos: ShipPosition, msg: Record<string, unknown>) {
  const lat = Number(msg["Latitude"]);
  const lon = Number(msg["Longitude"]);
  if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return;
  pos.lat = lat;
  pos.lon = lon;
  const cog = Number(msg["Cog"]);
  pos.cogDeg = isFinite(cog) && cog >= 0 && cog < 360 ? cog : pos.cogDeg;
  const sog = Number(msg["Sog"]);
  pos.sogKn = isFinite(sog) && sog < 102.3 ? sog : pos.sogKn; // 102.3 = AIS "not available"
  const hdg = Number(msg["TrueHeading"]);
  pos.headingDeg = isFinite(hdg) && hdg >= 0 && hdg < 360 ? hdg : null; // 511 = unavailable
  pos.lastPosAt = new Date().toISOString();

  // Accumulate storm grounds seen this sailing (feeds the derived itinerary).
  for (const g of groundsForPoint(lat, lon)) {
    if (!pos.regionsSeen.includes(g)) pos.regionsSeen.push(g);
  }

  detectPortCall(pos);
}

function handleStaticData(pos: ShipPosition, msg: Record<string, unknown>) {
  const destRaw = typeof msg["Destination"] === "string" ? (msg["Destination"] as string).trim() : "";
  if (destRaw) {
    pos.destinationRaw = destRaw;
    pos.destinationSlug = matchDestination(destRaw)?.slug ?? null;
  }
  pos.etaUtc = etaToIso(msg["Eta"] as AisEta | undefined) ?? pos.etaUtc;
}

/**
 * Port-call detection: slow + within a few km of a known cruise port = a call.
 * Leaving an embarkation port starts a new derived sailing; arriving back at
 * one ends it (regionsSeen resets so the next sailing accumulates fresh).
 */
function detectPortCall(pos: ShipPosition) {
  if (pos.lat === null || pos.lon === null) return;
  const near = nearestPort(pos.lat, pos.lon, PORT_RADIUS_KM);
  const slow = (pos.sogKn ?? 0) <= IN_PORT_MAX_KN;

  if (near && slow && pos.inPortSlug !== near.slug) {
    pos.inPortSlug = near.slug;
    if (near.type === "embarkation") {
      // Back at a homeport: the current sailing (if any) is over.
      pos.currentSailingStart = null;
      pos.currentDepartPort = near.slug;
      pos.regionsSeen = [];
    }
    return;
  }

  const departed =
    pos.inPortSlug &&
    ((pos.sogKn ?? 0) >= DEPART_MIN_KN ||
      !near || near.slug !== pos.inPortSlug);
  if (departed && pos.inPortSlug) {
    const leftPort = portBySlug(pos.inPortSlug);
    pos.lastPortSlug = pos.inPortSlug;
    pos.lastPortDepartedAt = new Date().toISOString();
    if (leftPort?.type === "embarkation") {
      pos.currentSailingStart = new Date().toISOString().slice(0, 10);
      pos.currentDepartPort = leftPort.slug;
      pos.regionsSeen = pos.lat !== null && pos.lon !== null
        ? [...groundsForPoint(pos.lat, pos.lon)]
        : [];
    }
    pos.inPortSlug = null;
  }
}

// ── Derived sailings → storm feature ─────────────────────────────────────────

/**
 * Maintain one rolling source='ais' row per tracked ship in `sailings`. The
 * row answers "where will this ship plausibly be over the next few days" for
 * the storm matcher: regions actually observed this sailing plus the declared
 * destination's grounds, with a rolling end_date so it always overlaps a storm
 * forecast window while the ship is being tracked. Manual (source='manual')
 * rows are never touched.
 */
export async function syncDerivedSailings(): Promise<number> {
  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
  let synced = 0;

  for (const pos of positions.values()) {
    if (pos.lat === null || pos.lon === null || !pos.lastPosAt) continue;
    // Skip stale ships (no fix in 48h) — don't feed the storm matcher guesses.
    if (Date.now() - Date.parse(pos.lastPosAt) > 48 * 3_600_000) continue;

    const regions = new Set<string>(pos.regionsSeen);
    for (const g of groundsForPoint(pos.lat, pos.lon)) regions.add(g);
    if (pos.destinationSlug) {
      const dest = portBySlug(pos.destinationSlug);
      if (dest) for (const g of groundsForPoint(dest.lat, dest.lon)) regions.add(g);
    }
    if (!regions.size) continue; // outside all tracked cruising grounds

    const row = {
      ship_name: pos.name,
      cruise_line: pos.cruiseLine,
      depart_port: pos.currentDepartPort ? (portBySlug(pos.currentDepartPort)?.name ?? pos.currentDepartPort) : null,
      start_date: pos.currentSailingStart ?? today,
      end_date: horizon,
      regions: [...regions],
      active: true,
      source: "ais",
    };

    // One AIS row per ship: update-else-insert keyed on (ship_name, source).
    const { data: existing, error: selErr } = await supabase
      .from("sailings")
      .select("id")
      .eq("ship_name", pos.name)
      .eq("source", "ais")
      .limit(1);
    if (selErr) { logger.warn({ err: selErr, ship: pos.name }, "wms: sailings select failed"); continue; }
    const existingId = (existing as { id: string }[] | null)?.[0]?.id;
    const { error } = existingId
      ? await (supabase.from("sailings") as ReturnType<typeof supabase.from>).update(row).eq("id", existingId)
      : await (supabase.from("sailings") as ReturnType<typeof supabase.from>).insert(row);
    if (error) { logger.warn({ err: error, ship: pos.name }, "wms: sailings upsert failed"); continue; }
    synced++;
  }
  if (synced) logger.info({ synced }, "wms: derived sailings synced to storm feature");
  return synced;
}

// ── Persistence (survive restarts) ───────────────────────────────────────────

async function persistSnapshot() {
  try {
    await writeJson(STATE_KEY, { updatedAt: new Date().toISOString(), ships: allPositions() });
  } catch (err) {
    logger.warn({ err }, "wms: snapshot persist failed");
  }
}

async function warmFromSnapshot() {
  const snap = await readJson<{ ships?: ShipPosition[] }>(STATE_KEY, {});
  for (const s of snap.ships ?? []) {
    if (s?.mmsi && shipsByMmsi.has(s.mmsi)) positions.set(s.mmsi, { ...blankPosition(shipsByMmsi.get(s.mmsi)!), ...s });
  }
}

// ── Websocket lifecycle ──────────────────────────────────────────────────────

function connect(apiKey: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const WebSocket = require("ws");
  const ws = new WebSocket(AIS_URL);
  let closed = false;

  ws.on("open", () => {
    socketAlive = true;
    ws.send(JSON.stringify({
      APIKey: apiKey,
      BoundingBoxes: [[[-90, -180], [90, 180]]], // MMSI filter does the narrowing
      FiltersShipMMSI: [...shipsByMmsi.keys()],
      FilterMessageTypes: ["PositionReport", "ShipStaticData"],
    }));
    logger.info({ ships: shipsByMmsi.size }, "wms: aisstream connected + subscribed");
  });

  ws.on("message", (buf: Buffer) => {
    lastMessageAt = Date.now();
    try {
      const frame = JSON.parse(buf.toString());
      const mmsi = String(frame?.MetaData?.MMSI ?? "");
      const ship = shipsByMmsi.get(mmsi);
      if (!ship) return;
      let pos = positions.get(mmsi);
      if (!pos) { pos = blankPosition(ship); positions.set(mmsi, pos); }
      if (frame.MessageType === "PositionReport") {
        handlePositionReport(pos, frame.Message?.PositionReport ?? {});
      } else if (frame.MessageType === "ShipStaticData") {
        handleStaticData(pos, frame.Message?.ShipStaticData ?? {});
      }
    } catch { /* malformed frame — skip */ }
  });

  const reconnect = (why: string) => {
    if (closed) return;
    closed = true;
    socketAlive = false;
    logger.warn({ why }, "wms: aisstream disconnected — reconnecting in 30s");
    setTimeout(() => connect(apiKey), 30_000);
  };
  ws.on("close", () => reconnect("close"));
  ws.on("error", (err: Error) => { logger.warn({ err }, "wms: socket error"); ws.terminate?.(); reconnect("error"); });
}

/** Boot the tracker. Safe to call once at startup; no-ops without an API key. */
export async function startShipTracker() {
  if (started) return;
  started = true;

  const apiKey = process.env["AISSTREAM_API_KEY"];
  if (!apiKey) {
    logger.info("wms: AISSTREAM_API_KEY unset — ship tracker disabled");
    return;
  }

  try {
    const ships = await loadShips();
    shipsByMmsi = new Map(ships.map((s) => [s.mmsi, s]));
    if (!shipsByMmsi.size) {
      logger.warn("wms: no ships have MMSIs — tracker idle (seed ships.mmsi)");
      return;
    }
    for (const ship of ships) if (!positions.has(ship.mmsi)) positions.set(ship.mmsi, blankPosition(ship));
    await warmFromSnapshot();
    connect(apiKey);
    setInterval(() => { persistSnapshot().catch(() => {}); }, PERSIST_EVERY_MS);
    setInterval(() => { syncDerivedSailings().catch((err) => logger.warn({ err }, "wms: sailings sync failed")); }, SAILINGS_EVERY_MS);
    // First sailings sync shortly after boot once some positions have arrived.
    setTimeout(() => { syncDerivedSailings().catch(() => {}); }, 10 * 60 * 1000);
  } catch (err) {
    logger.error({ err }, "wms: tracker failed to start");
  }
}

// Re-exported so the route layer stays free of geo math.
export { distanceKm };
export type { CruiseLocation };
