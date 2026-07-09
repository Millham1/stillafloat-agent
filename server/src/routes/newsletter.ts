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
  type Story,
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

// POST /api/newsletter/draft/update — apply Mark's edits from the review page.
// Every human-visible field of the draft is editable; edits live on the draft
// snapshot and never touch the approved-stories store. Only pending drafts.
router.post("/newsletter/draft/update", requireToken, async (req: Request, res: Response) => {
  try {
    const lang = editionLang(req);
    const draft = await loadDraft(lang);
    if (!draft) {
      res.status(404).json({ success: false, error: "No draft to update" });
      return;
    }
    if (draft.status === "sent") {
      res.status(409).json({ success: false, error: "Draft already sent — generate a new one first" });
      return;
    }
    const body = req.body as {
      subject?: string;
      intro?: string;
      agencyPs?: string;
      funFact?: string;
      commentaryBlurb?: string;
      videoBlurb?: string;
      affiliateBlurb?: string;
      removeCommentary?: boolean;
      removePhoto?: boolean;
      removeVideo?: boolean;
      removeAffiliate?: boolean;
      stories?: Array<{ id?: string; title?: string; summary?: string; link?: string; impact?: string }>;
    };

    if (typeof body.subject === "string" && body.subject.trim()) draft.subject = body.subject.trim();
    if (typeof body.intro === "string") draft.intro = body.intro.trim();
    if (typeof body.agencyPs === "string") draft.agencyPs = body.agencyPs.trim();
    if (typeof body.funFact === "string") {
      const f = body.funFact.trim();
      if (f) draft.funFact = f;
      else delete draft.funFact;
    }
    if (draft.commentary && typeof body.commentaryBlurb === "string") draft.commentary.blurb = body.commentaryBlurb.trim();
    if (draft.video && typeof body.videoBlurb === "string") draft.video.blurb = body.videoBlurb.trim();
    if (draft.affiliate && typeof body.affiliateBlurb === "string") draft.affiliate.blurb = body.affiliateBlurb.trim();
    if (body.removeCommentary) delete draft.commentary;
    if (body.removePhoto) delete draft.photo;
    if (body.removeVideo) delete draft.video;
    if (body.removeAffiliate) delete draft.affiliate;

    if (Array.isArray(body.stories)) {
      // The submitted array IS the issue's story list: order, inclusion, and
      // edited text all come from it. Unknown fields fall back to the current
      // snapshot (or the approved store for legacy drafts missing a snapshot).
      const current = previewStories(draft, await gatherApprovedStories(lang));
      const byId = new Map(current.map((s) => [s.id, s]));
      const edited: Story[] = [];
      for (const s of body.stories) {
        const id = String(s.id ?? "");
        if (!id) continue;
        const base = byId.get(id) ?? { id, title: "", summary: "", link: "", impact: "" };
        edited.push({
          id,
          title: typeof s.title === "string" && s.title.trim() ? s.title.trim() : base.title,
          summary: typeof s.summary === "string" ? s.summary.trim() : base.summary,
          link: typeof s.link === "string" && s.link.trim() ? s.link.trim() : base.link,
          impact: typeof s.impact === "string" ? s.impact.trim() : base.impact,
        });
      }
      if (edited.length === 0) {
        res.status(400).json({ success: false, error: "Newsletter needs at least one story" });
        return;
      }
      draft.stories = edited;
      draft.storyIds = edited.map((s) => s.id);
    }

    await saveDraft(draft);
    res.json({ success: true, draft });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
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
         ${draft.commentary ? '<span class="pill">+ commentary</span>' : ""}
         ${draft.funFact ? '<span class="pill">+ fun fact</span>' : ""}
         ${draft.photo ? '<span class="pill">+ photo</span>' : ""}
         ${draft.video ? '<span class="pill">+ video</span>' : ""}
         ${draft.affiliate ? '<span class="pill">+ affiliate</span>' : ""}
         <span class="pill ${draft.status === "sent" ? "sent" : "pend"}">${draft.status}</span>
       </div>`
    : `<p>No ${lang.toUpperCase()} draft yet — generate this week's issue.</p>`;

  // ── Edit panel: every human-visible field of the issue, phone-friendly. ──
  const storyEditors = stories
    .map(
      (s, i) => `
      <fieldset class="card" data-story-id="${escapeHtml(s.id)}">
        <legend>Story ${i + 1}</legend>
        <label class="inc"><input type="checkbox" class="s-include" checked/> include</label>
        <label>Title<input type="text" class="s-title" value="${escapeHtml(s.title)}"/></label>
        <label>Summary<textarea class="s-summary" rows="4">${escapeHtml(s.summary)}</textarea></label>
      </fieldset>`,
    )
    .join("");

  const editPanel = draft && draft.status !== "sent"
    ? `<details id="edit">
      <summary>✏️ Edit this issue</summary>
      <div class="card">
        <label>Subject<input type="text" id="e-subject" value="${escapeHtml(draft.subject)}"/></label>
        <label>Intro<textarea id="e-intro" rows="3">${escapeHtml(draft.intro)}</textarea></label>
      </div>
      ${draft.commentary ? `<fieldset class="card"><legend>Mark's Take — ${escapeHtml(draft.commentary.title)}</legend>
        <label class="inc"><input type="checkbox" id="e-commentary-inc" checked/> include</label>
        <label>Blurb<textarea id="e-commentary-blurb" rows="2">${escapeHtml(draft.commentary.blurb)}</textarea></label>
      </fieldset>` : ""}
      ${storyEditors}
      <fieldset class="card"><legend>Laugh More corner</legend>
        <label>Fun fact (empty = drop the section)<textarea id="e-funfact" rows="3">${escapeHtml(draft.funFact ?? "")}</textarea></label>
        ${draft.photo ? `<label class="inc"><input type="checkbox" id="e-photo-inc" checked/> keep photo (${escapeHtml(draft.photo.photographer || "Pexels")})</label>` : ""}
      </fieldset>
      ${draft.video ? `<fieldset class="card"><legend>Video — ${escapeHtml(draft.video.title)}</legend>
        <label class="inc"><input type="checkbox" id="e-video-inc" checked/> include</label>
        <label>Blurb<textarea id="e-video-blurb" rows="2">${escapeHtml(draft.video.blurb)}</textarea></label>
      </fieldset>` : ""}
      ${draft.affiliate ? `<fieldset class="card"><legend>Affiliate — ${escapeHtml(draft.affiliate.title)}</legend>
        <label class="inc"><input type="checkbox" id="e-affiliate-inc" checked/> include</label>
        <label>Blurb<textarea id="e-affiliate-blurb" rows="2">${escapeHtml(draft.affiliate.blurb)}</textarea></label>
      </fieldset>` : ""}
      <div class="card">
        <label>P.S. (agency)<textarea id="e-ps" rows="2">${escapeHtml(draft.agencyPs)}</textarea></label>
        <button class="save" onclick="saveEdits()">💾 Save changes &amp; refresh preview</button>
      </div>
    </details>`
    : "";

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
 details#edit{margin:0 0 14px}
 details#edit>summary{cursor:pointer;font-weight:800;font-size:15px;padding:10px 14px;background:#fff;border:1px solid #d1d5db;border-radius:10px}
 .card{background:#fff;border:1px solid #d1d5db;border-radius:10px;padding:12px 14px;margin:10px 0}
 fieldset.card{border:1px solid #d1d5db}
 .card legend{font-weight:700;font-size:13px;padding:0 6px}
 .card label{display:block;font-size:12px;font-weight:700;color:#374151;margin:8px 0 2px}
 .card label.inc{display:flex;align-items:center;gap:6px;font-size:13px}
 .card input[type=text],.card textarea{width:100%;box-sizing:border-box;font:400 16px/1.5 -apple-system,Segoe UI,Arial,sans-serif;border:1px solid #cbd5e1;border-radius:8px;padding:8px 10px;margin-top:3px;background:#fbfdff}
 button.save{border:0;border-radius:8px;padding:11px 16px;font-weight:700;color:#fff;cursor:pointer;background:#7c3aed;margin-top:10px;width:100%;font-size:15px}
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
  ${editPanel}
  ${preview}
</div>
<script>
 var TOKEN=${t}; var LANG=${JSON.stringify(lang)}; var OTHER=${JSON.stringify(other)};
 function saveEdits(){
   var msg=document.getElementById('msg');
   var body={
     subject:val('e-subject'), intro:val('e-intro'), agencyPs:val('e-ps'),
     funFact:val('e-funfact'), stories:[]
   };
   document.querySelectorAll('[data-story-id]').forEach(function(f){
     if(!f.querySelector('.s-include').checked) return;
     body.stories.push({ id:f.getAttribute('data-story-id'),
       title:f.querySelector('.s-title').value, summary:f.querySelector('.s-summary').value });
   });
   if(body.stories.length===0){ msg.textContent='Keep at least one story in the issue.'; return; }
   addBlock(body,'commentary'); addBlock(body,'video'); addBlock(body,'affiliate');
   var photoInc=document.getElementById('e-photo-inc');
   if(photoInc && !photoInc.checked) body.removePhoto=true;
   msg.textContent='Saving…';
   fetch('/api/newsletter/draft/update?lang='+LANG,{method:'POST',
     headers:{'x-affiliate-token':TOKEN,'content-type':'application/json'},
     body:JSON.stringify(body)})
     .then(function(r){return r.json();})
     .then(function(j){ if(j.success){location.reload();} else {msg.textContent='Failed: '+(j.error||'error');} })
     .catch(function(){ msg.textContent='Network error'; });
 }
 function val(id){ var el=document.getElementById(id); return el?el.value:undefined; }
 function addBlock(body,kind){
   var inc=document.getElementById('e-'+kind+'-inc');
   if(inc && !inc.checked){ body['remove'+kind.charAt(0).toUpperCase()+kind.slice(1)]=true; return; }
   var blurb=val('e-'+kind+'-blurb');
   if(typeof blurb==='string') body[kind+'Blurb']=blurb;
 }
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
