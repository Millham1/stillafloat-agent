// routes/ops-gsc.ts — the SEO cockpit's data plane.
//
// Two halves, matching the ops-finance.ts pattern:
//  • /ops/gsc/* — same-origin proxies to the SAF Ops Manager's Search Console
//    API (FastAPI on :5000). The dashboard authenticates with its own token
//    (requireToken); the ops-manager's x-api-key (IDEAS_API_KEY) never reaches
//    the browser.
//  • /ops/seo-proposals — the open AI proposals (tasks with status='proposed'),
//    read straight from Supabase here because this backend owns that table's
//    approval flow (routes/proposals.ts). Includes the machine-actionable
//    `payload` so the Search page can tell Mark exactly what an Approve will do.

import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken } from "../lib/http-auth";
import { getSupabase } from "../lib/persistence";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const OPS_BASE = (process.env["OPS_MANAGER_URL"] ?? "http://127.0.0.1:5000").replace(/\/+$/, "");

async function proxy(upstreamPath: string, req: Request, res: Response, method = "GET"): Promise<void> {
  const key = process.env["IDEAS_API_KEY"];
  if (!key) {
    res.status(503).json({ ok: false, error: "IDEAS_API_KEY not configured for the backend" });
    return;
  }
  const i = req.originalUrl.indexOf("?");
  const qs = i >= 0 ? req.originalUrl.slice(i) : "";
  try {
    const upstream = await fetch(`${OPS_BASE}${upstreamPath}${qs}`, {
      method,
      headers: { "x-api-key": key },
    });
    const body = await upstream.text();
    res.status(upstream.status).type("application/json").send(body);
  } catch (err) {
    res.status(502).json({ ok: false, error: `ops-manager unreachable: ${(err as Error).message}` });
  }
}

router.get("/ops/gsc/analytics", requireToken, (req, res) => proxy("/gsc/analytics", req, res));
router.get("/ops/gsc/insights", requireToken, (req, res) => proxy("/gsc/insights", req, res));
// "Ask the agent now" — runs the Claude analysis and FILES proposals (the same
// thing the Monday 08:00 cadence does), so Mark can pull fresh proposals on
// demand from the cockpit instead of waiting a week.
router.post("/ops/gsc/insights/run", requireToken, (req, res) =>
  proxy("/gsc/insights/run", req, res, "POST"),
);

// Open proposals for the PROPOSALS panel. All status='proposed' rows are agent
// proposals awaiting Mark (today only the SEO review files them); newest first.
router.get("/ops/seo-proposals", requireToken, async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, detail, priority, category, payload, created_at")
      .eq("status", "proposed")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    res.json({ ok: true, proposals: data ?? [] });
  } catch (err) {
    logger.error({ err }, "seo-proposals list failed");
    res.status(500).json({ ok: false, error: "Failed to load proposals" });
  }
});

export default router;
