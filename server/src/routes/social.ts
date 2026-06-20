import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken, extractToken } from "../lib/http-auth";
import {
  generateSocialBatch,
  enqueueBatch,
  loadQueue,
  setBatchStatus,
  scanAndQueue,
  type Track,
  type Lang,
  type SocialVideo,
} from "../lib/social-agent";
import { notifyTelegram, reviewUrl } from "../lib/telegram";
import { publishBatch } from "../lib/social-publish";

const router: IRouter = Router();

// POST /api/social/generate — generate a batch for one video and queue it.
// Body: { videoId, title, lang, track?, format? }
router.post("/social/generate", requireToken, async (req: Request, res: Response) => {
  try {
    const { videoId, title, lang, track, format } = req.body as {
      videoId?: string;
      title?: string;
      lang?: Lang;
      track?: Track;
      format?: "short" | "long";
    };
    if (!videoId || !title || (lang !== "en" && lang !== "es")) {
      res.status(400).json({ success: false, error: "videoId, title and lang('en'|'es') are required" });
      return;
    }
    const resolvedTrack: Track = track === "A" || track === "B" ? track : lang === "es" ? "A" : "B";
    const video: SocialVideo = { id: videoId, title, lang, ...(format ? { format } : {}) };
    const batch = await generateSocialBatch(video, resolvedTrack);
    const queued = await enqueueBatch(batch);
    res.json({ success: true, batch: queued });
    void notifyTelegram({
      heading: `📱 <b>1 social draft ready (Track ${queued.track})</b>`,
      lines: [queued.title],
      url: reviewUrl("/api/social/review"),
      buttonLabel: "Review →",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// POST /api/social/scan — generate + queue batches for recent uploads not yet queued.
router.post("/social/scan", requireToken, async (req: Request, res: Response) => {
  try {
    const maxNew = Math.min(8, Math.max(1, Number((req.body as { maxNew?: number })?.maxNew) || 4));
    const created = await scanAndQueue(maxNew);
    res.json({
      success: true,
      created: created.length,
      batches: created.map((b) => ({ id: b.id, videoId: b.videoId, track: b.track, title: b.title })),
    });
    if (created.length > 0) {
      void notifyTelegram({
        heading: `📱 <b>${created.length} new social draft(s) ready</b>`,
        lines: created.map((b) => `Track ${b.track}: ${b.title}`),
        url: reviewUrl("/api/social/review"),
        buttonLabel: `Review ${created.length} →`,
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// GET /api/social/queue — list queued batches (newest first).
router.get("/social/queue", requireToken, async (_req: Request, res: Response) => {
  try {
    const queue = await loadQueue();
    res.json({ success: true, count: queue.batches.length, batches: queue.batches });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// POST /api/social/queue/:id/approve | /reject — flip status (no posting here).
router.post("/social/queue/:id/:action", requireToken, async (req: Request, res: Response) => {
  try {
    const action = req.params["action"];
    if (action !== "approve" && action !== "reject") {
      res.status(400).json({ success: false, error: "action must be approve or reject" });
      return;
    }
    const batch = await setBatchStatus(req.params["id"] ?? "", action === "approve" ? "approved" : "rejected");
    if (!batch) {
      res.status(404).json({ success: false, error: "Batch not found" });
      return;
    }
    if (action === "reject") {
      res.json({ success: true, id: batch.id, status: batch.status });
      return;
    }
    // Approved → publish (FB now; IG pending media pipeline). Dormant until
    // MAKE_FB_WEBHOOK is configured, in which case approving posts publicly.
    const publish = await publishBatch(batch);
    const anyPosted = publish.some((p) => p.ok);
    const finalBatch = anyPosted ? await setBatchStatus(batch.id, "posted") : batch;
    res.json({ success: true, id: batch.id, status: finalBatch?.status ?? "approved", publish });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// POST /api/social/notify — send a Telegram nudge for current pending batches (manual/test).
router.post("/social/notify", requireToken, async (_req: Request, res: Response) => {
  const queue = await loadQueue();
  const pending = queue.batches.filter((b) => b.status === "pending");
  const result = await notifyTelegram({
    heading: `📱 <b>${pending.length} social draft(s) awaiting review</b>`,
    lines: pending.slice(0, 8).map((b) => `Track ${b.track}: ${b.title}`),
    url: reviewUrl("/api/social/review"),
    buttonLabel: `Review ${pending.length} →`,
  });
  res.json({ success: result.success, pending: pending.length, reason: result.reason });
});

// GET /api/social/review?token=… — self-contained HTML review surface.
router.get("/social/review", requireToken, async (req: Request, res: Response) => {
  try {
    const token = extractToken(req);
    const queue = await loadQueue();
    const pending = queue.batches.filter((b) => b.status === "pending");
    res.status(200).type("html").send(renderReviewPage(pending, token));
  } catch (error) {
    res.status(500).type("html").send(`<p>Error: ${(error as Error).message}</p>`);
  }
});

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderReviewPage(batches: any[], token: string): string {
  const cards = batches
    .map((b) => {
      const posts = (b.posts || [])
        .map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (p: any) => `
        <div class="post">
          <div class="meta"><span class="pill">${esc(p.surface)}</span><span class="pill cta">${esc(p.ctaType)}</span>${p.linkInBio ? '<span class="pill bio">link in bio</span>' : ""}</div>
          <p class="cap">${esc(p.caption)}</p>
          ${p.hashtags?.length ? `<p class="tags">${esc(p.hashtags.join(" "))}</p>` : ""}
          <p class="link">${esc(p.link)}</p>
        </div>`,
        )
        .join("");
      return `
      <div class="batch" id="b-${esc(b.id)}">
        <div class="bhead">
          <div><span class="trk trk-${esc(b.track)}">Track ${esc(b.track)}</span> <strong>${esc(b.title)}</strong></div>
          <div class="acts">
            <button class="ap" onclick="decide('${esc(b.id)}','approve')">✅ Approve</button>
            <button class="rj" onclick="decide('${esc(b.id)}','reject')">✕ Reject</button>
          </div>
        </div>
        ${posts}
      </div>`;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>Still Afloat — Social Review</title>
<style>
 body{margin:0;font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f3f4f6;color:#111827}
 header{background:#0f766e;color:#fff;padding:16px 18px;position:sticky;top:0}
 header h1{margin:0;font-size:18px}
 .wrap{max-width:760px;margin:0 auto;padding:16px 14px 60px}
 .batch{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px;margin-bottom:16px}
 .bhead{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px}
 .acts button{border:0;border-radius:8px;padding:8px 12px;font-weight:700;color:#fff;cursor:pointer;margin-left:6px}
 .ap{background:#16a34a}.rj{background:#dc2626}
 .trk{font-size:11px;font-weight:700;border-radius:5px;padding:2px 7px;color:#fff}
 .trk-A{background:#7c3aed}.trk-B{background:#0369a1}
 .post{border-top:1px solid #eee;padding:10px 0}
 .meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
 .pill{font-size:11px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:5px;padding:2px 7px}
 .pill.cta{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8}
 .pill.bio{background:#fef3c7;border-color:#fde68a;color:#92400e}
 .cap{margin:4px 0;font-size:15px;line-height:1.5;white-space:pre-wrap}
 .tags{margin:4px 0;font-size:13px;color:#2563eb}
 .link{margin:4px 0 0;font-size:11px;color:#6b7280;word-break:break-all}
 .empty{text-align:center;color:#6b7280;padding:50px 0}
</style></head><body>
<header><h1>Still Afloat — Social Review</h1></header>
<div class="wrap">
 ${cards || '<div class="empty">No pending batches. 🎉</div>'}
</div>
<script>
 var TOKEN=${JSON.stringify(token)};
 function decide(id,action){
   fetch('/api/social/queue/'+id+'/'+action,{method:'POST',headers:{'x-affiliate-token':TOKEN}})
     .then(function(r){return r.json();})
     .then(function(j){
       var el=document.getElementById('b-'+id);
       if(j.success&&el){el.style.opacity=.4;el.querySelector('.acts').innerHTML=(action==='approve'?'✅ Approved':'✕ Rejected');}
       else{alert('Failed: '+(j.error||'error'));}
     }).catch(function(){alert('Network error');});
 }
</script>
</body></html>`;
}

export default router;
