// storm-lifecycle.ts — the storm's life after the first alert (Mark's design
// 2026-07-22, task 3c349235 follow-on; course-change detection rebuilt 2026-09-05):
//
//   • impacted ships (date+itinerary matched) are pinned to the alert and
//     AIS-tracked for the storm's lifetime — even ships outside the normal
//     tracked set (ship-tracker rank-0 storm priority);
//   • REAL course changes on those ships — a mid-leg re-route, a port the ship
//     never calls at, or a swapped port order during a named storm — raise ONE
//     event per ship movement (not one per storm: a ship sits in several
//     storms' grounds at once), with operator/news intel attached and a
//     three-way nudge: Publish / Open storm dashboard / Ignore. Scheduled port
//     rotation is NOT a course change — storm-diversion.ts carries the
//     22-for-22 false-positive history that forced this rebuild;
//   • when the storm is dead (gone from a HEALTHY feed for 3 consecutive
//     scans) the alert ends on its own: it drops off the website, its ship
//     pins are released (other live storms keep theirs), its open course-change
//     nudges are dismissed, and — for alerts that were approved/sent — the
//     all-clear email goes to subscribers AUTONOMOUSLY (Mark, 2026-09-05: "the
//     all clear should be autonomous"). Mark gets a push saying it went out.
//     DISABLE_STORM_ALLCLEAR_AUTOSEND=1 (set on the DEV box, whose database
//     mirrors prod's subscriber list) falls back to the one-click gated draft.
//
// Pure decision helpers are at the top (unit-tested in storm-lifecycle.test.ts);
// the I/O runner is below.

import { getSupabase } from "./persistence";
import { logger } from "./logger";
import { resolveActionsForSource, createAction } from "./actions";
import { notifyMark } from "./notify";
import { emailAllClear } from "./storm-send";
import { sailingsForStorm, deploymentsForStorm, defaultWindow, type Sailing } from "./storm-sailings";
import { severityRank } from "./storm-escalation";
import { setStormShips, mmsiForShip, getPosition, trackerObservedSince } from "./ship-tracker";
import { labelGrounds } from "./storm-grounds";
import { portBySlug, CRUISE_LOCATIONS } from "./ports";
import { classifyDestinationChange, EVENT_KINDS, type ChangeKind } from "./storm-diversion";
import { recordDiversionEvents, releaseAlertDiversions, type PendingDiversion } from "./storm-diversion-events";
import type { SystemsSnapshot } from "./storm-source";

export const MISSING_SCANS_TO_END = 3;
const MAX_CHANGES_KEPT = 60;

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

/** Autonomous all-clear unless explicitly disabled (dev box). Pure; tested. */
export function allClearMode(env: Record<string, string | undefined> = process.env): "auto" | "gated" {
  return env["DISABLE_STORM_ALLCLEAR_AUTOSEND"] === "1" ? "gated" : "auto";
}

/** Slug for a port named the way `sailings.depart_port` / deployments name it. */
export function portSlugByName(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  const hit = CRUISE_LOCATIONS.find((p) => p.name.toLowerCase() === n || p.slug === n);
  return hit?.slug ?? null;
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
  cruise_line: string | null;
  mmsi: string | null;
  baseline_destination: string | null;
  baseline_declared_at: string | null;
  changes: { at: string; from: string | null; to: string; raw: string | null; kind?: ChangeKind; reason?: string }[];
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

/** Pin impacted ships to the alert and classify AIS destination changes.
 *  Returns the MMSIs this alert wants tracked plus any REAL course changes. */
async function syncTrackedShips(row: LifecycleRow): Promise<{ mmsis: string[]; detections: PendingDiversion[] }> {
  const supabase = getSupabase();
  const win = row.window_start && row.window_end
    ? { start: row.window_start, end: row.window_end }
    : defaultWindow();
  const derived = await sailingsForStorm(row.affected_grounds, win.start, win.end);
  // Forward deployments fill in ships whose current AIS sailing isn't derived yet;
  // AIS-derived rows win on conflict (they're date-precise, deployments are seasonal).
  const deployed = await deploymentsForStorm(row.affected_grounds, win.start, win.end);
  const seen = new Set(derived.map((x) => x.ship_name.toLowerCase()));
  const sailings: Sailing[] = derived.concat(deployed.filter((x) => !seen.has(x.ship_name.toLowerCase())));

  const { data: existingData, error: exErr } = await supabase
    .from("storm_tracked_ships")
    .select("id, ship_name, cruise_line, mmsi, baseline_destination, baseline_declared_at, changes")
    .eq("alert_id", row.id)
    .is("released_at", null);
  if (exErr) {
    logger.warn({ err: exErr, alert: row.nhc_id }, "storm-lifecycle: tracked-ships load failed");
    return { mmsis: [], detections: [] };
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
    else existing.set(key, {
      id: "", ship_name: sail.ship_name, cruise_line: sail.cruise_line, mmsi: mmsiForShip(sail.ship_name),
      baseline_destination: null, baseline_declared_at: null, changes: [],
    });
  }

  // Course-change check on everything pinned to this alert.
  const detections: PendingDiversion[] = [];
  const now = new Date().toISOString();
  const observedSince = trackerObservedSince();
  for (const ship of existing.values()) {
    const pos = getPosition(ship.ship_name);
    const key = ship.ship_name.toLowerCase();
    const knownExtra = sailings
      .filter((s) => s.ship_name.toLowerCase() === key)
      .map((s) => portSlugByName(s.depart_port))
      .filter((s): s is string => Boolean(s));
    const verdict = classifyDestinationChange({
      baseline: ship.baseline_destination,
      baselineDeclaredAt: ship.baseline_declared_at,
      current: pos?.destinationSlug ?? null,
      now,
      inPortSlug: pos?.inPortSlug ?? null,
      lastPortSlug: pos?.lastPortSlug ?? null,
      lastPortDepartedAt: pos?.lastPortDepartedAt ?? null,
      lastPosAt: pos?.lastPosAt ?? null,
      portCalls: pos?.portCalls ?? [],
      knownExtra,
      observedSince,
    });
    const baselineMoved = verdict.newBaseline !== ship.baseline_destination;
    if (!baselineMoved && !verdict.change) continue;

    const changes = verdict.change
      ? [...(ship.changes ?? []), {
          at: now, from: verdict.change.from, to: verdict.change.to,
          raw: pos?.destinationRaw ?? null, kind: verdict.kind, reason: verdict.reason,
        }].slice(-MAX_CHANGES_KEPT)
      : ship.changes ?? [];
    if (ship.id) {
      const { error } = await supabase.from("storm_tracked_ships")
        .update({
          baseline_destination: verdict.newBaseline,
          baseline_declared_at: verdict.newBaselineDeclaredAt,
          changes,
          updated_at: now,
        })
        .eq("id", ship.id);
      if (error) logger.warn({ err: error, ship: ship.ship_name }, "storm-lifecycle: baseline update failed");
    }
    if (verdict.change && EVENT_KINDS.has(verdict.kind)) {
      detections.push({
        shipName: ship.ship_name,
        cruiseLine: ship.cruise_line,
        mmsi: ship.mmsi ?? mmsiForShip(ship.ship_name),
        kind: verdict.kind,
        from: verdict.change.from,
        to: verdict.change.to,
        raw: pos?.destinationRaw ?? null,
        at: now,
        reason: verdict.reason,
        alertId: row.id,
        stormName: row.name ?? row.nhc_id,
      });
    } else if (verdict.change) {
      logger.debug({ alert: row.nhc_id, ship: ship.ship_name, kind: verdict.kind, from: portName(verdict.change.from), to: portName(verdict.change.to) },
        "storm-lifecycle: destination change, no event");
    }
  }

  const mmsis = [...existing.values()]
    .map((s) => s.mmsi ?? mmsiForShip(s.ship_name))
    .filter((m): m is string => Boolean(m));
  return { mmsis, detections };
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

  // Stale review nudges are moot now; this storm's ship pins and open
  // course-change nudges release for THIS storm only (Mark 2026-09-05).
  await resolveActionsForSource("storm_alert", row.id, "dismissed");
  const released = await releaseAlertDiversions(row.id);

  if (draft && allClearMode() === "auto") {
    // Autonomous: email the all-clear to the same opted-in base the alert went
    // to, stamp the alert, and tell Mark it happened (a push, not a queue row —
    // there is nothing for him to decide). A send failure falls back to the
    // gated draft below so he can retry with one tap.
    try {
      const counts = await emailAllClear({
        id: row.id, name: row.name ?? row.nhc_id, affected_grounds: row.affected_grounds,
        all_clear_headline: draft.headline, all_clear_body_md: draft.body_md,
      });
      await supabase.from("storm_alerts").update({
        all_clear_sent_at: new Date().toISOString(),
        all_clear_sent_count: counts.sent,
        last_updated: new Date().toISOString(),
      }).eq("id", row.id);
      await notifyMark({
        title: `🟢 All-clear sent: ${row.name ?? row.nhc_id} → ${counts.sent} subscriber${counts.sent === 1 ? "" : "s"}`,
        body: `${draft.headline}\nSent automatically when NHC dropped the system` +
          (counts.failed ? ` (${counts.failed} failed — see the dashboard).` : ". Nothing to do."),
        tag: `storm-allclear-${row.nhc_id}`,
      }).catch((err) => logger.warn({ err }, "storm-lifecycle: all-clear notify failed"));
      logger.info({ alert: row.nhc_id, ...counts, ...released }, "storm-lifecycle: storm ended, all-clear sent");
      return;
    } catch (err) {
      logger.error({ err, alert: row.nhc_id }, "storm-lifecycle: autonomous all-clear failed — falling back to the gated draft");
    }
  }

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
  logger.info({ alert: row.nhc_id, allClear, ...released }, "storm-lifecycle: storm ended");
}

export interface LifecycleResult { tracked: number; ended: number; diversions: number; }

/** One lifecycle pass, run right after each storm scan. */
export async function runStormLifecycle(snap: SystemsSnapshot): Promise<LifecycleResult> {
  const supabase = getSupabase();
  const result: LifecycleResult = { tracked: 0, ended: 0, diversions: 0 };

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
  const detections: PendingDiversion[] = [];

  for (const row of (data ?? []) as unknown as LifecycleRow[]) {
    try {
      const verdict = judgeDeath(row, seenIds.has(row.nhc_id), feedHealthyFor(row, snap));
      if (verdict.kind === "seen") {
        if (row.missing_scans > 0) {
          await supabase.from("storm_alerts").update({ missing_scans: 0 }).eq("id", row.id);
        }
        // Live named threats get their impacted ships pinned + course-change-checked.
        if (row.is_threat && severityRank(row.classification) >= 2) {
          const synced = await syncTrackedShips(row);
          stormMmsis.push(...synced.mmsis);
          detections.push(...synced.detections);
          result.tracked += synced.mmsis.length;
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

  // One event per ship movement across every storm it sits in.
  if (detections.length) {
    try {
      result.diversions = await recordDiversionEvents(detections);
    } catch (err) {
      logger.error({ err }, "storm-lifecycle: diversion recording failed");
    }
  }

  // Ended/absent storms release their ships automatically: the set is rebuilt
  // from live alerts every pass.
  await setStormShips(stormMmsis);
  return result;
}
