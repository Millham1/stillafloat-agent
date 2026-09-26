// storm-agent.ts — the storm-alert brain.
//
// Scan NHC → map each system to cruising grounds → dedup against storm_alerts →
// draft the "what this means for you" copy (Claude) → upsert as a review draft →
// nudge Mark (Web Push + email approve links). Nothing is sent to subscribers
// here — that only happens on explicit approval (see routes/storm.ts + storm-send).

import * as crypto from "crypto";
import { anthropicConfigured, llmJson } from "./llm";
import { getSupabase } from "./persistence";
import { logger } from "./logger";
import { createAction, resolveActionsForSource } from "./actions";
import { fetchSystemsSnapshot, fixtureSystem, basinGraphics, type RawSystem, type SystemsSnapshot } from "./storm-source";
import type { PriorMarineAlert } from "./nws-marine-source";
import { defaultWindow } from "./storm-sailings";
import { planScanAction, type ExistingAlertState } from "./storm-escalation";
import { runStormLifecycle } from "./storm-lifecycle";
import { runStormIntel } from "./storm-intel";
import {
  groundsForPoint, groundsForBasin, shipsForGrounds, labelGrounds, NAMED_STORM_MARGIN_DEG, type Ship,
} from "./storm-grounds";

export interface DraftContent { headline: string; body_md: string; }

/**
 * The cruising grounds one system can affect. A POSITIONED system — anything in
 * CurrentStorms.json: depression, storm, hurricane, potential cyclone — is judged
 * by where it is: inside a region box or within NAMED_STORM_MARGIN_DEG of one,
 * otherwise nowhere, and "nowhere" means no threat, no draft, no pins. It never
 * inherits a basin's whole list (Mark, 2026-09-26: Gonzalo, 35 mi off Cabo Verde,
 * had been given all six Atlantic regions and 59 pinned ships). Only an outlook
 * disturbance, which has no coordinates yet, falls back to its basin.
 * Exported for tests.
 */
export function groundsFor(sys: Pick<RawSystem, "lat" | "lon" | "basin" | "grounds">): string[] {
  // An NWS marine event arrives with its grounds already decided by which
  // warning zones it touches (nws-marine-source.ts); re-deriving them from the
  // position with the tropical margin would hand a nor'easter Bermuda too.
  if (sys.grounds) return [...sys.grounds];
  if (sys.lat != null && sys.lon != null) return groundsForPoint(sys.lat, sys.lon, NAMED_STORM_MARGIN_DEG);
  return groundsForBasin(sys.basin);
}

function hashSystem(sys: RawSystem, grounds: string[]): string {
  const key = [sys.nhcId, sys.classification, sys.intensity ?? "", sys.formationChance ?? "",
    grounds.slice().sort().join("|")].join("::");
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
}

const SYSTEM_PROMPT = `You write short weather alerts for a cruise-travel brand ("Still Afloat"): tropical systems from the
National Hurricane Center, and non-tropical marine storms (nor'easters, Gulf of Alaska lows) from the NWS Ocean Prediction Center.
Voice: the experienced friend who tells the truth — calm, grounded, practical, never hype or fear-mongering.
You are given one weather system and the cruising grounds it may affect. Write a subscriber alert.
For a non-tropical storm say what it is in plain words (a nor'easter is a strong coastal low, not a hurricane) and
what it usually means for cruisers: rough seas, delayed arrivals/departures, shortened or swapped port calls.
Return JSON: {"headline": string, "body_md": string}.
- headline: <= 80 chars, plain and specific (system name + what/where). No emoji spam.
- body_md: 2-4 short paragraphs, markdown. MUST include a clearly-worded "What this means for you" that ties
  the system to the affected cruising grounds and approximate timing, and sets expectations (itineraries can be
  rerouted/rescheduled; the cruise line decides; we'll keep you posted). Do NOT invent specific ship names,
  exact dates, or wind numbers beyond what you are given. If it's only a disturbance/low chance, say so plainly.`;

// Schema the alert copy must satisfy — was a sentence in SYSTEM_PROMPT
// ("Return JSON: {...}") enforced by nothing; now enforced by the API.
const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "<= 80 chars, plain and specific" },
    body_md: { type: "string", description: "2-4 short markdown paragraphs" },
  },
  required: ["headline", "body_md"],
} as const;

async function draft(sys: RawSystem, grounds: string[]): Promise<DraftContent> {
  const groundsLabel = labelGrounds(grounds) || "open water (no cruising grounds directly in the path yet)";
  const facts = [
    `Name/label: ${sys.name}`,
    `Classification: ${sys.classification}`,
    sys.intensity ? `Intensity: ${sys.intensity}` : "",
    sys.movement ? `Movement: ${sys.movement}` : "",
    sys.formationChance != null ? `Formation chance: ${sys.formationChance}%` : "",
    sys.lat != null && sys.lon != null ? `Position: ${sys.lat}, ${sys.lon}` : "",
    `Basin: ${sys.basin}`,
    `Source: ${sys.source === "nws_marine" ? "NWS Ocean Prediction Center marine warnings (non-tropical)" : sys.source === "manual" ? "declared by hand on the dashboard" : "NOAA National Hurricane Center"}`,
    `Affected cruising grounds: ${groundsLabel}`,
    sys.outlookText ? `Forecast / warning text: ${sys.outlookText}` : "",
  ].filter(Boolean).join("\n");

  // Graceful fallback if no AI key is configured — a plain, honest draft.
  if (!anthropicConfigured()) {
    return {
      headline: `${sys.name}: watching ${labelGrounds(grounds) || sys.basin}`,
      body_md: `**${sys.name}** (${sys.classification}) is being monitored in the ${sys.basin.replace(/_/g, " ")} basin.\n\n` +
        `**What this means for you:** if you're sailing ${groundsLabel} in the coming days, itineraries could be ` +
        `adjusted or rerouted at the cruise line's discretion. Nothing to do right now — we'll keep you posted as the forecast firms up.`,
    };
  }

  const parsed = await llmJson<Partial<DraftContent>>({
    system: SYSTEM_PROMPT,
    user: facts,
    schema: DRAFT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1500,
    timeoutMs: 60_000,
  });
  return {
    headline: (parsed.headline ?? `${sys.name}: ${labelGrounds(grounds)}`).slice(0, 120),
    body_md: parsed.body_md ?? "",
  };
}

interface ScanResult { scanned: number; drafted: number; updated: number; skipped: number; escalated: number; ended: number; }

/** NWS marine alerts from the last two days, so an OPC low with no id of its
 *  own keeps the same alert while it lives (nws-marine-source.matchPrior). */
async function loadPriorMarineAlerts(): Promise<PriorMarineAlert[]> {
  try {
    const since = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const { data, error } = await getSupabase()
      .from("storm_alerts").select("nhc_id, status, last_updated, raw")
      .like("nhc_id", "NWS-%").gte("last_updated", since);
    if (error) throw error;
    return (data ?? []) as unknown as PriorMarineAlert[];
  } catch (err) {
    logger.warn({ err }, "storm-agent: prior NWS alerts unreadable — marine events may re-file under new ids");
    return [];
  }
}

/** One full scan cycle. `opts.test` injects a fixture system so the pipeline can
 *  be exercised off-season / for the demo without waiting on real weather. */
export async function runStormScan(opts: { test?: boolean } = {}): Promise<ScanResult> {
  const supabase = getSupabase();
  const snapshot: SystemsSnapshot = opts.test
    ? { systems: [fixtureSystem()], currentStormsOk: true, outlookOkByBasin: {}, nwsMarineOk: true }
    : await fetchSystemsSnapshot({ priorMarine: await loadPriorMarineAlerts() });
  const systems = snapshot.systems;
  const result: ScanResult = { scanned: systems.length, drafted: 0, updated: 0, skipped: 0, escalated: 0, ended: 0 };

  for (const sys of systems) {
    try {
      const grounds = groundsFor(sys);
      const isThreat = grounds.length > 0;
      const contentHash = hashSystem(sys, grounds);

      const { data: existingData, error: lookupErr } = await supabase
        .from("storm_alerts").select("id, status, content_hash, name, classification")
        .eq("nhc_id", sys.nhcId).maybeSingle();
      if (lookupErr) {
        logger.error({ err: lookupErr, nhcId: sys.nhcId }, "storm-agent: alert lookup failed");
        continue;
      }
      const existing = existingData as ({ id: string } & ExistingAlertState) | null;

      const action = planScanAction(existing, sys, contentHash);

      // Unchanged system we've already seen → just touch last_updated.
      if (action.kind === "touch" && existing) {
        await supabase.from("storm_alerts").update({ last_updated: new Date().toISOString() })
          .eq("id", existing.id);
        result.skipped++;
        continue;
      }

      // Re-draft for new systems, live drafts with material changes, and — the
      // Bertha/Fausto fix — ANY status upgrade (invest → TS → hurricane), even
      // when the previous alert was already sent or dismissed. Escalations put
      // the row back in Mark's review queue; only a same-strength change on a
      // sent/dismissed row stays a silent data refresh.
      const reDraftable = action.kind !== "refresh";
      const content = reDraftable ? await draft(sys, grounds) : null;

      const win = defaultWindow();
      const gfx = basinGraphics(sys.basin);
      const row = {
        nhc_id: sys.nhcId,
        basin: sys.basin,
        name: sys.name,
        classification: sys.classification,
        is_threat: isThreat,
        affected_grounds: grounds,
        formation_chance: sys.formationChance,
        raw: sys.raw as object,
        content_hash: contentHash,
        window_start: win.start,
        window_end: win.end,
        cone_url: sys.coneUrl ?? gfx.outlook,
        satellite_url: sys.satelliteUrl ?? gfx.satellite,
        last_updated: new Date().toISOString(),
        ...(content ? { headline: content.headline, body_md: content.body_md, status: "draft" } : {}),
      };

      let alertId = existing?.id ?? "";
      if (existing) {
        const { error: updErr } = await supabase.from("storm_alerts").update(row).eq("id", alertId);
        if (updErr) {
          logger.error({ err: updErr, nhcId: sys.nhcId }, "storm-agent: alert update failed");
          continue;
        }
        if (action.kind === "escalate") result.escalated++;
        else result.updated++;
      } else {
        const ins = await supabase.from("storm_alerts").insert(row).select("id").single();
        alertId = (ins.data as { id?: string } | null)?.id ?? "";
        if (ins.error || !alertId) {
          logger.error({ err: ins.error, nhcId: sys.nhcId }, "storm-agent: alert insert failed");
          continue;
        }
        result.drafted++;
      }

      // Nudge Mark to review — for fresh drafts, changed drafts, and upgrades.
      if (reDraftable && isThreat) {
        if (action.kind === "escalate") {
          // A stale pending nudge (old name/classification) would suppress the
          // upgrade notification via the actions dedup — supersede it first.
          await resolveActionsForSource("storm_alert", alertId, "dismissed");
          await notifyReview(sys, grounds, content?.headline ?? sys.name, alertId, action);
        } else {
          await notifyReview(sys, grounds, content?.headline ?? sys.name, alertId);
        }
      }
    } catch (err) {
      logger.error({ err, nhcId: sys.nhcId }, "storm-agent: system failed");
    }
  }

  // Lifecycle pass (Mark's design 2026-07-22): impacted-ship tracking +
  // diversion flags, death detection, gated all-clear drafting — then the
  // cruise-line/news intel sweep for live named storms. Both are best-effort;
  // a failure never breaks the core scan. Skipped in fixture/test mode.
  if (!opts.test) {
    try {
      const lifecycle = await runStormLifecycle(snapshot);
      result.ended = lifecycle.ended;
    } catch (err) {
      logger.error({ err }, "storm-agent: lifecycle pass failed");
    }
    try {
      await runStormIntel();
    } catch (err) {
      logger.error({ err }, "storm-agent: intel pass failed");
    }
  }

  logger.info(result, "storm-agent: scan complete");
  return result;
}

async function notifyReview(
  sys: RawSystem,
  grounds: string[],
  headline: string,
  alertId: string,
  escalation?: { from: string; to: string },
): Promise<void> {
  // ONE pipeline: an action row in public.actions → exactly one notification →
  // Mark approves/dismisses inline in the brief (or the notification buttons).
  // No email. No ad-hoc push. (Mark's directive 2026-07-06.)
  try {
    await createAction({
      type: "storm_alert",
      source_ref: alertId,
      title: escalation
        ? `🌀⬆️ Storm upgraded: ${sys.name} is now a ${sys.classification}`
        : `🌀 Review storm alert: ${sys.name}`,
      body: `${escalation ? `UPGRADED ${escalation.from} → ${escalation.to}` : sys.classification} · ${labelGrounds(grounds)}\n${headline}\nApprove emails subscribers; nothing goes out until you act.`,
      buttons: [
        { label: "✅ Approve & send", method: "POST", path: `/api/storm-alerts/${alertId}/approve` },
        { label: "✕ Dismiss", method: "POST", path: `/api/storm-alerts/${alertId}/dismiss` },
      ],
      tag: `storm-${sys.nhcId}`,
    });
  } catch (err) { logger.warn({ err }, "storm-agent: createAction failed"); }
}

/** Ships that sail the grounds an alert affects (for the review card + panel). */
export async function shipsForAlert(grounds: string[]): Promise<Ship[]> {
  return shipsForGrounds(grounds);
}
