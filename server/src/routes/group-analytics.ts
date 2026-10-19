import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken } from "../lib/http-auth";
import { buildAnalytics } from "../lib/group-analytics";
import { loadAnalyticsRaw } from "../lib/group-analytics-store";

// The Group Bookings Workspace's data (Mark 2026-10-19: "I need a link to open a power BI style dashboard to track this").
//
//   GET /api/groups/analytics   ONE flat dataset across every group: groups, cabins, travelers, payments, paperwork,
//                               messages, interests, deadlines and the journey plan. The page slices it in the browser.
//
// Dashboard-token gated, read-only. Passport numbers, link hashes, signature answers, message bodies and unmasked email
// addresses never appear (lib/group-analytics.ts builds every field from a whitelist and the unit tests check the output).
// Mounted before routes/groups.ts: its GET /groups/:id would otherwise read "analytics" as a group id.
const router: IRouter = Router();

router.get("/groups/analytics", requireToken, async (req: Request, res: Response) => {
  try {
    const analytics = buildAnalytics(await loadAnalyticsRaw(), new Date());
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, ...analytics });
  } catch (err) {
    req.log.error({ err }, "group analytics failed");
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
