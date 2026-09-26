// storm-diversion-log.ts — the running list of what the storm detector has seen
// (Mark, 2026-09-26: "a running list of ship diversions for storms on the
// dashboard … keep track at a glance of what is being pinged and be able to
// answer questions quickly").
//
// Until now a course change was visible in exactly one place: a pending
// storm_diversion_events row rendered inside its storm's card on the Storm
// Alerts page. Publish or Ignore it and it vanished; the quiet verdicts
// (rotation / itinerary_swap / unknown) never showed at all — they live in
// storm_tracked_ships.changes, a jsonb column nobody reads. The 24 Sep
// nor'easter is the case in point: Norwegian Escape's early run home to New
// York was recorded as an `itinerary_swap` under Fay's pin and shown nowhere.
//
// This module turns both stores into ONE list per ship movement:
//   • every `changes` entry on every pinned ship in the window ("pings"),
//     deduplicated across storms — a Caribbean ship pinned to Fay AND Gonzalo
//     logs the same movement twice, once per pin;
//   • each ping carries the matching storm_diversion_events row (status,
//     Publish/Ignore still work on pending ones) when the classifier raised one;
//   • events with no ping (simulated ones, or pins since deleted) are listed too.
//
// Pure helpers first (unit-tested in storm-diversion-log.test.ts); the
// Supabase reader is at the bottom.

import { getSupabase } from "./persistence";
import { logger } from "./logger";
import { portBySlug } from "./ports";
import { dedupKey, kindLabel, type ChangeKind } from "./storm-diversion";
import type { DiversionEventRow } from "./storm-diversion-events";

/** Same shape the lifecycle appends to storm_tracked_ships.changes. `kind` is
 *  absent on entries written before the 2026-09-05 classifier. */
export interface RawChange {
  at: string;
  from: string | null;
  to: string;
  raw: string | null;
  kind?: ChangeKind | null;
  reason?: string | null;
}

export interface TrackedShipLogRow {
  id: string;
  alert_id: string;
  ship_name: string;
  cruise_line: string | null;
  changes: RawChange[] | null;
}

export interface StormRef {
  id: string;
  nhc_id: string;
  name: string | null;
  classification: string | null;
  status: string;
}

export type PingKind = ChangeKind | "legacy";
export type Verdict = "diversion" | "swap" | "routine" | "unknown";

export interface EventSummary {
  id: string;
  status: DiversionEventRow["status"];
  published_at: string | null;
  ignored_at: string | null;
  intel: DiversionEventRow["intel"];
}

export interface Ping {
  at: string;
  ship_name: string;
  cruise_line: string | null;
  kind: PingKind;
  label: string;
  verdict: Verdict;
  from_slug: string | null;
  to_slug: string;
  from_name: string;
  to_name: string;
  raw: string | null;
  reason: string | null;
  storms: string[];
  alert_ids: string[];
  /** dedup keys of every raw entry folded into this ping (ship|from|to|day). */
  dedup_keys: string[];
  event: EventSummary | null;
  /** "ping" = seen on a tracked ship; "event" = only the events table has it. */
  source: "ping" | "event";
}

/** Same movement declared again within this window is one ping, not two. */
export const MERGE_WINDOW_MS = 6 * 3_600_000;
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 180;

export function verdictOf(kind: PingKind | null | undefined): Verdict {
  switch (kind) {
    case "reroute":
    case "new_port":
    case "order_change":
      return "diversion";
    case "itinerary_swap":
      return "swap";
    case "rotation":
      return "routine";
    default:
      return "unknown";
  }
}

export function pingLabel(kind: PingKind): string {
  if (kind === "legacy") return "changed declared destination (before the 5 Sep detector)";
  return kindLabel(kind);
}

export function portName(slug: string | null | undefined): string {
  if (!slug) return "unknown";
  return portBySlug(slug)?.name ?? slug;
}

export function stormLabel(s: StormRef | undefined, alertId: string): string {
  return s?.name || s?.nhc_id || alertId.slice(0, 8);
}

function ms(iso: string | null | undefined): number {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : NaN;
}

/** One ping per `changes` entry in the window, storms named. Newest first. */
export function flattenPings(
  rows: readonly TrackedShipLogRow[],
  storms: ReadonlyMap<string, StormRef>,
  sinceIso: string,
): Ping[] {
  const since = ms(sinceIso);
  const out: Ping[] = [];
  for (const row of rows) {
    for (const c of row.changes ?? []) {
      if (!c || !c.to || !c.at) continue;
      const at = ms(c.at);
      if (Number.isNaN(at) || at < since) continue;
      const kind: PingKind = c.kind ?? "legacy";
      out.push({
        at: c.at,
        ship_name: row.ship_name,
        cruise_line: row.cruise_line,
        kind,
        label: pingLabel(kind),
        verdict: verdictOf(kind),
        from_slug: c.from,
        to_slug: c.to,
        from_name: portName(c.from),
        to_name: portName(c.to),
        raw: c.raw,
        reason: c.reason ?? null,
        storms: [stormLabel(storms.get(row.alert_id), row.alert_id)],
        alert_ids: [row.alert_id],
        dedup_keys: [dedupKey(row.ship_name, c.from, c.to, c.at)],
        event: null,
        source: "ping",
      });
    }
  }
  return out.sort((a, b) => ms(b.at) - ms(a.at));
}

/**
 * Fold the same movement logged under several storms into one ping. Keyed on
 * ship + from + to; entries within MERGE_WINDOW_MS of the ping's first entry
 * join it (the lifecycle stamps each storm's pass a few ms apart, but a slow
 * scan can put the second storm's entry an hour later). The kept row is the
 * EARLIEST — when the movement was first seen — with every storm listed.
 */
export function dedupePings(pings: readonly Ping[]): Ping[] {
  const asc = [...pings].sort((a, b) => ms(a.at) - ms(b.at));
  const open = new Map<string, Ping>();
  const out: Ping[] = [];
  for (const p of asc) {
    const key = `${p.ship_name.trim().toLowerCase()}|${p.from_slug ?? "?"}|${p.to_slug}`;
    const cur = open.get(key);
    if (cur && ms(p.at) - ms(cur.at) <= MERGE_WINDOW_MS) {
      for (const s of p.storms) if (!cur.storms.includes(s)) cur.storms.push(s);
      for (const a of p.alert_ids) if (!cur.alert_ids.includes(a)) cur.alert_ids.push(a);
      for (const k of p.dedup_keys) if (!cur.dedup_keys.includes(k)) cur.dedup_keys.push(k);
      // A later pass may carry the classifier's verdict where the first was a
      // re-baseline; prefer the entry that says something.
      if (cur.kind === "legacy" && p.kind !== "legacy") {
        cur.kind = p.kind; cur.label = p.label; cur.verdict = p.verdict; cur.reason = p.reason;
      }
      continue;
    }
    const copy: Ping = { ...p, storms: [...p.storms], alert_ids: [...p.alert_ids], dedup_keys: [...p.dedup_keys] };
    open.set(key, copy);
    out.push(copy);
  }
  return out.sort((a, b) => ms(b.at) - ms(a.at));
}

function summarize(e: DiversionEventRow): EventSummary {
  return { id: e.id, status: e.status, published_at: e.published_at, ignored_at: e.ignored_at, intel: e.intel ?? [] };
}

/**
 * Attach the events table to the pings by dedup key. An event that matches no
 * ping (a dev simulation, or a pin row that has since gone) becomes a ping of
 * its own so the list is complete. Newest first.
 */
export function attachEvents(pings: readonly Ping[], events: readonly DiversionEventRow[]): Ping[] {
  const byKey = new Map<string, DiversionEventRow>();
  for (const e of events) byKey.set(e.dedup_key, e);
  const used = new Set<string>();
  const out: Ping[] = pings.map((p) => {
    for (const k of p.dedup_keys) {
      const e = byKey.get(k);
      if (e) { used.add(e.id); return { ...p, event: summarize(e), verdict: verdictOf(e.kind), kind: e.kind, label: pingLabel(e.kind) }; }
    }
    return p;
  });
  for (const e of events) {
    if (used.has(e.id)) continue;
    out.push({
      at: e.detected_at,
      ship_name: e.ship_name,
      cruise_line: e.cruise_line,
      kind: e.kind,
      label: pingLabel(e.kind),
      verdict: verdictOf(e.kind),
      from_slug: e.from_slug,
      to_slug: e.to_slug,
      from_name: portName(e.from_slug),
      to_name: portName(e.to_slug),
      raw: e.raw,
      reason: e.reason,
      storms: [...(e.storm_names ?? [])],
      alert_ids: [...(e.alert_ids ?? [])],
      dedup_keys: [e.dedup_key],
      event: summarize(e),
      source: "event",
    });
  }
  return out.sort((a, b) => ms(b.at) - ms(a.at));
}

export function clampDays(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

// ── Supabase reader ──────────────────────────────────────────────────────────

export interface LiveStorm {
  id: string;
  name: string;
  nhc_id: string;
  classification: string | null;
  status: string;
  live_pins: number;
}

export interface DiversionLog {
  since: string;
  days: number;
  generated_at: string;
  storms: LiveStorm[];
  pings: Ping[];
  counts: { pings: number; diversions: number; swaps: number; routine: number; unknown: number; pending: number };
}

const LIVE_STATUSES = ["draft", "approved", "sending", "sent"];

export async function loadDiversionLog(days: number): Promise<DiversionLog> {
  const supabase = getSupabase();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  // Any pin with a change in the window was updated in the window (the
  // lifecycle stamps updated_at with every appended change).
  const { data: shipData, error: shipErr } = await supabase
    .from("storm_tracked_ships")
    .select("id, alert_id, ship_name, cruise_line, changes")
    .gte("updated_at", since)
    .limit(3000);
  if (shipErr) throw shipErr;
  const ships = (shipData ?? []) as unknown as TrackedShipLogRow[];

  const { data: eventData, error: eventErr } = await supabase
    .from("storm_diversion_events")
    .select("*")
    .gte("detected_at", since)
    .order("detected_at", { ascending: false })
    .limit(500);
  if (eventErr) throw eventErr;
  const events = (eventData ?? []) as unknown as DiversionEventRow[];

  const alertIds = new Set<string>();
  for (const s of ships) alertIds.add(s.alert_id);
  for (const e of events) for (const a of e.alert_ids ?? []) alertIds.add(a);

  const { data: alertData, error: alertErr } = await supabase
    .from("storm_alerts")
    .select("id, nhc_id, name, classification, status, is_threat")
    .or(`id.in.(${[...alertIds].join(",") || "00000000-0000-0000-0000-000000000000"}),status.in.(${LIVE_STATUSES.join(",")})`);
  if (alertErr) throw alertErr;
  const alerts = (alertData ?? []) as unknown as Array<StormRef & { is_threat: boolean }>;
  const storms = new Map<string, StormRef>(alerts.map((a) => [a.id, a]));

  // Live pins per storm for the header strip — a few hundred rows at most.
  const { data: pinData, error: pinErr } = await supabase
    .from("storm_tracked_ships")
    .select("alert_id")
    .is("released_at", null)
    .limit(3000);
  if (pinErr) logger.warn({ err: pinErr }, "storm-diversion-log: live pin count failed");
  const pinCount = new Map<string, number>();
  for (const p of (pinData ?? []) as Array<{ alert_id: string }>) pinCount.set(p.alert_id, (pinCount.get(p.alert_id) ?? 0) + 1);

  const live: LiveStorm[] = alerts
    .filter((a) => LIVE_STATUSES.includes(a.status) && a.is_threat)
    .map((a) => ({
      id: a.id, name: a.name || a.nhc_id, nhc_id: a.nhc_id, classification: a.classification,
      status: a.status, live_pins: pinCount.get(a.id) ?? 0,
    }))
    .sort((a, b) => b.live_pins - a.live_pins || a.name.localeCompare(b.name));

  const pings = attachEvents(dedupePings(flattenPings(ships, storms, since)), events);
  const counts = {
    pings: pings.length,
    diversions: pings.filter((p) => p.verdict === "diversion").length,
    swaps: pings.filter((p) => p.verdict === "swap").length,
    routine: pings.filter((p) => p.verdict === "routine").length,
    unknown: pings.filter((p) => p.verdict === "unknown").length,
    pending: pings.filter((p) => p.event?.status === "pending").length,
  };
  return { since, days, generated_at: new Date().toISOString(), storms: live, pings, counts };
}
