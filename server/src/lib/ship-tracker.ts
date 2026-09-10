// ship-tracker.ts — live cruise-ship positions for "Where's My Ship?" (WMS).
//
// v2 (Mark's design): the `ships` table is the FULL cruise-ship registry —
// search covers every ship in it. Live AIS tracking activates on request and
// is then RETAINED: the active set = ships with active watches, the seeded
// US-coast fleet (seed_active), and everything ever requested, newest first,
// up to capacity. Capacity = (number of API keys) × WMS_MAX_PER_CONN (the
// aisstream per-connection MMSI-filter allowance; default 50 — verify
// empirically). Under capacity pressure the least-recently-requested
// non-seeded ships rotate out; a new request instantly rotates a ship back in.
//
// One websocket PER KEY to the free aisstream.io feed (aisstream allows one
// connection per key), the active MMSI list sharded across them. Terrestrial
// AIS only: ships go quiet mid-ocean, so consumers must honor `lastPosAt`.
//
// Self-heal: vessels broadcast their name in voyage frames — a mismatch vs.
// the registry name (or a reflagging making an MMSI go permanently silent)
// flags the row `mmsi_suspect` for re-verification instead of silently
// tracking the wrong vessel.
//
// The tracker also derives itineraries from what it observes (port calls +
// declared destinations) and maintains one rolling source='ais' row per ship
// in the `sailings` table — the same table the storm feature matches impacted
// ships against.
//
// Env: AISSTREAM_API_KEYS (comma-separated) or AISSTREAM_API_KEY. Without a
// key the tracker no-ops and the WMS page reports tracking offline.

import { getSupabase, readJson, writeJson } from "./persistence";
import { logger } from "./logger";
import {
  matchDestination, nearestPort, distanceKm, portBySlug, type CruiseLocation,
} from "./ports";
import { groundsForPoint } from "./storm-grounds";
import type { PortCall } from "./storm-diversion";

const STATE_KEY = "wms-positions";
const AIS_URL = "wss://stream.aisstream.io/v0/stream";
const PORT_RADIUS_KM = 4;      // within this of a known port + slow = "in port"
const IN_PORT_MAX_KN = 0.7;    // at/under this speed counts as moored/anchored
const DEPART_MIN_KN = 2.0;     // above this (or out of radius) = departed
const PERSIST_EVERY_MS = 5 * 60 * 1000;
const REFRESH_SET_EVERY_MS = 5 * 60 * 1000;
const SAILINGS_EVERY_MS = 6 * 60 * 60 * 1000;
const PORT_CALL_LOG_MAX = 40;                 // per ship — enough for weeks of a weekly loop
const SNAPSHOT_CONTINUITY_MS = 15 * 60 * 1000; // a restart inside this gap keeps the observation window open

export interface RegistryShip {
  mmsi: string;
  name: string;
  cruiseLine: string;
  seedActive: boolean;
  hasWatch: boolean;
  lastRequestedAt: string | null;
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
  currentSailingStart: string | null;
  currentDepartPort: string | null;
  regionsSeen: string[];
  inPortSlug: string | null;
  // Observed port calls, oldest first (capped): the ship's OWN itinerary
  // pattern, which is what lets the storm feature tell a scheduled port change
  // from a course change (storm-diversion.ts).
  portCalls: PortCall[];
}

const positions = new Map<string, ShipPosition>();   // by MMSI (tracked now or previously)
let registryByMmsi = new Map<string, RegistryShip>(); // full registry (all ships w/ MMSI)
let activeMmsis = new Set<string>();                  // currently subscribed
let stormMmsis = new Set<string>();                   // storm-impacted ships — always tracked while a storm is live
const nameFlagged = new Set<string>();                // reported-name mismatches already persisted
let started = false;
// When CONTINUOUS observation began — chained through the snapshot across quick
// restarts. The storm course-change classifier only claims a mid-leg re-route
// for a leg it watched from the start; a gap could have swallowed a port call.
let observedSince: string | null = null;
let lastMessageAt = 0;

interface Conn {
  key: string;
  ws: import("ws") | null;
  mmsis: string[];   // shard assigned to this connection
  alive: boolean;
}
const conns: Conn[] = [];

function apiKeys(): string[] {
  const multi = process.env["AISSTREAM_API_KEYS"];
  if (multi) return multi.split(",").map((k) => k.trim()).filter(Boolean);
  const single = process.env["AISSTREAM_API_KEY"];
  return single ? [single] : [];
}

function maxPerConn(): number {
  return Number(process.env["WMS_MAX_PER_CONN"] ?? "50");
}

function blankPosition(ship: RegistryShip): ShipPosition {
  return {
    mmsi: ship.mmsi, name: ship.name, cruiseLine: ship.cruiseLine,
    lat: null, lon: null, cogDeg: null, sogKn: null, headingDeg: null,
    destinationRaw: null, destinationSlug: null, etaUtc: null,
    lastPortSlug: null, lastPortDepartedAt: null, lastPosAt: null,
    currentSailingStart: null, currentDepartPort: null, regionsSeen: [],
    inPortSlug: null, portCalls: [],
  };
}

// ── Public reads ──────────────────────────────────────────────────────────────

export function trackerEnabled(): boolean {
  return apiKeys().length > 0;
}

export function trackerHealthy(): boolean {
  return conns.some((c) => c.alive) && Date.now() - lastMessageAt < 15 * 60 * 1000;
}

export function capacity(): { active: number; max: number } {
  return { active: activeMmsis.size, max: apiKeys().length * maxPerConn() };
}

function registryByName(shipName: string): RegistryShip | null {
  const lower = shipName.toLowerCase();
  for (const ship of registryByMmsi.values()) {
    if (ship.name.toLowerCase() === lower) return ship;
  }
  return null;
}

export function isSubscribed(shipName: string): boolean {
  const ship = registryByName(shipName);
  return Boolean(ship && activeMmsis.has(ship.mmsi));
}

/** Registry MMSI for a ship name (null when unknown / no MMSI on file). */
export function mmsiForShip(shipName: string): string | null {
  return registryByName(shipName)?.mmsi ?? null;
}

/**
 * Storm lifecycle hook: ships impacted by live storm alerts get top tracking
 * priority for the storm's duration — including ships that were never seeded
 * or requested. Pass the full current set each scan; pass [] when no storms
 * are live to release them back to normal rotation.
 */
export async function setStormShips(mmsis: string[]): Promise<void> {
  const next = new Set(mmsis.filter(Boolean));
  const changed = next.size !== stormMmsis.size || [...next].some((m) => !stormMmsis.has(m));
  stormMmsis = next;
  if (!changed || !started) return;
  await refreshActiveSet().catch((err) => {
    logger.warn({ err }, "wms: storm-ship refresh failed");
  });
}

/** Start of the current continuous-observation window (null = not tracking). */
export function trackerObservedSince(): string | null {
  return observedSince;
}

export function inRegistry(shipName: string): boolean {
  return registryByName(shipName) !== null;
}

/** Lower-cased names of ships in the current live subscription (for list views). */
export function subscribedNames(): Set<string> {
  const names = new Set<string>();
  for (const mmsi of activeMmsis) {
    const ship = registryByMmsi.get(mmsi);
    if (ship) names.add(ship.name.toLowerCase());
  }
  return names;
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

/**
 * A visitor asked for this ship: stamp the request (retention) and pull the
 * active set forward immediately so the wake-up takes moments, not minutes.
 */
export async function requestShip(shipName: string): Promise<"live" | "waking" | "unknown"> {
  const ship = registryByName(shipName);
  if (!ship) return "unknown";
  const already = activeMmsis.has(ship.mmsi);
  ship.lastRequestedAt = new Date().toISOString();
  try {
    const supabase = getSupabase();
    await (supabase.from("ships") as ReturnType<typeof supabase.from>)
      .update({ last_requested_at: ship.lastRequestedAt })
      .eq("mmsi", ship.mmsi);
  } catch (err) {
    logger.warn({ err, ship: ship.name }, "wms: request stamp failed");
  }
  if (already) return "live";
  await refreshActiveSet().catch(() => {});
  return "waking";
}

// ── Registry + active-set scheduler ──────────────────────────────────────────

async function loadRegistry(): Promise<void> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("ships")
    .select("name, cruise_line, mmsi, seed_active, last_requested_at")
    .eq("active", true)
    .not("mmsi", "is", null);
  if (error) throw new Error(`loadRegistry: ${error.message}`);

  // Ships with an active watch are top priority — they have paying-attention
  // subscribers expecting alerts.
  const { data: watches } = await supabase
    .from("ship_watches")
    .select("ship_name")
    .eq("status", "active");
  const watched = new Set(((watches ?? []) as { ship_name: string }[]).map((w) => w.ship_name.toLowerCase()));

  registryByMmsi = new Map(
    ((data ?? []) as { name: string; cruise_line: string; mmsi: string; seed_active: boolean | null; last_requested_at: string | null }[])
      .map((r) => [String(r.mmsi), {
        mmsi: String(r.mmsi),
        name: r.name,
        cruiseLine: r.cruise_line,
        seedActive: Boolean(r.seed_active),
        hasWatch: watched.has(r.name.toLowerCase()),
        lastRequestedAt: r.last_requested_at,
      }]),
  );
}

/** Priority-ordered active set: storm-impacted + watches → seeded US fleet →
 *  requested, newest first. Storm ships are pinned for the storm's lifetime
 *  (Mark's lifecycle design 2026-07-22) — they claim slots even if they were
 *  never seeded or requested. */
function buildActiveSet(): Set<string> {
  const ships = [...registryByMmsi.values()];
  const rank = (s: RegistryShip): number =>
    (stormMmsis.has(s.mmsi) || s.hasWatch ? 0 : s.seedActive ? 1 : s.lastRequestedAt ? 2 : 3);
  ships.sort((a, b) =>
    rank(a) - rank(b) ||
    (b.lastRequestedAt ?? "").localeCompare(a.lastRequestedAt ?? "") ||
    a.name.localeCompare(b.name));
  const cap = apiKeys().length * maxPerConn();
  // Rank 3 (never requested, not seeded, no storm) ships stay registry-only
  // until asked for — EXCEPT storm ships, which qualify via rank 0 above.
  return new Set(ships.filter((s) => rank(s) < 3).slice(0, cap).map((s) => s.mmsi));
}

/** Re-shard the active set across connections; resubscribe the ones that changed. */
async function refreshActiveSet(): Promise<void> {
  await loadRegistry();
  const next = buildActiveSet();
  const changed = next.size !== activeMmsis.size || [...next].some((m) => !activeMmsis.has(m));
  activeMmsis = next;
  for (const mmsi of next) {
    if (!positions.has(mmsi)) positions.set(mmsi, blankPosition(registryByMmsi.get(mmsi)!));
  }
  if (!changed) return;

  const list = [...next].sort();
  const per = maxPerConn();
  conns.forEach((conn, i) => {
    const shard = list.slice(i * per, (i + 1) * per);
    const shardChanged = shard.length !== conn.mmsis.length || shard.some((m, j) => conn.mmsis[j] !== m);
    conn.mmsis = shard;
    if (shardChanged) subscribe(conn);
  });
  logger.info({ active: next.size, capacity: apiKeys().length * per }, "wms: active tracking set updated");
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

  // Self-heal: the vessel tells us its name. A mismatch means our MMSI likely
  // went stale (reflagging) and we're hearing a different ship — flag it.
  const reported = typeof msg["Name"] === "string" ? (msg["Name"] as string).trim() : "";
  if (reported && !nameFlagged.has(pos.mmsi)) {
    const a = reported.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const b = pos.name.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (a && b && !a.includes(b) && !b.includes(a)) {
      nameFlagged.add(pos.mmsi);
      logger.warn({ mmsi: pos.mmsi, registry: pos.name, reported }, "wms: AIS name mismatch — flagging MMSI for re-verification");
      const supabase = getSupabase();
      void (supabase.from("ships") as ReturnType<typeof supabase.from>)
        .update({ reported_name: reported, mmsi_suspect: true })
        .eq("mmsi", pos.mmsi);
    }
  }
}

// ── Port-call log (the ship's own itinerary pattern) ─────────────────────────

function logPortArrival(pos: ShipPosition, slug: string) {
  if (!Array.isArray(pos.portCalls)) pos.portCalls = [];
  const last = pos.portCalls[pos.portCalls.length - 1];
  if (last && last.slug === slug && !last.departedAt) return; // call already open
  pos.portCalls.push({ slug, arrivedAt: new Date().toISOString(), departedAt: null });
  if (pos.portCalls.length > PORT_CALL_LOG_MAX) pos.portCalls.splice(0, pos.portCalls.length - PORT_CALL_LOG_MAX);
}

function logPortDeparture(pos: ShipPosition, slug: string) {
  if (!Array.isArray(pos.portCalls)) pos.portCalls = [];
  const now = new Date().toISOString();
  const open = [...pos.portCalls].reverse().find((c) => c.slug === slug && !c.departedAt);
  if (open) open.departedAt = now;
  else pos.portCalls.push({ slug, arrivedAt: now, departedAt: now });
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
    logPortArrival(pos, near.slug);
    if (near.type === "embarkation") {
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
    logPortDeparture(pos, pos.inPortSlug);
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
    await writeJson(STATE_KEY, { updatedAt: new Date().toISOString(), observedSince, ships: allPositions() });
  } catch (err) {
    logger.warn({ err }, "wms: snapshot persist failed");
  }
}

async function warmFromSnapshot() {
  const snap = await readJson<{ updatedAt?: string; observedSince?: string | null; ships?: ShipPosition[] }>(STATE_KEY, {});
  for (const s of snap.ships ?? []) {
    const reg = s?.mmsi ? registryByMmsi.get(s.mmsi) : undefined;
    if (reg) {
      positions.set(s.mmsi, {
        ...blankPosition(reg), ...s, name: reg.name, cruiseLine: reg.cruiseLine,
        portCalls: Array.isArray(s.portCalls) ? s.portCalls : [],
      });
    }
  }
  // Observation continuity: a quick restart (snapshot younger than the
  // continuity window) keeps the window open; a longer gap could have swallowed
  // a port call, so the window reopens now and the classifier stays conservative.
  const age = Date.now() - Date.parse(snap.updatedAt ?? "");
  observedSince = Number.isFinite(age) && age < SNAPSHOT_CONTINUITY_MS && snap.observedSince
    ? snap.observedSince
    : new Date().toISOString();
}

// ── Websocket lifecycle (one per key, shard per connection) ──────────────────

function subscribe(conn: Conn) {
  if (!conn.ws || !conn.alive || !conn.mmsis.length) return;
  try {
    conn.ws.send(JSON.stringify({
      APIKey: conn.key,
      BoundingBoxes: [[[-90, -180], [90, 180]]], // MMSI filter does the narrowing
      FiltersShipMMSI: conn.mmsis,
      FilterMessageTypes: ["PositionReport", "ShipStaticData"],
    }));
    logger.info({ ships: conn.mmsis.length }, "wms: subscription sent");
  } catch (err) {
    logger.warn({ err }, "wms: subscribe send failed");
  }
}

function connect(conn: Conn) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const WebSocket = require("ws");
  const ws = new WebSocket(AIS_URL);
  conn.ws = ws;
  let closed = false;

  ws.on("open", () => {
    conn.alive = true;
    subscribe(conn);
    logger.info({ ships: conn.mmsis.length }, "wms: aisstream connected + subscribed");
  });

  ws.on("message", (buf: Buffer) => {
    lastMessageAt = Date.now();
    try {
      const frame = JSON.parse(buf.toString());
      const mmsi = String(frame?.MetaData?.MMSI ?? "");
      const ship = registryByMmsi.get(mmsi);
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
    conn.alive = false;
    conn.ws = null;
    logger.warn({ why }, "wms: aisstream disconnected — reconnecting in 30s");
    setTimeout(() => connect(conn), 30_000);
  };
  ws.on("close", () => reconnect("close"));
  ws.on("error", (err: Error) => { logger.warn({ err }, "wms: socket error"); ws.terminate?.(); reconnect("error"); });
}

/** Boot the tracker. Safe to call once at startup; no-ops without an API key. */
export async function startShipTracker() {
  if (started) return;
  started = true;

  // The registry always loads — search metadata and requestShip() must work
  // even without an AIS key, so visitor requests are stamped and retained
  // for the moment tracking comes online.
  try {
    await loadRegistry();
  } catch (err) {
    logger.error({ err }, "wms: registry load failed");
    return;
  }

  const keys = apiKeys();
  if (!keys.length) {
    logger.info("wms: AISSTREAM_API_KEY(S) unset — live tracking disabled (registry + request retention active)");
    return;
  }

  try {
    if (!registryByMmsi.size) {
      logger.warn("wms: registry empty — tracker idle (seed ships.mmsi)");
      return;
    }
    await warmFromSnapshot();
    for (const key of keys) conns.push({ key, ws: null, mmsis: [], alive: false });
    await refreshActiveSet(); // shards the initial set
    for (const conn of conns) connect(conn);
    setInterval(() => { refreshActiveSet().catch((err) => logger.warn({ err }, "wms: set refresh failed")); }, REFRESH_SET_EVERY_MS);
    setInterval(() => { persistSnapshot().catch(() => {}); }, PERSIST_EVERY_MS);
    setInterval(() => { syncDerivedSailings().catch((err) => logger.warn({ err }, "wms: sailings sync failed")); }, SAILINGS_EVERY_MS);
    setTimeout(() => { syncDerivedSailings().catch(() => {}); }, 10 * 60 * 1000);
  } catch (err) {
    logger.error({ err }, "wms: tracker failed to start");
  }
}

// Re-exported so the route layer stays free of geo math.
export { distanceKm };
export type { CruiseLocation };
