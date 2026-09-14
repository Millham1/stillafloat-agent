import { Router, type IRouter, type Request, type Response } from "express";
import { getSupabase } from "../lib/persistence";
import { allPositions } from "../lib/ship-tracker";
import { portBySlug } from "../lib/ports";
import { shipsInPort } from "../lib/webcam-ships";

const router: IRouter = Router();

/**
 * GET /api/webcams
 * Active live-cam feeds for the /webcams page, ordered by section then sort.
 * The daily ops-manager monitor keeps `video_id`/`status` fresh (YouTube live ids
 * rotate and go offline), so this endpoint just reads the `webcams` table.
 * Returns both EN and ES labels; the page picks by its own lang.
 */
router.get("/webcams", async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("webcams")
      .select(
        "slug, section, title, title_es, description, description_es, video_id, status, sort, port_slug",
      )
      .eq("active", true)
      .order("section", { ascending: true })
      .order("sort", { ascending: true });

    if (error) {
      req.log.error({ err: error }, "webcams query failed");
      return res.status(500).json({ success: false, error: error.message });
    }

    // Which of our tracked ships are in frame right now (Mark, 2026-09-14): a
    // cam that looks at a cruise port lists the ships with a recent fix there.
    const now = new Date();
    const positions = allPositions();
    type CamRow = Record<string, unknown> & { port_slug?: string | null };
    const webcams = ((data ?? []) as CamRow[]).map((cam) => {
      const port = cam.port_slug ? portBySlug(cam.port_slug) : undefined;
      return { ...cam, ships_in_port: port ? shipsInPort(positions, port, now) : null };
    });
    return res.json({
      success: true,
      source: "stillafloat-agent",
      generatedAt: new Date().toISOString(),
      count: webcams.length,
      webcams,
    });
  } catch (error) {
    req.log.error({ err: error }, "webcams endpoint error");
    return res.status(500).json({ success: false, error: (error as Error).message });
  }
});

export default router;
