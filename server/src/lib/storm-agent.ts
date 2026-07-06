// storm-agent.ts — the storm-alert brain.
//
// Scan NHC → map each system to cruising grounds → dedup against storm_alerts →
// draft the "what this means for you" copy (OpenAI) → upsert as a review draft →
// nudge Mark (Web Push + email approve links). Nothing is sent to subscribers
// here — that only happens on explicit approval (see routes/storm.ts + storm-send).

import * as crypto from "crypto";
import { getSupabase } from "./persistence";
import { logger } from "./logger";
import { createAction } from "./actions";
import { fetchSystems, fixtureSystem, basinGraphics, type RawSystem } from "./storm-source";
import { defaultWindow } from "./storm-sailings";
import {
  groundsForPoint, groundsForBasin, shipsForGrounds, labelGrounds, type Ship,
} from "./storm-grounds";

export interface DraftContent { headline: string; body_md: string; }

function groundsFor(sys: RawSystem): string[] {
  if (sys.lat != null && sys.lon != null) {
    const pt = groundsForPoint(sys.lat, sys.lon);
    if (pt.length) return pt;
  }
  // No usable coordinates (e.g. an outlook disturbance) → basin-level grounds.
  return groundsForBasin(sys.basin);
}

function hashSystem(sys: RawSystem, grounds: string[]): string {
  const key = [sys.nhcId, sys.classification, sys.intensity ?? "", sys.formationChance ?? "",
    grounds.slice().sort().join("|")].join("::");
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
}

const SYSTEM_PROMPT = `You write short tropical-weather alerts for a cruise-travel brand ("Still Afloat").
Voice: the experienced friend who tells the truth — calm, grounded, practical, never hype or fear-mongering.
You are given one tropical system and the cruising grounds it may affect. Write a subscriber alert.
Return JSON: {"headline": string, "body_md": string}.
- headline: <= 80 chars, plain and specific (system name + what/where). No emoji spam.
- body_md: 2-4 short paragraphs, markdown. MUST include a clearly-worded "What this means for you" that ties
  the system to the affected cruising grounds and approximate timing, and sets expectations (itineraries can be
  rerouted/rescheduled; the cruise line decides; we'll keep you posted). Do NOT invent specific ship names,
  exact dates, or wind numbers beyond what you are given. If it's only a disturbance/low chance, say so plainly.`;

async function draft(sys: RawSystem, grounds: string[]): Promise<DraftContent> {
  const apiKey = process.env["OPENAI_API_KEY"];
  const groundsLabel = labelGrounds(grounds) || "open water (no cruising grounds directly in the path yet)";
  const facts = [
    `Name/label: ${sys.name}`,
    `Classification: ${sys.classification}`,
    sys.intensity ? `Intensity: ${sys.intensity}` : "",
    sys.movement ? `Movement: ${sys.movement}` : "",
    sys.formationChance != null ? `Formation chance: ${sys.formationChance}%` : "",
    sys.lat != null && sys.lon != null ? `Position: ${sys.lat}, ${sys.lon}` : "",
    `Basin: ${sys.basin}`,
    `Affected cruising grounds: ${groundsLabel}`,
    sys.outlookText ? `NHC outlook text: ${sys.outlookText}` : "",
  ].filter(Boolean).join("\n");

  // Graceful fallback if no AI key is configured — a plain, honest draft.
  if (!apiKey) {
    return {
      headline: `${sys.name}: watching ${labelGrounds(grounds) || sys.basin}`,
      body_md: `**${sys.name}** (${sys.classification}) is being monitored in the ${sys.basin.replace(/_/g, " ")} basin.\n\n` +
        `**What this means for you:** if you're sailing ${groundsLabel} in the coming days, itineraries could be ` +
        `adjusted or rerouted at the cruise line's discretion. Nothing to do right now — we'll keep you posted as the forecast firms up.`,
    };
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: facts },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = (await res.json()) as any;
  const content: string = payload?.choices?.[0]?.message?.content ?? "";
  const parsed = JSON.parse(content) as Partial<DraftContent>;
  return {
    headline: (parsed.headline ?? `${sys.name}: ${labelGrounds(grounds)}`).slice(0, 120),
    body_md: parsed.body_md ?? "",
  };
}

interface ScanResult { scanned: number; drafted: number; updated: number; skipped: number; }

/** One full scan cycle. `opts.test` injects a fixture system so the pipeline can
 *  be exercised off-season / for the demo without waiting on real weather. */
export async function runStormScan(opts: { test?: boolean } = {}): Promise<ScanResult> {
  const supabase = getSupabase();
  const systems = opts.test ? [fixtureSystem()] : await fetchSystems();
  const result: ScanResult = { scanned: systems.length, drafted: 0, updated: 0, skipped: 0 };

  for (const sys of systems) {
    try {
      const grounds = groundsFor(sys);
      const isThreat = grounds.length > 0;
      const contentHash = hashSystem(sys, grounds);

      const { data: existing } = await supabase
        .from("storm_alerts").select("id, status, content_hash").eq("nhc_id", sys.nhcId).maybeSingle();

      // Unchanged system we've already seen → just touch last_updated.
      if (existing && (existing as { content_hash?: string }).content_hash === contentHash) {
        await supabase.from("storm_alerts").update({ last_updated: new Date().toISOString() })
          .eq("id", (existing as { id: string }).id);
        result.skipped++;
        continue;
      }

      const status = (existing as { status?: string } | null)?.status;
      // Don't resurrect an alert Mark already dismissed or already sent — just
      // refresh its raw data. New material change on a live draft → re-draft.
      const reDraftable = !existing || status === "draft";
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
        satellite_url: gfx.satellite,
        last_updated: new Date().toISOString(),
        ...(content ? { headline: content.headline, body_md: content.body_md, status: "draft" } : {}),
      };

      let alertId = (existing as { id?: string } | null)?.id ?? "";
      if (existing) {
        await supabase.from("storm_alerts").update(row).eq("id", alertId);
        result.updated++;
      } else {
        const ins = await supabase.from("storm_alerts").insert(row).select("id").single();
        alertId = (ins.data as { id?: string } | null)?.id ?? "";
        result.drafted++;
      }

      // Nudge Mark to review — Web Push + email approve/dismiss links — for fresh/updated drafts.
      if (reDraftable && isThreat) {
        await notifyReview(sys, grounds, content?.headline ?? sys.name, alertId);
      }
    } catch (err) {
      logger.error({ err, nhcId: sys.nhcId }, "storm-agent: system failed");
    }
  }

  logger.info(result, "storm-agent: scan complete");
  return result;
}

async function notifyReview(sys: RawSystem, grounds: string[], headline: string, alertId: string): Promise<void> {
  // ONE pipeline: an action row in public.actions → exactly one notification →
  // Mark approves/dismisses inline in the brief (or the notification buttons).
  // No email. No ad-hoc push. (Mark's directive 2026-07-06.)
  try {
    await createAction({
      type: "storm_alert",
      source_ref: alertId,
      title: `🌀 Review storm alert: ${sys.name}`,
      body: `${sys.classification} · ${labelGrounds(grounds)}\n${headline}\nApprove emails subscribers; nothing goes out until you act.`,
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
