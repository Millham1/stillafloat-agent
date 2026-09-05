// storm-diversion-events.ts — the I/O side of course-change detection
// (Mark, 2026-09-05). storm-diversion.ts decides WHAT a change is; this file
// decides what happens next:
//
//   • ONE event per ship movement, whichever storms the ship sits in (a
//     Mexican-Riviera ship was pinned to Karina, Marie AND Lowell — the old
//     per-alert nudge fired three times within one second);
//   • operator/news intel attached at detection (storm-intel.ts), so the nudge
//     already says what the line or the press has said about that ship;
//   • a three-way nudge on Mark's phone/brief: Publish to the alert / Open the
//     storm dashboard / Ignore;
//   • Publish appends the change to every affected alert's cruise-line
//     advisories card (public detail page + dashboard) — it does NOT email
//     subscribers; external sends stay approval-gated as everywhere else;
//   • when a storm ends, its ship pins and its open nudges are released for
//     THAT storm only — a ship still inside another live storm keeps that pin.

import { getSupabase } from "./persistence";
import { logger } from "./logger";
import { createAction, resolveActionsForSource } from "./actions";
import type { NotifyButton } from "./notify";
import { portBySlug } from "./ports";
import { dedupKey, kindLabel, kindConfidence, type ChangeKind } from "./storm-diversion";
import { diversionIntel, type IntelEntry } from "./storm-intel";

export const ACTION_TYPE = "storm_diversion";
const MAX_CARD_ENTRIES = 30;
const WMS_URL = "https://stillafloatcruising.com/wheres-my-ship.html";

export interface PendingDiversion {
  shipName: string;
  cruiseLine: string | null;
  mmsi: string | null;
  kind: ChangeKind;
  from: string | null;
  to: string;
  raw: string | null;
  at: string;
  reason: string;
  alertId: string;
  stormName: string;
}

export interface DiversionEventRow {
  id: string;
  ship_name: string;
  cruise_line: string | null;
  mmsi: string | null;
  kind: ChangeKind;
  from_slug: string | null;
  to_slug: string;
  raw: string | null;
  reason: string | null;
  detected_at: string;
  alert_ids: string[];
  storm_names: string[];
  intel: IntelEntry[];
  status: "pending" | "published" | "ignored";
  published_at: string | null;
  ignored_at: string | null;
}

export type MergedDiversion = PendingDiversion & { alertIds: string[]; stormNames: string[] };

function portName(slug: string | null): string {
  if (!slug) return "unknown";
  return portBySlug(slug)?.name ?? slug;
}

/** Merge per-alert detections into one event per ship movement. Pure. */
export function mergeDetections(list: PendingDiversion[]): MergedDiversion[] {
  const map = new Map<string, MergedDiversion>();
  for (const d of list) {
    const key = dedupKey(d.shipName, d.from, d.to, d.at);
    const cur = map.get(key);
    if (cur) {
      if (!cur.alertIds.includes(d.alertId)) cur.alertIds.push(d.alertId);
      if (!cur.stormNames.includes(d.stormName)) cur.stormNames.push(d.stormName);
    } else {
      map.set(key, { ...d, alertIds: [d.alertId], stormNames: [d.stormName] });
    }
  }
  return [...map.values()];
}

export function describeDiversion(e: {
  ship_name: string; kind: ChangeKind; from_slug: string | null; to_slug: string;
  raw: string | null; reason: string | null; storm_names: string[]; intel: IntelEntry[];
}): string {
  const lines: string[] = [];
  lines.push(`${e.ship_name}: ${portName(e.from_slug)} → ${portName(e.to_slug)} (${kindConfidence(e.kind)} confidence)`);
  if (e.raw) lines.push(`AIS destination as typed by the crew: “${e.raw}”`);
  if (e.reason) lines.push(`Why it counts: ${e.reason}.`);
  lines.push(`Storm${e.storm_names.length === 1 ? "" : "s"}: ${e.storm_names.join(", ")}.`);
  if (e.intel.length) {
    lines.push("What the line / press has said:");
    for (const it of e.intel.slice(0, 3)) lines.push(`• ${it.line}: ${it.note}`);
  } else {
    lines.push("No operator advisory or news item names this ship yet.");
  }
  lines.push("Publish adds it to the alert's cruise-line advisories (site + dashboard). Nothing is emailed.");
  return lines.join("\n");
}

export function diversionButtons(id: string): NotifyButton[] {
  return [
    { label: "📣 Publish to the alert", method: "POST", path: `/api/storm-diversions/${id}/publish` },
    { label: "Open storm dashboard", href: "/storm-alerts" },
    { label: "Ignore", method: "POST", path: `/api/storm-diversions/${id}/ignore`, dismiss: true },
  ];
}

/** Persist merged detections; nudge Mark once per NEW event. Returns nudges sent. */
export async function recordDiversionEvents(detections: PendingDiversion[]): Promise<number> {
  const merged = mergeDetections(detections);
  if (!merged.length) return 0;
  const supabase = getSupabase();
  let created = 0;

  for (const m of merged) {
    const key = dedupKey(m.shipName, m.from, m.to, m.at);
    const { data, error } = await supabase
      .from("storm_diversion_events")
      .upsert({
        dedup_key: key, ship_name: m.shipName, cruise_line: m.cruiseLine, mmsi: m.mmsi,
        kind: m.kind, from_slug: m.from, to_slug: m.to, raw: m.raw, reason: m.reason,
        detected_at: m.at, alert_ids: m.alertIds, storm_names: m.stormNames,
      }, { onConflict: "dedup_key", ignoreDuplicates: true })
      .select("id, ship_name, cruise_line, kind, from_slug, to_slug, raw, reason, storm_names, alert_ids");
    if (error) {
      logger.warn({ err: error, ship: m.shipName }, "storm-diversion: event insert failed");
      continue;
    }
    const row = ((data ?? []) as unknown as DiversionEventRow[])[0];
    if (!row) continue; // same movement already recorded today → already nudged

    let intel: IntelEntry[] = [];
    try {
      intel = await diversionIntel(m.shipName, m.cruiseLine, m.stormNames, m.alertIds);
    } catch (err) {
      logger.warn({ err, ship: m.shipName }, "storm-diversion: intel lookup failed");
    }
    if (intel.length) {
      await supabase.from("storm_diversion_events").update({ intel }).eq("id", row.id);
    }

    const title = `⚓ ${m.shipName} ${kindLabel(m.kind)} — ${m.stormNames.join(", ")}`;
    await createAction({
      type: ACTION_TYPE,
      source_ref: row.id,
      title,
      body: describeDiversion({ ...row, intel }),
      buttons: diversionButtons(row.id),
      tag: `storm-diversion-${row.id}`,
    }).catch((err) => logger.warn({ err }, "storm-diversion: action failed"));
    logger.info({ ship: m.shipName, kind: m.kind, from: m.from, to: m.to, storms: m.stormNames }, "storm-diversion: course change flagged");
    created++;
  }
  return created;
}

async function loadEvent(id: string): Promise<DiversionEventRow | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("storm_diversion_events").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as unknown as DiversionEventRow | null) ?? null;
}

/** Publish: append the change to each affected alert's advisories card. */
export async function publishDiversion(id: string): Promise<{ published: boolean; alerts: number; reason?: string }> {
  const e = await loadEvent(id);
  if (!e) return { published: false, alerts: 0, reason: "not found" };
  if (e.status !== "pending") return { published: false, alerts: 0, reason: `already ${e.status}` };
  const supabase = getSupabase();
  const when = new Date(e.detected_at);
  const stamp = `${when.toUTCString().slice(5, 16).trim()} ${when.toISOString().slice(11, 16)} UTC`;
  const lead = e.intel[0];
  const note = (
    `${e.ship_name} ${kindLabel(e.kind)}: ${portName(e.from_slug)} → ${portName(e.to_slug)} (AIS-declared, ${stamp}).` +
    (lead ? ` ${lead.line}: ${lead.note}` : "")
  ).slice(0, 300);
  const entry: IntelEntry = {
    line: `${e.cruise_line ?? "Cruise line"} — ${e.ship_name}`,
    note,
    url: lead?.url || WMS_URL,
  };

  let touched = 0;
  for (const alertId of e.alert_ids) {
    const { data, error } = await supabase.from("storm_alerts").select("id, cruise_line_info").eq("id", alertId).maybeSingle();
    if (error || !data) continue;
    const existing = Array.isArray((data as { cruise_line_info?: unknown }).cruise_line_info)
      ? ((data as { cruise_line_info: IntelEntry[] }).cruise_line_info)
      : [];
    const card = [...existing, entry].slice(-MAX_CARD_ENTRIES);
    const { error: upErr } = await supabase.from("storm_alerts")
      .update({ cruise_line_info: card, last_updated: new Date().toISOString() })
      .eq("id", alertId);
    if (upErr) { logger.warn({ err: upErr, alertId }, "storm-diversion: publish update failed"); continue; }
    touched++;
  }

  await supabase.from("storm_diversion_events")
    .update({ status: "published", published_at: new Date().toISOString() })
    .eq("id", id);
  await resolveActionsForSource(ACTION_TYPE, id, "done");
  logger.info({ id, ship: e.ship_name, alerts: touched }, "storm-diversion: published");
  return { published: true, alerts: touched };
}

export async function ignoreDiversion(id: string): Promise<{ ignored: boolean }> {
  const supabase = getSupabase();
  const { error } = await supabase.from("storm_diversion_events")
    .update({ status: "ignored", ignored_at: new Date().toISOString() })
    .eq("id", id).eq("status", "pending");
  if (error) throw error;
  await resolveActionsForSource(ACTION_TYPE, id, "dismissed");
  return { ignored: true };
}

/** Pending events for the dashboard, with port names resolved. */
export async function listPendingDiversions(alertIds: string[]): Promise<Array<DiversionEventRow & { from_name: string; to_name: string }>> {
  if (!alertIds.length) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase.from("storm_diversion_events")
    .select("*").eq("status", "pending").overlaps("alert_ids", alertIds)
    .order("detected_at", { ascending: false }).limit(50);
  if (error) { logger.warn({ err: error }, "storm-diversion: list failed"); return []; }
  return ((data ?? []) as unknown as DiversionEventRow[]).map((r) => ({
    ...r, from_name: portName(r.from_slug), to_name: portName(r.to_slug),
  }));
}

/**
 * A storm ended (or was dismissed): release ITS ship pins and drop it from open
 * events. Ships also inside another live storm keep that storm's pin; an event
 * with no live storms left is ignored and its nudge dismissed.
 */
export async function releaseAlertDiversions(alertId: string): Promise<{ shipsReleased: number; eventsClosed: number }> {
  const supabase = getSupabase();
  const out = { shipsReleased: 0, eventsClosed: 0 };

  const { data: ships, error: shipErr } = await supabase.from("storm_tracked_ships")
    .update({ released_at: new Date().toISOString() })
    .eq("alert_id", alertId).is("released_at", null)
    .select("id");
  if (shipErr) logger.warn({ err: shipErr, alertId }, "storm-diversion: ship release failed");
  else out.shipsReleased = (ships ?? []).length;

  const { data: events, error } = await supabase.from("storm_diversion_events")
    .select("id, alert_ids, storm_names").eq("status", "pending").contains("alert_ids", [alertId]);
  if (error) { logger.warn({ err: error, alertId }, "storm-diversion: event release failed"); return out; }
  for (const ev of (events ?? []) as Array<{ id: string; alert_ids: string[]; storm_names: string[] }>) {
    const remaining = ev.alert_ids.filter((a) => a !== alertId);
    if (remaining.length) {
      await supabase.from("storm_diversion_events").update({ alert_ids: remaining }).eq("id", ev.id);
    } else {
      await supabase.from("storm_diversion_events")
        .update({ status: "ignored", ignored_at: new Date().toISOString() }).eq("id", ev.id);
      await resolveActionsForSource(ACTION_TYPE, ev.id, "dismissed");
      out.eventsClosed++;
    }
  }
  return out;
}

/** Dev-box e2e: exercise everything DOWNSTREAM of detection through the real
 *  path (event → intel → nudge → buttons → publish → public page). Route-gated. */
export async function simulateDiversion(input: {
  shipName: string; cruiseLine?: string; kind?: ChangeKind; from?: string; to?: string; alertId: string; stormName: string;
}): Promise<number> {
  return recordDiversionEvents([{
    shipName: input.shipName,
    cruiseLine: input.cruiseLine ?? null,
    mmsi: null,
    kind: input.kind ?? "reroute",
    from: input.from ?? "cozumel",
    to: input.to ?? "progreso",
    raw: "SIMULATED",
    at: new Date().toISOString(),
    reason: "simulated on the dev box to exercise the nudge → publish path",
    alertId: input.alertId,
    stormName: input.stormName,
  }]);
}
