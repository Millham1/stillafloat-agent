// routes/storm.ts — storm-alert API.
//   Dashboard (token-gated): queue, edit, approve→send, dismiss, manual scan.
//   Email approve links     : GET /storm-alerts/:id/action?do=approve&token=…
//   Public (site panel)     : GET /storm-watch  — active approved/sent systems + ships.

import { Router, type IRouter, type Request, type Response } from "express";
import { getSupabase } from "../lib/persistence";
import { requireToken } from "../lib/http-auth";
import { logger } from "../lib/logger";
import { runStormScan } from "../lib/storm-agent";
import { emailSubscribers, emailAllClear, startAlertSend, subscriberCount, type AlertRow, type AllClearRow } from "../lib/storm-send";
import { labelGrounds, type RegionKey, REGION_LABELS } from "../lib/storm-grounds";
import { sailingsForStorm, deploymentsForStorm, defaultWindow, withTrackable, type TrackableSailing } from "../lib/storm-sailings";
import { inRegistry } from "../lib/ship-tracker";
import { resolveActionsForSource } from "../lib/actions";
import {
  publishDiversion, ignoreDiversion, releaseAlertDiversions, listPendingDiversions, simulateDiversion,
} from "../lib/storm-diversion-events";
import { loadDiversionLog, clampDays } from "../lib/storm-diversion-log";

const router: IRouter = Router();

interface DbAlert extends AlertRow {
  basin: string | null; classification: string | null; status: string;
  is_threat: boolean; formation_chance: number | null; last_updated: string;
  sent_at: string | null; sent_count: number;
  window_start: string | null; window_end: string | null;
  cone_url: string | null; satellite_url: string | null;
  cruise_line_info: unknown; detail_md: string | null;
}

/** Impacted sailings for an alert (date + region aware), using its forecast window. Each
 *  carries `trackable`, so the storm pages can put a "Track this ship" link beside it. */
async function impactedSailings(a: DbAlert): Promise<TrackableSailing[]> {
  const w = a.window_start && a.window_end
    ? { start: a.window_start, end: a.window_end }
    : defaultWindow();
  const derived = await sailingsForStorm(a.affected_grounds, w.start, w.end);
  const deployed = await deploymentsForStorm(a.affected_grounds, w.start, w.end);
  const seen = new Set(derived.map((x) => x.ship_name.toLowerCase()));
  return withTrackable(derived.concat(deployed.filter((x) => !seen.has(x.ship_name.toLowerCase()))), inRegistry);
}

// ── Dashboard queue ──────────────────────────────────────────────────────────
router.get("/storm-alerts", requireToken, async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("storm_alerts")
      .select("*")
      .neq("status", "dismissed")
      .order("last_updated", { ascending: false });
    if (error) throw error;
    const alerts = (data ?? []) as unknown as DbAlert[];
    // Open course changes ride along so the dashboard shows them BEFORE publish.
    const pendingDiversions = await listPendingDiversions(alerts.map((a) => a.id));
    const withShips = await Promise.all(alerts.map(async (a) => ({
      ...a,
      grounds_label: labelGrounds(a.affected_grounds),
      sailings: await impactedSailings(a),
      diversions: pendingDiversions.filter((d) => d.alert_ids.includes(a.id)),
    })));
    res.json({ success: true, alerts: withShips });
  } catch (err) {
    logger.error({ err }, "GET /storm-alerts failed");
    res.status(500).json({ success: false, error: "Failed to load alerts" });
  }
});

// ── Edit a draft (headline / body) ───────────────────────────────────────────
router.patch("/storm-alerts/:id", requireToken, async (req: Request, res: Response) => {
  try {
    const { headline, body_md, detail_md, cruise_line_info, all_clear_headline, all_clear_body_md } = req.body ?? {};
    const patch: Record<string, unknown> = { last_updated: new Date().toISOString() };
    if (typeof headline === "string") patch["headline"] = headline.slice(0, 120);
    if (typeof body_md === "string") patch["body_md"] = body_md;
    if (typeof detail_md === "string") patch["detail_md"] = detail_md;
    if (Array.isArray(cruise_line_info)) patch["cruise_line_info"] = cruise_line_info;
    if (typeof all_clear_headline === "string") patch["all_clear_headline"] = all_clear_headline.slice(0, 120);
    if (typeof all_clear_body_md === "string") patch["all_clear_body_md"] = all_clear_body_md;
    const supabase = getSupabase();
    const { error } = await supabase.from("storm_alerts").update(patch).eq("id", (req.params["id"] ?? ""));
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "PATCH /storm-alerts failed");
    res.status(500).json({ success: false, error: "Failed to save" });
  }
});

// ── Approve → email subscribers ──────────────────────────────────────────────
/**
 * Approve = claim the alert and START the paced send; the caller gets an answer at once.
 * 2026-09-24: the old version awaited the ~7.5-minute send and guarded only on
 * status "sent", so a second click a minute later sent everything again (Fay).
 * The row is flipped to "sending" atomically (WHERE status not in sending/sent);
 * whoever loses that update sends nothing. A failed send drops back to "approved"
 * so it can be retried; a finished one becomes "sent" with the real count.
 */
type ApproveOutcome =
  | { state: "sending"; total: number }
  | { state: "already_sent"; sent: number }
  | { state: "already_sending" };

async function approveAndSend(id: string): Promise<ApproveOutcome> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("storm_alerts").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  const alert = data as unknown as DbAlert | null;
  if (!alert) throw new Error("not found");
  if (alert.status === "sent") return { state: "already_sent", sent: alert.sent_count ?? 0 };
  if (alert.status === "sending") return { state: "already_sending" };
  const total = await subscriberCount();
  const now = () => new Date().toISOString();
  const state = await startAlertSend(id, {
    claim: async (alertId) => {
      const { data: won, error: claimErr } = await supabase.from("storm_alerts")
        .update({ status: "sending", approved_at: now(), last_updated: now() })
        .eq("id", alertId).not("status", "in", '("sending","sent")').select("id");
      if (claimErr) throw claimErr;
      return (won?.length ?? 0) > 0;
    },
    send: () => emailSubscribers(alert),
    markSent: async (counts) => {
      await supabase.from("storm_alerts").update({
        status: "sent", sent_at: now(), sent_count: counts.sent, last_updated: now(),
      }).eq("id", id);
      await resolveActionsForSource("storm_alert", id, "done");
    },
    markFailed: async () => {
      await supabase.from("storm_alerts").update({ status: "approved", last_updated: now() }).eq("id", id);
    },
  });
  return state === "started" ? { state: "sending", total } : { state: "already_sending" };
}

router.post("/storm-alerts/:id/approve", requireToken, async (req: Request, res: Response) => {
  try {
    const out = await approveAndSend((req.params["id"] ?? ""));
    if (out.state === "sending") { res.status(202).json({ success: true, sending: true, total: out.total, sent: 0, failed: 0 }); return; }
    if (out.state === "already_sending") { res.status(409).json({ success: false, error: "This alert is already going out — one email every 45 seconds, about 8 minutes for the whole list." }); return; }
    res.json({ success: true, alreadySent: true, sent: out.sent, failed: 0, total: out.sent });
  } catch (err) {
    logger.error({ err }, "approve failed");
    res.status(500).json({ success: false, error: "Approve failed" });
  }
});

router.post("/storm-alerts/:id/dismiss", requireToken, async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from("storm_alerts").update({ status: "dismissed" }).eq("id", (req.params["id"] ?? ""));
    if (error) throw error;
    await resolveActionsForSource("storm_alert", req.params["id"] ?? "", "dismissed");
    await releaseAlertDiversions(req.params["id"] ?? ""); // this storm's pins + open nudges only
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "dismiss failed");
    res.status(500).json({ success: false, error: "Dismiss failed" });
  }
});

// ── All-clear (storm lifecycle): approval-gated send + skip ──────────────────
router.post("/storm-alerts/:id/all-clear", requireToken, async (req: Request, res: Response) => {
  try {
    const id = req.params["id"] ?? "";
    const supabase = getSupabase();
    const { data, error } = await supabase.from("storm_alerts").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    const alert = data as unknown as (DbAlert & {
      ended_at: string | null; all_clear_headline: string | null;
      all_clear_body_md: string | null; all_clear_sent_at: string | null;
    }) | null;
    if (!alert) { res.status(404).json({ success: false, error: "not found" }); return; }
    if (alert.status !== "ended") { res.status(409).json({ success: false, error: "Alert has not ended" }); return; }
    if (alert.all_clear_sent_at) { res.json({ success: true, sent: 0, alreadySent: true }); return; }
    if (!alert.all_clear_headline) { res.status(422).json({ success: false, error: "No all-clear draft on this alert" }); return; }

    // Same one-send guard as approve: answer now, send in the background. The
    // all-clear has no status column of its own, so the claim re-checks
    // all_clear_sent_at and the in-process lock covers the send window.
    const total = await subscriberCount();
    const state = await startAlertSend(`${id}:all-clear`, {
      claim: async () => {
        const { data: fresh } = await supabase.from("storm_alerts").select("all_clear_sent_at").eq("id", id).maybeSingle();
        return !(fresh as { all_clear_sent_at?: string | null } | null)?.all_clear_sent_at;
      },
      send: () => emailAllClear(alert as unknown as AllClearRow),
      markSent: async (counts) => {
        await supabase.from("storm_alerts").update({
          all_clear_sent_at: new Date().toISOString(),
          all_clear_sent_count: counts.sent,
          last_updated: new Date().toISOString(),
        }).eq("id", id);
        await resolveActionsForSource("storm_alert", id, "done");
      },
      markFailed: async () => { /* nothing stamped, so the button simply works again */ },
    });
    if (state === "started") res.status(202).json({ success: true, sending: true, total, sent: 0, failed: 0 });
    else res.status(409).json({ success: false, error: "The all-clear is already going out." });
  } catch (err) {
    logger.error({ err }, "all-clear send failed");
    res.status(500).json({ success: false, error: "All-clear send failed" });
  }
});

router.post("/storm-alerts/:id/all-clear-skip", requireToken, async (req: Request, res: Response) => {
  try {
    const id = req.params["id"] ?? "";
    const supabase = getSupabase();
    const { error } = await supabase.from("storm_alerts")
      .update({ all_clear_skipped_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
    await resolveActionsForSource("storm_alert", id, "dismissed");
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "all-clear skip failed");
    res.status(500).json({ success: false, error: "All-clear skip failed" });
  }
});

// ── Email approve/dismiss links (token via ?token=) ──────────────────────────
// requireToken accepts the ?token= query param, so these links work from email.
router.get("/storm-alerts/:id/action", requireToken, async (req: Request, res: Response) => {
  const doAction = String(req.query["do"] ?? "");
  try {
    if (doAction === "approve") {
      const out = await approveAndSend((req.params["id"] ?? ""));
      const msg = out.state === "sending"
        ? `✅ Alert approved. It is going out to ${out.total} subscriber(s) now, one email every 45 seconds.`
        : out.state === "already_sending" ? "This alert is already going out." : `Already sent to ${out.sent} subscriber(s).`;
      res.type("html").send(`<p>${msg}</p>`);
      return;
    }
    if (doAction === "dismiss") {
      const supabase = getSupabase();
      await supabase.from("storm_alerts").update({ status: "dismissed" }).eq("id", (req.params["id"] ?? ""));
      res.type("html").send("<p>Alert dismissed.</p>");
      return;
    }
    res.status(400).type("html").send("<p>Unknown action.</p>");
  } catch (err) {
    logger.error({ err }, "email action failed");
    res.status(500).type("html").send("<p>Action failed.</p>");
  }
});

// ── Manual scan trigger (also called by the scheduler) ───────────────────────
router.post("/storm-scan", requireToken, async (req: Request, res: Response) => {
  try {
    const test = req.query["test"] === "1" || req.body?.test === true;
    const result = await runStormScan({ test });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "storm-scan failed");
    res.status(500).json({ success: false, error: "Scan failed" });
  }
});

// ── Public Storm Watch panel data ────────────────────────────────────────────
router.get("/storm-watch", async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("storm_alerts")
      .select("id, name, classification, basin, headline, body_md, affected_grounds, formation_chance, is_threat, last_updated, status, window_start, window_end, cone_url, satellite_url, cruise_line_info, detail_md, sent_at, sent_count")
      .in("status", ["approved", "sent"])
      .eq("is_threat", true)
      .order("last_updated", { ascending: false });
    if (error) throw error;
    const rows = (data ?? []) as unknown as DbAlert[];
    const systems = await Promise.all(rows.map(async (a) => ({
      id: a.id,
      name: a.name,
      classification: a.classification,
      headline: a.headline,
      body_md: a.body_md,
      grounds: a.affected_grounds,
      grounds_label: labelGrounds(a.affected_grounds),
      formation_chance: a.formation_chance,
      updated: a.last_updated,
      detail_url: `/storm-watch.html?id=${a.id}`,
      sailings: await impactedSailings(a),
    })));
    // Cache a little at the edge; this is public, low-cardinality data.
    res.set("Cache-Control", "public, max-age=300");
    res.json({ success: true, systems, regions: REGION_LABELS as Record<RegionKey, string> });
  } catch (err) {
    logger.error({ err }, "GET /storm-watch failed");
    res.status(500).json({ success: false, error: "Failed to load storm watch" });
  }
});

// ── Public detail (the "More details" page data) ─────────────────────────────
router.get("/storm-watch/:id", async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("storm_alerts").select("*").eq("id", (req.params["id"] ?? "")).maybeSingle();
    if (error) throw error;
    const a = data as unknown as DbAlert | null;
    if (!a || !["approved", "sent"].includes(a.status)) {
      res.status(404).json({ success: false, error: "not found" });
      return;
    }
    res.set("Cache-Control", "public, max-age=300");
    res.json({
      success: true,
      system: {
        id: a.id, name: a.name, classification: a.classification, basin: a.basin,
        headline: a.headline, body_md: a.body_md, detail_md: a.detail_md,
        grounds: a.affected_grounds, grounds_label: labelGrounds(a.affected_grounds),
        formation_chance: a.formation_chance, updated: a.last_updated,
        window_start: a.window_start, window_end: a.window_end,
        cone_url: a.cone_url, satellite_url: a.satellite_url,
        cruise_line_info: Array.isArray(a.cruise_line_info) ? a.cruise_line_info : [],
        sailings: await impactedSailings(a),
      },
    });
  } catch (err) {
    logger.error({ err }, "GET /storm-watch/:id failed");
    res.status(500).json({ success: false, error: "Failed to load storm detail" });
  }
});

// ── Course changes (storm-diversion-events): Publish / Ignore / dev simulate ──
// Mark's three-way nudge (2026-09-05). Publish appends the change to every
// affected alert's advisories card (public detail page + dashboard); it never
// emails anyone. Both endpoints resolve the brief action themselves.

// The running list (Mark, 2026-09-26): every destination change the detector
// saw on a storm-pinned ship in the window — routine moves and swaps included —
// with its review-queue event attached where one exists. Registered before the
// /:id routes so "log" can never be read as an event id. ?days=1..180 (default 30).
router.get("/storm-diversions/log", requireToken, async (req: Request, res: Response) => {
  try {
    const log = await loadDiversionLog(clampDays(req.query["days"]));
    res.json({ success: true, ...log });
  } catch (err) {
    logger.error({ err }, "GET /storm-diversions/log failed");
    res.status(500).json({ success: false, error: "Failed to load the diversion log" });
  }
});

router.post("/storm-diversions/:id/publish", requireToken, async (req: Request, res: Response) => {
  try {
    const r = await publishDiversion(req.params["id"] ?? "");
    if (!r.published) { res.status(r.reason === "not found" ? 404 : 409).json({ success: false, error: r.reason }); return; }
    res.json({ success: true, alerts: r.alerts, watchersEmailed: r.watchersEmailed });
  } catch (err) {
    logger.error({ err }, "diversion publish failed");
    res.status(500).json({ success: false, error: "Publish failed" });
  }
});

router.post("/storm-diversions/:id/ignore", requireToken, async (req: Request, res: Response) => {
  try {
    await ignoreDiversion(req.params["id"] ?? "");
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "diversion ignore failed");
    res.status(500).json({ success: false, error: "Ignore failed" });
  }
});

// Dev-box only (STORM_DIVERSION_SIM=1): fabricate one course change for a live
// alert so the nudge → buttons → publish → public page path can be exercised
// end to end without waiting for a ship to actually divert.
router.post("/storm-diversions/simulate", requireToken, async (req: Request, res: Response) => {
  if (process.env["STORM_DIVERSION_SIM"] !== "1") { res.status(404).json({ success: false, error: "not enabled" }); return; }
  try {
    const body = (req.body ?? {}) as { shipName?: string; cruiseLine?: string; kind?: "reroute" | "new_port" | "order_change"; from?: string; to?: string; alertId?: string };
    if (!body.alertId) { res.status(400).json({ success: false, error: "alertId required" }); return; }
    const supabase = getSupabase();
    const { data } = await supabase.from("storm_alerts").select("id, name, nhc_id").eq("id", body.alertId).maybeSingle();
    const alert = data as { id: string; name: string | null; nhc_id: string } | null;
    if (!alert) { res.status(404).json({ success: false, error: "alert not found" }); return; }
    const created = await simulateDiversion({
      shipName: body.shipName ?? "Navigator of the Seas",
      ...(body.cruiseLine ? { cruiseLine: body.cruiseLine } : {}),
      ...(body.kind ? { kind: body.kind } : {}),
      ...(body.from ? { from: body.from } : {}),
      ...(body.to ? { to: body.to } : {}),
      alertId: alert.id,
      stormName: alert.name ?? alert.nhc_id,
    });
    res.json({ success: true, created });
  } catch (err) {
    logger.error({ err }, "diversion simulate failed");
    res.status(500).json({ success: false, error: "Simulate failed" });
  }
});

export default router;
