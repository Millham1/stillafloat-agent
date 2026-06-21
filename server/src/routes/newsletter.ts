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
import type { Lang } from "../lib/social-agent";
import { notifyTelegram, reviewUrl } from "../lib/telegram";

const router: IRouter = Router();
const SITE = "https://stillafloatcruising.com";

// Edition language from ?lang= or body.lang (default English).
function editionLang(req: Request): Lang {
  const v = String((req.query["lang"] as string) ?? (req.body as { lang?: string })?.lang ?? "");
  return v === "es" ? "es" : "en";
}

// POST /api/newsletter/draft — AI-assemble this week's issue (en|es) and save it.
router.post("/newsletter/draft", requireToken, async (req: Request, res: Response) => {
  try {
    const lang = editionLang(req);
    const draft = await draftNewsletter(lang);
    await saveDraft(draft);
    res.json({ success: true, draft });
    void notifyTelegram({
      heading: `📨 <b>Newsletter draft ready (${lang.toUpperCase()})</b>`,
      lines: [draft.subject, `${draft.storyIds.length} stories${draft.video ? " + video" : ""}${draft.affiliate ? " + affiliate" : ""}`],
      url: reviewUrl(`/api/newsletter/review?lang=${lang}`),
      buttonLabel: "Review & send →",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// GET /api/newsletter/draft — current saved draft (en|es).
router.get("/newsletter/draft", requireToken, async (req: Request, res: Response) => {
  const draft = await loadDraft(editionLang(req));
  res.json({ success: true, draft });
});

// GET /api/newsletter/email — raw enriched email HTML for the current draft (iframe source).
router.get("/newsletter/email", requireToken, async (req: Request, res: Response) => {
  const lang = editionLang(req);
  const draft = await loadDraft(lang);
  if (!draft) {
    res.status(404).type("html").send("<p>No draft yet.</p>");
    return;
  }
  const stories = await gatherApprovedStories(lang);
  res.type("html").send(renderEnrichedNewsletter(draft, stories, "there", "preview@stillafloatcruising.com", SITE));
});

// POST /api/newsletter/send — send the current draft to confirmed subscribers of that language.
router.post("/newsletter/send", requireToken, async (req: Request, res: Response) => {
  try {
    const lang = editionLang(req);
    const draft = await loadDraft(lang);
    if (!draft) {
      res.status(404).json({ success: false, error: "No draft to send" });
      return;
    }
    const result = await sendNewsletterDraft(draft, SITE);
    draft.status = "sent";
    draft.sentAt = new Date().toISOString();
    await saveDraft(draft);
    res.json({ success: true, lang, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// POST /api/newsletter/notify — Telegram nudge for the current draft (manual/test).
router.post("/newsletter/notify", requireToken, async (req: Request, res: Response) => {
  const lang = editionLang(req);
  const draft = await loadDraft(lang);
  if (!draft) {
    res.status(404).json({ success: false, error: "No draft to notify about" });
    return;
  }
  const result = await notifyTelegram({
    heading: `📨 <b>Newsletter draft awaiting review (${lang.toUpperCase()})</b>`,
    lines: [draft.subject],
    url: reviewUrl(`/api/newsletter/review?lang=${lang}`),
    buttonLabel: "Review & send →",
  });
  res.json({ success: result.success, reason: result.reason });
});

// GET /api/newsletter/review?token=…&lang=en|es — review surface: live preview + actions.
router.get("/newsletter/review", requireToken, async (req: Request, res: Response) => {
  const token = extractToken(req);
  const lang = editionLang(req);
  const draft = await loadDraft(lang);
  const stories = draft ? previewStories(draft, await gatherApprovedStories(lang)) : [];
  const t = JSON.stringify(token);
  const other: Lang = lang === "es" ? "en" : "es";

  const meta = draft
    ? `<div class="meta">
         <span class="pill">Subject: ${escapeHtml(draft.subject)}</span>
         <span class="pill">${stories.length} stories</span>
         ${draft.video ? '<span class="pill">+ video</span>' : ""}
         ${draft.affiliate ? '<span class="pill">+ affiliate</span>' : ""}
         <span class="pill ${draft.status === "sent" ? "sent" : "pend"}">${draft.status}</span>
       </div>`
    : `<p>No ${lang.toUpperCase()} draft yet — generate this week's issue.</p>`;

  const preview = draft
    ? `<iframe title="preview" src="/api/newsletter/email?lang=${lang}&token=${encodeURIComponent(token)}" style="width:100%;height:70vh;border:1px solid #e5e7eb;border-radius:12px;background:#fff;"></iframe>`
    : "";

  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>Still Afloat — Newsletter Review (${lang.toUpperCase()})</title>
<style>
 body{margin:0;font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f3f4f6;color:#111827}
 header{background:#07183f;color:#fff;padding:14px 18px;position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
 header h1{margin:0;font-size:17px}
 .btns button{border:0;border-radius:8px;padding:9px 14px;font-weight:700;color:#fff;cursor:pointer;margin-left:6px}
 .gen{background:#0077b6}.send{background:#16a34a}
 .langtabs a{display:inline-block;padding:5px 12px;border-radius:7px;font-size:13px;font-weight:700;text-decoration:none;margin-right:6px}
 .langtabs a.on{background:#5dff9a;color:#07183f}.langtabs a.off{background:rgba(255,255,255,.15);color:#fff}
 .wrap{max-width:680px;margin:0 auto;padding:16px 14px 50px}
 .meta{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}
 .pill{font-size:12px;background:#fff;border:1px solid #d1d5db;border-radius:6px;padding:3px 9px}
 .pill.pend{background:#fef3c7;border-color:#fde68a;color:#92400e}
 .pill.sent{background:#dcfce7;border-color:#bbf7d0;color:#166534}
 #msg{font-size:13px;color:#6b7280;margin:8px 0}
</style></head><body>
<header>
  <h1>Still Afloat — Newsletter Review</h1>
  <div class="langtabs">
    <a class="${lang === "en" ? "on" : "off"}" href="/api/newsletter/review?lang=en&token=${encodeURIComponent(token)}">English</a>
    <a class="${lang === "es" ? "on" : "off"}" href="/api/newsletter/review?lang=es&token=${encodeURIComponent(token)}">Español</a>
  </div>
  <div class="btns">
    <button class="gen" onclick="gen()">↻ Generate ${lang.toUpperCase()}</button>
    <button class="send" onclick="send()">✅ Approve &amp; Send</button>
  </div>
</header>
<div class="wrap">
  ${meta}
  <div id="msg"></div>
  ${preview}
</div>
<script>
 var TOKEN=${t}; var LANG=${JSON.stringify(lang)}; var OTHER=${JSON.stringify(other)};
 function gen(){
   document.getElementById('msg').textContent='Generating '+LANG.toUpperCase()+'…';
   fetch('/api/newsletter/draft?lang='+LANG,{method:'POST',headers:{'x-affiliate-token':TOKEN}})
     .then(r=>r.json()).then(j=>{ if(j.success){location.reload();} else {document.getElementById('msg').textContent='Failed: '+(j.error||'error');}})
     .catch(()=>document.getElementById('msg').textContent='Network error');
 }
 function send(){
   if(!confirm('Send this '+LANG.toUpperCase()+' newsletter to all confirmed '+LANG.toUpperCase()+' subscribers now?')) return;
   document.getElementById('msg').textContent='Sending…';
   fetch('/api/newsletter/send?lang='+LANG,{method:'POST',headers:{'x-affiliate-token':TOKEN}})
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
