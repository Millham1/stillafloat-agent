// storm-lifecycle.ts — the storm's life after the first alert (Mark's design
// 2026-07-22, task 3c349235 follow-on):
//
//   • impacted ships (date+itinerary matched) are pinned to the alert and
//     AIS-tracked for the storm's lifetime — even ships outside the normal
//     tracked set (ship-tracker rank-0 storm priority);
//   • AIS destination changes on those ships raise an action on the alert —
//     cruise-line behavior is an update trigger, like NHC upgrades;
//   • when the storm is dead (gone from a HEALTHY feed for 3 consecutive
//     scans) the alert ends: it drops off the website automatically, ship
//     tracking releases, and — for alerts that were approved/sent — an
//     all-clear email is drafted for Mark's one-click approval. Nothing is
//     ever sent to subscribers without his approval.
//
// Pure decision helpers are at the top (unit-tested in storm-lifecycle.test.ts);
// the I/O runner is below.

import { getSupabase } from "./persistence";
import { logger } from "./logger";
import { createAction, resolveActionsForSource } from "./actions";
import { sailingsForStorm, defaultWindow } from "./storm-sailings";
import { severityRank } from "./storm-escalation";
import { setStormShips, mmsiForShip, getPosition } from "./ship-tracker";
import { labelGrounds } from "./storm-grounds";
import { portBySlug } from "./ports";
import type { SystemsSnapshot } from "./storm-source";

export const MISSING_SCANS_TO_END = 3;

// ── Pure decision helpers ────────────────────────────────────────────────────

export interface LifecycleAlertState {
  status: string;
  approved_at: string | null;
  missing_scans: number;
}

export type DeathVerdict =
  | { kind: "seen" }                       // present this scan → reset the counter
  | { kind: "hold" }                       // feed unhealthy → no evidence either way
  | { kind: "count"; missing: number }     // absent, not yet dead
  | { kind: "end"; allClear: boolean };    // dead → end alert; draft all-clear if it was approved

/**
 * Judge one alert against one scan. `seenNow` = its nhc_id appeared in the
 * feed; `sourceHealthy` = the feed that would carry it actually answered.
 * A NHC outage must never read as a dead storm — hence "hold".
 */
export function judgeDeath(a: LifecycleAlertState, seenNow: boolean, sourceHealthy: boolean): DeathVerdict {
  if (seenNow) return { kind: "seen" };
  if (!sourceHealthy) return { kind: "hold" };
  const missing = a.missing_scans + 1;
  if (missing < MISSING_SCANS_TO_END) return { kind: "count", missing };
  return { kind: "end", allClear: a.approved_at !== null };
}

export interface DiversionPlan {
  newBaseline: string | null;
  change: { from: string; to: string } | null;
}

/** Baseline semantics match the WMS watch checks: first sighting sets the
 *  baseline (not a change); a different declared destination after that is a
 *  diversion. */
export function planDiversion(baseline: string | null, currentSlug: string | null): DiversionPlan {
  if (!currentSlug) return { newBaseline: baseline, change: null };
  if (!baseline) return { newBaseline: currentSlug, change: null };
  if (baseline === currentSlug) return { newBaseline: currentSlug, change: null };
  return { newBaseline: currentSlug, change: { from: baseline, to: currentSlug } };
}

/** Deterministic all-clear draft — Mark edits surgically before approving,
 *  so this is a plain honest template, not an AI roll. */
export function draftAllClear(a: { name: string | null; classification: string | null; affected_grounds: string[] }): { headline: string; body_md: string } {
  const name = a.name || "The storm";
  const grounds = labelGrounds(a.affected_grounds) || "the affected cruising grounds";
  return {
    headline: `All clear: ${name} is no longer a threat`.slice(0, 120),
    body_md:
      `**${name}** (${a.classification ?? "tropical system"}) has dissipated and is no longer being tracked by the National Hurricane Center.\n\n` +
      `**What this means for you:** the threat to ${grounds} has passed. Itineraries that were adjusted should settle back to normal — ` +
      `your cruise line has the final word on any remaining changes, so keep an eye on their app for your specific sailing.\n\n` +
      `Thanks for riding it out with us. We watch the tropics year-round, and if anything new spins up, you'll hear from us. Until then — smooth sailing.`,
  };
}

// ── I/O runner ───────────────────────────────────────────────────────────────

interface LifecycleRow {
  id: string;
  nhc_id: string;
  name: string | null;
  classification: string | null;
  status: string;
  is_threat: boolean;
  approved_at: string | null;
  missing_scans: number;
  affected_grounds: string[];
  window_start: string | null;
  window_end: string | null;
}

interface TrackedShipRow {
  id: string;
  ship_name: string;
  baseline_destination: string | null;
  changes: { at: string; from: string | null; to: string; raw: string | null }[];
}

function feedHealthyFor(row: LifecycleRow, snap: SystemsSnapshot): boolean {
  if (row.nhc_id.startsWith("TWO-")) {
    const basin = row.nhc_id.slice(4);
    return snap.outlookOkByBasin[basin] ?? false;
  }
  return snap.currentStormsOk;
}

function portName(slug: string): string {
  return portBySlug(slug)?.name ?? slug;
}

/** Pin impacted ships to the alert and flag AIS diversions. Returns the MMSIs
 *  this alert wants tracked. */
async function syncTrackedShips(row: LifecycleRow): Promise<string[]> {
  const supabase = getSupabase();
  const win = row.window_start && row.window_end
    ? { start: row.window_start, end: row.window_end }
    : defaultWindow();
  const sailings = await sailingsForStorm(row.affected_grounds, win.start, win.end);

  const { data: existingData, error: exErr } = await supabase
    .from("storm_tracked_ships")
    .select("id, ship_name, baseline_destination, changes")
    .eq("alert_id", row.id);
  if (exErr) {
    logger.warn({ err: exErr, alert: row.nhc_id }, "storm-lifecycle: tracked-ships load failed");
    return [];
  }
  const existing = new Map(
    ((existingData ?? []) as unknown as TrackedShipRow[]).map((s) => [s.ship_name.toLowerCase(), s]),
  );

  // Pin newly impacted ships.
  const seenNames = new Set<string>();
  for (const sail of sailings) {
    const key = sail.ship_name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    if (existing.has(key)) continue;
    const { error } = await supabase.from("storm_tracked_ships").insert({
      alert_id: row.id,
      ship_name: sail.ship_name,
      cruise_line: sail.cruise_line,
      mmsi: mmsiForShip(sail.ship_name),
    });
    if (error) logger.warn({ err: error, ship: sail.ship_name }, "storm-lifecycle: pin failed");
    else existing.set(key, { id: "", ship_name: sail.ship_name, baseline_destination: null, changes: [] });
  }

  // Diversion check on everything pinned to this alert.
  const diversions: string[] = [];
  for (const ship of existing.values()) {
    const pos = getPosition(ship.ship_name);
    const plan = planDiversion(ship.baseline_destination, pos?.destinationSlug ?? null);
    if (plan.newBaseline === ship.baseline_destination && !plan.change) continue;
    const changes = plan.change
      ? [...(ship.changes ?? []), { at: new Date().toISOString(), from: plan.change.from, to: plan.change.to, raw: pos?.destinationRaw ?? null }]
      : ship.changes ?? [];
    if (ship.id) {
      const { error } = await supabase.from("storm_tracked_ships")
        .update({ baseline_destination: plan.newBaseline, changes, updated_at: new Date().toISOString() })
        .eq("id", ship.id);
      if (error) logger.warn({ err: error, ship: ship.ship_name }, "storm-lifecycle: baseline update failed");
    }
    if (plan.change) diversions.push(`${ship.ship_name}: ${portName(plan.change.from)} → ${portName(plan.change.to)}`);
  }

  if (diversions.length) {
    // One pending intel action per alert (createAction dedups on source_ref);
    // every diversion is also in storm_tracked_ships.changes for the record.
    await createAction({
      type: "storm_alert",
      source_ref: row.id,
      title: `⚓ Course changes during ${row.name ?? row.nhc_id}`,
      body: `${diversions.join("\n")}\nAIS-declared destinations changed for ships in this storm's grounds — worth a look at the alert.`,
      tag: `storm-ships-${row.nhc_id}`,
    }).catch((err) => logger.warn({ err }, "storm-lifecycle: diversion action failed"));
    logger.info({ alert: row.nhc_id, diversions }, "storm-lifecycle: diversions flagged");
  }

  return [...existing.values()]
    .map((s) => mmsiForShip(s.ship_name))
    .filter((m): m is string => Boolean(m));
}

async function endAlert(row: LifecycleRow): Promise<void> {
  const supabase = getSupabase();
  const allClear = row.approved_at !== null;
  const draft = allClear ? draftAllClear(row) : null;
  const { error } = await supabase.from("storm_alerts").update({
    status: "ended",
    ended_at: new Date().toISOString(),
    missing_scans: MISSING_SCANS_TO_END,
    last_updated: new Date().toISOString(),
    ...(draft ? { all_clear_headline: draft.headline, all_clear_body_md: draft.body_md } : {}),
  }).eq("id", row.id);
  if (error) {
    logger.error({ err: error, alert: row.nhc_id }, "storm-lifecycle: end update failed");
    return;
  }

  // Stale review nudges are moot now.
  await resolveActionsForSource("storm_alert", row.id, "dismissed");

  if (draft) {
    await createAction({
      type: "storm_alert",
      source_ref: row.id,
      title: `🟢 ${row.name ?? row.nhc_id} has dissipated — review the all-clear`,
      body: `${draft.headline}\nApprove to email the all-clear to alert subscribers; skip if you'd rather close it quietly. Nothing sends until you act.`,
      buttons: [
        { label: "✅ Send all-clear", method: "POST", path: `/api/storm-alerts/${row.id}/all-clear` },
        { label: "✕ Skip", method: "POST", path: `/api/storm-alerts/${row.id}/all-clear-skip` },
      ],
      tag: `storm-allclear-${row.nhc_id}`,
    }).catch((err) => logger.warn({ err }, "storm-lifecycle: all-clear action failed"));
  }
  logger.info({ alert: row.nhc_id, allClear }, "storm-lifecycle: storm ended");
}

export interface LifecycleResult { tracked: number; ended: number; }

/** One lifecycle pass, run right after each storm scan. */
export async function runStormLifecycle(snap: SystemsSnapshot): Promise<LifecycleResult> {
  const supabase = getSupabase();
  const result: LifecycleResult = { tracked: 0, ended: 0 };

  const { data, error } = await supabase
    .from("storm_alerts")
    .select("id, nhc_id, name, classification, status, is_threat, approved_at, missing_scans, affected_grounds, window_start, window_end")
    .in("status", ["draft", "approved", "sent"]);
  if (error) {
    logger.error({ err: error }, "storm-lifecycle: alert load failed");
    return result;
  }

  const seenIds = new Set(snap.systems.map((s) => s.nhcId));
  const stormMmsis: string[] = [];

  for (const row of (data ?? []) as unknown as LifecycleRow[]) {
    try {
      const verdict = judgeDeath(row, seenIds.has(row.nhc_id), feedHealthyFor(row, snap));
      if (verdict.kind === "seen") {
        if (row.missing_scans > 0) {
          await supabase.from("storm_alerts").update({ missing_scans: 0 }).eq("id", row.id);
        }
        // Live named threats get their impacted ships pinned + diversion-checked.
        if (row.is_threat && severityRank(row.classification) >= 2) {
          const mmsis = await syncTrackedShips(row);
          stormMmsis.push(...mmsis);
          result.tracked += mmsis.length;
        }
      } else if (verdict.kind === "count") {
        await supabase.from("storm_alerts").update({ missing_scans: verdict.missing }).eq("id", row.id);
      } else if (verdict.kind === "end") {
        await endAlert(row);
        result.ended++;
      } // hold → nothing
    } catch (err) {
      logger.error({ err, alert: row.nhc_id }, "storm-lifecycle: alert pass failed");
    }
  }

  // Ended/absent storms release their ships automatically: the set is rebuilt
  // from live alerts every pass.
  await setStormShips(stormMmsis);
  return result;
}
