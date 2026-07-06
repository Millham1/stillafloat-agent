import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken } from "../lib/http-auth";

// Server-side proxy to the SAF Ops Manager finance API (FastAPI on :5000).
// The dashboard calls these /api/ops/finance/* routes (same-origin, gated by the
// dashboard token via requireToken); the ops-manager's x-api-key (IDEAS_API_KEY)
// never reaches the browser. OPS_MANAGER_URL defaults to the local box.
const router: IRouter = Router();

const OPS_BASE = (process.env["OPS_MANAGER_URL"] ?? "http://127.0.0.1:5000").replace(/\/+$/, "");

async function proxy(upstreamPath: string, req: Request, res: Response): Promise<void> {
  const key = process.env["IDEAS_API_KEY"];
  if (!key) {
    res.status(503).json({ ok: false, error: "IDEAS_API_KEY not configured for the backend" });
    return;
  }
  const i = req.originalUrl.indexOf("?");
  const qs = i >= 0 ? req.originalUrl.slice(i) : "";
  try {
    const upstream = await fetch(`${OPS_BASE}${upstreamPath}${qs}`, {
      headers: { "x-api-key": key },
    });
    const body = await upstream.text();
    res.status(upstream.status).type("application/json").send(body);
  } catch (err) {
    res.status(502).json({ ok: false, error: `ops-manager unreachable: ${(err as Error).message}` });
  }
}

router.get("/ops/finance/summary", requireToken, (req, res) => proxy("/finance/summary", req, res));
router.get("/ops/finance/transactions", requireToken, (req, res) => proxy("/finance/transactions", req, res));
router.get("/ops/finance/cashflow", requireToken, (req, res) => proxy("/finance/cashflow", req, res));
router.get("/ops/finance/subscriptions", requireToken, (req, res) => proxy("/finance/subscriptions", req, res));
router.get("/ops/youtube-analytics", requireToken, (req, res) => proxy("/youtube/analytics", req, res));
router.get("/ops/social-analytics", requireToken, (req, res) => proxy("/social/analytics", req, res));

// Calendar conflicts — listed + resolved from the Today page (replaces the old
// Telegram 1/2/3 reply flow).
router.get("/ops/conflicts", requireToken, (req, res) => proxy("/brief/conflicts", req, res));

router.post("/ops/resolve-conflict", requireToken, async (req: Request, res: Response) => {
  const key = process.env["IDEAS_API_KEY"];
  if (!key) {
    res.status(503).json({ ok: false, error: "IDEAS_API_KEY not configured for the backend" });
    return;
  }
  try {
    const upstream = await fetch(`${OPS_BASE}/brief/resolve-conflict`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    });
    const body = await upstream.text();
    res.status(upstream.status).type("application/json").send(body);
  } catch (err) {
    res.status(502).json({ ok: false, error: `ops-manager unreachable: ${(err as Error).message}` });
  }
});

export default router;
