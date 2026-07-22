// routes/storm.ts — storm-alert API.
//   Dashboard (token-gated): queue, edit, approve→send, dismiss, manual scan.
//   Email approve links     : GET /storm-alerts/:id/action?do=approve&token=…
//   Public (site panel)     : GET /storm-watch  — active approved/sent systems + ships.

import { Router, type IRouter, type Request, type Response } from "express";
import { getSupabase } from "../lib/persistence";
import { requireToken } from "../lib/http-auth";
import { logger } from "../lib/logger";
import { runStormScan } from "../lib/storm-agent";
import { emailSubscribers, emailAllClear, type AlertRow, type AllClearRow } from "../lib/storm-send";
import { labelGrounds, type RegionKey, REGION_LABELS } from "../lib/storm-grounds";
import { sailingsForStorm, defaultWindow, type Sailing } from "../lib/storm-sailings";
import { resolveActionsForSource } from "../lib/actions";

const router: IRouter = Router();

interface DbAlert extends AlertRow {
  basin: string | null; classification: string | null; status: string;
  is_threat: boolean; formation_chance: number | null; last_updated: string;
  sent_at: string | null; sent_count: number;
  window_start: string | null; window_end: string | null;
  cone_url: string | null; satellite_url: string | null;
  cruise_line_info: unknown; detail_md: string | null;
}

/** Impacted sailings for an alert (date + region aware), using its forecast window. */
async function impactedSailings(a: DbAlert): Promise<Sailing[]> {
  const w = a.window_start && a.window_end
    ? { start: a.window_start, end: a.window_end }
    : defaultWindow();
  return sailingsForStorm(a.affected_grounds, w.start, w.end);
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
    const withShips = await Promise.all(alerts.map(async (a) => ({
      ...a,
      grounds_label: labelGrounds(a.affected_grounds),
      sailings: await impactedSailings(a),
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
async function approveAndSend(id: string): Promise<{ sent: number; failed: number; total: number }> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("storm_alerts").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  const alert = data as unknown as DbAlert | null;
  if (!alert) throw new Error("not found");
  if (alert.status === "sent") return { sent: 0, failed: 0, total: 0 }; // idempotent
  await supabase.from("storm_alerts").update({ status: "approved", approved_at: new Date().toISOString() }).eq("id", id);
  const counts = await emailSubscribers(alert);
  await supabase.from("storm_alerts").update({
    status: "sent", sent_at: new Date().toISOString(), sent_count: counts.sent,
  }).eq("id", id);
  await resolveActionsForSource("storm_alert", id, "done");
  return counts;
}

router.post("/storm-alerts/:id/approve", requireToken, async (req: Request, res: Response) => {
  try {
    const counts = await approveAndSend((req.params["id"] ?? ""));
    res.json({ success: true, ...counts });
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

    const counts = await emailAllClear(alert as unknown as AllClearRow);
    await supabase.from("storm_alerts").update({
      all_clear_sent_at: new Date().toISOString(),
      all_clear_sent_count: counts.sent,
      last_updated: new Date().toISOString(),
    }).eq("id", id);
    await resolveActionsForSource("storm_alert", id, "done");
    res.json({ success: true, ...counts });
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
      const c = await approveAndSend((req.params["id"] ?? ""));
      res.type("html").send(`<p>✅ Alert approved and sent to ${c.sent} subscriber(s).</p>`);
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

export default router;
