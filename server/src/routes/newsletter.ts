import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken, extractToken } from "../lib/http-auth";
import {
  draftNewsletter,
  saveDraft,
  loadDraft,
  sendNewsletterDraft,
  renderEnrichedNewsletter,
  gatherApprovedStories,
  previewStories,
} from "../lib/newsletter";
import { notifyTelegram, reviewUrl } from "../lib/telegram";

const router: IRouter = Router();
const SITE = "https://stillafloatcruising.com";

// POST /api/newsletter/draft — AI-assemble this week's issue and save as the current draft.
router.post("/newsletter/draft", requireToken, async (_req: Request, res: Response) => {
  try {
    const draft = await draftNewsletter();
    await saveDraft(draft);
    res.json({ success: true, draft });
    void notifyTelegram({
      heading: "📨 <b>Newsletter draft ready</b>",
      lines: [draft.subject, `${draft.storyIds.length} stories${draft.video ? " + video" : ""}${draft.affiliate ? " + affiliate" : ""}`],
      url: reviewUrl("/api/newsletter/review"),
      buttonLabel: "Review & send →",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// GET /api/newsletter/draft — current saved draft.
router.get("/newsletter/draft", requireToken, async (_req: Request, res: Response) => {
  const draft = await loadDraft();
  res.json({ success: true, draft });
});

// GET /api/newsletter/email — raw enriched email HTML for the current draft (iframe source).
router.get("/newsletter/email", requireToken, async (_req: Request, res: Response) => {
  const draft = await loadDraft();
  if (!draft) {
    res.status(404).type("html").send("<p>No draft yet.</p>");
    return;
  }
  const stories = await gatherApprovedStories();
  res.type("html").send(renderEnrichedNewsletter(draft, stories, "there", "preview@stillafloatcruising.com", SITE));
});

// POST /api/newsletter/send — send the current draft to confirmed subscribers (explicit).
router.post("/newsletter/send", requireToken, async (_req: Request, res: Response) => {
  try {
    const draft = await loadDraft();
    if (!draft) {
      res.status(404).json({ success: false, error: "No draft to send" });
      return;
    }
    const result = await sendNewsletterDraft(draft, SITE);
    draft.status = "sent";
    draft.sentAt = new Date().toISOString();
    await saveDraft(draft);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// POST /api/newsletter/notify — Telegram nudge for the current draft (manual/test).
router.post("/newsletter/notify", requireToken, async (_req: Request, res: Response) => {
  const draft = await loadDraft();
  if (!draft) {
    res.status(404).json({ success: false, error: "No draft to notify about" });
    return;
  }
  const result = await notifyTelegram({
    heading: "📨 <b>Newsletter draft awaiting review</b>",
    lines: [draft.subject],
    url: reviewUrl("/api/newsletter/review"),
    buttonLabel: "Review & send →",
  });
  res.json({ success: result.success, reason: result.reason });
});

// GET /api/newsletter/review?token=… — review surface: live email preview + actions.
router.get("/newsletter/review", requireToken, async (req: Request, res: Response) => {
  const token = extractToken(req);
  const draft = await loadDraft();
  const stories = draft ? previewStories(draft, await gatherApprovedStories()) : [];
  const t = JSON.stringify(token);

  const meta = draft
    ? `<div class="meta">
         <span class="pill">Subject: ${escapeHtml(draft.subject)}</span>
         <span class="pill">${stories.length} stories</span>
         ${draft.video ? '<span class="pill">+ video</span>' : ""}
         ${draft.affiliate ? '<span class="pill">+ affiliate</span>' : ""}
         <span class="pill ${draft.status === "sent" ? "sent" : "pend"}">${draft.status}</span>
       </div>`
    : `<p>No draft yet — generate this week's issue.</p>`;

  const preview = draft
    ? `<iframe title="preview" src="/api/newsletter/email?token=${encodeURIComponent(token)}" style="width:100%;height:70vh;border:1px solid #e5e7eb;border-radius:12px;background:#fff;"></iframe>`
    : "";

  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>Still Afloat — Newsletter Review</title>
<style>
 body{margin:0;font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f3f4f6;color:#111827}
 header{background:#07183f;color:#fff;padding:14px 18px;position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
 header h1{margin:0;font-size:17px}
 .btns button{border:0;border-radius:8px;padding:9px 14px;font-weight:700;color:#fff;cursor:pointer;margin-left:6px}
 .gen{background:#0077b6}.send{background:#16a34a}
 .wrap{max-width:680px;margin:0 auto;padding:16px 14px 50px}
 .meta{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}
 .pill{font-size:12px;background:#fff;border:1px solid #d1d5db;border-radius:6px;padding:3px 9px}
 .pill.pend{background:#fef3c7;border-color:#fde68a;color:#92400e}
 .pill.sent{background:#dcfce7;border-color:#bbf7d0;color:#166534}
 #msg{font-size:13px;color:#6b7280;margin:8px 0}
</style></head><body>
<header>
  <h1>Still Afloat — Newsletter Review</h1>
  <div class="btns">
    <button class="gen" onclick="gen()">↻ Generate</button>
    <button class="send" onclick="send()">✅ Approve &amp; Send</button>
  </div>
</header>
<div class="wrap">
  ${meta}
  <div id="msg"></div>
  ${preview}
</div>
<script>
 var TOKEN=${t};
 function gen(){
   document.getElementById('msg').textContent='Generating…';
   fetch('/api/newsletter/draft',{method:'POST',headers:{'x-affiliate-token':TOKEN}})
     .then(r=>r.json()).then(j=>{ if(j.success){location.reload();} else {document.getElementById('msg').textContent='Failed: '+(j.error||'error');}})
     .catch(()=>document.getElementById('msg').textContent='Network error');
 }
 function send(){
   if(!confirm('Send this newsletter to all confirmed subscribers now?')) return;
   document.getElementById('msg').textContent='Sending…';
   fetch('/api/newsletter/send',{method:'POST',headers:{'x-affiliate-token':TOKEN}})
     .then(r=>r.json()).then(j=>{ document.getElementById('msg').textContent = j.success ? ('Sent to '+j.sent+' / '+j.total+' (failed '+j.failed+')') : ('Failed: '+(j.error||'error')); })
     .catch(()=>document.getElementById('msg').textContent='Network error');
 }
</script>
</body></html>`);
});

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export default router;
