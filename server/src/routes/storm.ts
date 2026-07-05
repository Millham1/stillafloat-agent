// routes/storm.ts — storm-alert API.
//   Dashboard (token-gated): queue, edit, approve→send, dismiss, manual scan.
//   Email approve links     : GET /storm-alerts/:id/action?do=approve&token=…
//   Public (site panel)     : GET /storm-watch  — active approved/sent systems + ships.

import { Router, type IRouter, type Request, type Response } from "express";
import { getSupabase } from "../lib/persistence";
import { requireToken } from "../lib/http-auth";
import { logger } from "../lib/logger";
import { runStormScan, shipsForAlert } from "../lib/storm-agent";
import { emailSubscribers, type AlertRow } from "../lib/storm-send";
import { labelGrounds, type RegionKey, REGION_LABELS } from "../lib/storm-grounds";

const router: IRouter = Router();

interface DbAlert extends AlertRow {
  basin: string | null; classification: string | null; status: string;
  is_threat: boolean; formation_chance: number | null; last_updated: string;
  sent_at: string | null; sent_count: number;
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
      ships: await shipsForAlert(a.affected_grounds),
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
    const { headline, body_md } = req.body ?? {};
    const patch: Record<string, unknown> = { last_updated: new Date().toISOString() };
    if (typeof headline === "string") patch["headline"] = headline.slice(0, 120);
    if (typeof body_md === "string") patch["body_md"] = body_md;
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
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "dismiss failed");
    res.status(500).json({ success: false, error: "Dismiss failed" });
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
      .select("name, classification, basin, headline, body_md, affected_grounds, formation_chance, is_threat, sent_at, last_updated, status")
      .in("status", ["approved", "sent"])
      .eq("is_threat", true)
      .order("last_updated", { ascending: false });
    if (error) throw error;
    const rows = (data ?? []) as unknown as DbAlert[];
    const systems = await Promise.all(rows.map(async (a) => ({
      name: a.name,
      classification: a.classification,
      headline: a.headline,
      body_md: a.body_md,
      grounds: a.affected_grounds,
      grounds_label: labelGrounds(a.affected_grounds),
      formation_chance: a.formation_chance,
      updated: a.last_updated,
      ships: await shipsForAlert(a.affected_grounds),
    })));
    // Cache a little at the edge; this is public, low-cardinality data.
    res.set("Cache-Control", "public, max-age=300");
    res.json({ success: true, systems, regions: REGION_LABELS as Record<RegionKey, string> });
  } catch (err) {
    logger.error({ err }, "GET /storm-watch failed");
    res.status(500).json({ success: false, error: "Failed to load storm watch" });
  }
});

export default router;
