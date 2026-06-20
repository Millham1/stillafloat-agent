import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken } from "../lib/http-auth";
import { generateSocialBatch, type Track, type Lang, type SocialVideo } from "../lib/social-agent";

const router: IRouter = Router();

// POST /api/social/generate
// Body: { videoId, title, lang: "en"|"es", track?: "A"|"B", format?: "short"|"long" }
// Returns a generated two-track-aware post batch (no posting yet — review step).
router.post("/social/generate", requireToken, async (req: Request, res: Response) => {
  try {
    const { videoId, title, lang, track, format } = req.body as {
      videoId?: string;
      title?: string;
      lang?: Lang;
      track?: Track;
      format?: "short" | "long";
    };

    if (!videoId || !title || !lang) {
      res.status(400).json({ success: false, error: "videoId, title and lang are required" });
      return;
    }
    if (lang !== "en" && lang !== "es") {
      res.status(400).json({ success: false, error: "lang must be 'en' or 'es'" });
      return;
    }

    // Default track from language: Spanish → reach (A), English → value (B).
    const resolvedTrack: Track = track === "A" || track === "B" ? track : lang === "es" ? "A" : "B";

    const video: SocialVideo = { id: videoId, title, lang, ...(format ? { format } : {}) };
    const batch = await generateSocialBatch(video, resolvedTrack);

    res.json({ success: true, batch });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

export default router;
