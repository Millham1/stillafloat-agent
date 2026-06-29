import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken } from "../lib/http-auth";
import { assembleBrief, getStoredBrief, runAndDeliverBrief, renderBriefEmail } from "../lib/brief";
import { logger } from "../lib/logger";

// Daily-brief API. The dashboard Today page reads /api/brief; /api/brief/run
// assembles + delivers (push + email) and is used by the morning cron and a
// manual "refresh" button. All token-gated (the brief contains PII).
const router: IRouter = Router();

// Current brief — the stored one, or freshly assembled if none yet (or ?fresh=1).
router.get("/brief", requireToken, async (req: Request, res: Response) => {
  try {
    const fresh = req.query["fresh"] === "1";
    const brief = fresh ? await assembleBrief() : (await getStoredBrief()) ?? (await assembleBrief());
    res.json({ ok: true, brief });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// Assemble + deliver now (push + email). Returns a delivery summary.
router.post("/brief/run", requireToken, async (_req: Request, res: Response) => {
  try {
    const result = await runAndDeliverBrief();
    res.json({ ok: true, counts: result.brief.counts, push: result.push, emailed: result.emailed });
  } catch (err) {
    logger.error({ err }, "brief run failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// HTML preview of the brief email (handy for checking formatting).
router.get("/brief/email-preview", requireToken, async (_req: Request, res: Response) => {
  try {
    const brief = (await getStoredBrief()) ?? (await assembleBrief());
    res.type("html").send(renderBriefEmail(brief));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
