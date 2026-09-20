import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken, extractToken } from "../lib/http-auth";
import {
  draftNewsletter,
  saveDraft,
  loadDraft,
  startNewsletterSend,
  deliveryOpen,
  renderEnrichedNewsletter,
  gatherApprovedStories,
  type NewsletterDraft,
} from "../lib/newsletter";
import { deliveryCounts } from "../lib/newsletter-delivery";
import type { Lang } from "../lib/social-agent";
import { notifyMark, reviewUrl } from "../lib/notify";

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
    if (deliveryOpen(await loadDraft(lang))) {
      res.status(409).json({ success: false, error: "The current issue is still going out (or waiting on its retry) — generate the next one once it has finished." });
      return;
    }
    const draft = await draftNewsletter(lang);
    await saveDraft(draft);
    res.json({ success: true, draft });
    void notifyMark({
      title: `📨 Newsletter draft ready (${lang.toUpperCase()})`,
      body: [draft.subject, `${draft.storyIds.length} stories${draft.video ? " + video" : ""}${draft.affiliate ? " + affiliate" : ""}`].join("\n"),
      url: reviewUrl(`/api/newsletter/review?lang=${lang}`),
      tag: "newsletter-review",
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
    if (draft.status !== "pending") {
      res.status(409).json({ success: false, error: draft.status === "sending" ? "This issue is going out right now — it can't be edited" : "Draft already sent — generate a new one first" });
      return;
    }
    const body = req.body as {
      subject?: string;
      letterTitle?: string;
      letter?: string;
      quickHits?: Array<{ text?: string; url?: string } | string>;
      bookingHeadline?: string;
      bookingBody?: string;
      agencyPs?: string;
      sunnySide?: string;
      pps?: string;
      photoCaption?: string;
      videoTitle?: string;
      videoBlurb?: string;
      affiliateBlurb?: string;
      removePhoto?: boolean;
      removeVideo?: boolean;
      removeAffiliate?: boolean;
      removeBooking?: boolean;
    };

    if (typeof body.subject === "string" && body.subject.trim()) draft.subject = body.subject.trim();
    if (typeof body.letterTitle === "string") {
      const lt = body.letterTitle.trim();
      if (lt) draft.letterTitle = lt;
      else delete draft.letterTitle;
    }
    if (typeof body.letter === "string") draft.letter = body.letter.trim();
    if (typeof body.agencyPs === "string") draft.agencyPs = body.agencyPs.trim();
    if (Array.isArray(body.quickHits)) {
      draft.quickHits = body.quickHits
        .map((h) => {
          if (typeof h === "string") return { text: h.trim() };
          const hit: { text: string; url?: string } = { text: String(h.text ?? "").trim() };
          const u = String(h.url ?? "").trim();
          if (u) hit.url = u;
          return hit;
        })
        .filter((h) => h.text)
        .slice(0, 6);
    }
    if (typeof body.bookingHeadline === "string" || typeof body.bookingBody === "string") {
      const current = draft.booking ?? { headline: "", body: "" };
      draft.booking = {
        headline: typeof body.bookingHeadline === "string" && body.bookingHeadline.trim() ? body.bookingHeadline.trim() : current.headline,
        body: typeof body.bookingBody === "string" && body.bookingBody.trim() ? body.bookingBody.trim() : current.body,
      };
    }
    if (typeof body.sunnySide === "string") {
      const s = body.sunnySide.trim();
      if (s) draft.sunnySide = s;
      else delete draft.sunnySide;
    }
    if (typeof body.pps === "string") {
      const p = body.pps.trim();
      if (p) draft.pps = p;
      else delete draft.pps;
    }
    if (typeof body.photoCaption === "string") {
      const c = body.photoCaption.trim();
      if (c) draft.photoCaption = c;
      else delete draft.photoCaption;
    }
    if (draft.video && typeof body.videoTitle === "string" && body.videoTitle.trim()) draft.video.title = body.videoTitle.trim();
    if (draft.video && typeof body.videoBlurb === "string") draft.video.blurb = body.videoBlurb.trim();
    if (draft.affiliate && typeof body.affiliateBlurb === "string") draft.affiliate.blurb = body.affiliateBlurb.trim();
    if (body.removePhoto) delete draft.photo;
    if (body.removeVideo) delete draft.video;
    if (body.removeAffiliate) delete draft.affiliate;
    if (body.removeBooking) delete draft.booking;

    if (!draft.letter && (draft.quickHits ?? []).length === 0 && !draft.booking) {
      res.status(400).json({ success: false, error: "The issue can't be empty — keep a letter, quick hits, or the booking section" });
      return;
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
    if (draft.status !== "pending") {
      res.status(409).json({ success: false, error: draft.status === "sending" ? "This issue is already going out." : "This issue was already sent — generate a new one first." });
      return;
    }
    // Returns at once: the emails go out one every 45s in the background, then a push reports
    // the true delivered count after the bounce check.
    const started = await startNewsletterSend(draft);
    res.json({ success: true, lang, started: true, ...started });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// POST /api/newsletter/notify — review nudge for the current draft (manual/test).
router.post("/newsletter/notify", requireToken, async (req: Request, res: Response) => {
  const lang = editionLang(req);
  const draft = await loadDraft(lang);
  if (!draft) {
    res.status(404).json({ success: false, error: "No draft to notify about" });
    return;
  }
  const channel = await notifyMark({
    title: `📨 Newsletter draft awaiting review (${lang.toUpperCase()})`,
    body: draft.subject,
    url: reviewUrl(`/api/newsletter/review?lang=${lang}`),
    tag: "newsletter-review",
  });
  res.json({ success: channel !== "none", channel });
});

// GET /api/newsletter/review?token=…&lang=en|es — review surface: live preview + actions.
router.get("/newsletter/review", requireToken, async (req: Request, res: Response) => {
  const token = extractToken(req);
  const lang = editionLang(req);
  const draft = await loadDraft(lang);
  const t = JSON.stringify(token);
  const other: Lang = lang === "es" ? "en" : "es";

  const meta = draft
    ? `<div class="meta">
         <span class="pill">Subject: ${escapeHtml(draft.subject)}</span>
         ${draft.letter ? '<span class="pill">letter</span>' : ""}
         ${draft.booking ? '<span class="pill">booking CTA</span>' : ""}
         <span class="pill">${(draft.quickHits ?? []).length} quick hits</span>
         ${draft.sunnySide ? '<span class="pill">+ sunny side</span>' : ""}
         ${draft.photo ? '<span class="pill">+ photo</span>' : ""}
         ${draft.video ? '<span class="pill">+ video</span>' : ""}
         ${draft.affiliate ? '<span class="pill">+ affiliate</span>' : ""}
         <span class="pill ${draft.status === "sent" ? "sent" : "pend"}">${draft.status}</span>
       </div>${deliveryLine(draft.delivery)}`
    : `<p>No ${lang.toUpperCase()} draft yet — generate this week's issue.</p>`;

  // ── Edit panel: every human-visible field of the issue, phone-friendly. ──
  const hitEditors = (draft?.quickHits ?? [])
    .map((h) => {
      const text = typeof h === "string" ? h : h.text;
      const url = typeof h === "string" ? "" : (h.url ?? "");
      return `<label>Quick hit (empty = drop it)<textarea class="s-hit" rows="2" data-url="${escapeHtml(url)}">${escapeHtml(text)}</textarea></label>`;
    })
    .join("");

  const editPanel = draft && draft.status !== "sent"
    ? `<details id="edit">
      <summary>✏️ Edit this issue</summary>
      <div class="card">
        <label>Subject<input type="text" id="e-subject" value="${escapeHtml(draft.subject)}"/></label>
        <label>Letter headline (your voice, e.g. “And the winner of the Darwin Award for Cruisers is……”)<input type="text" id="e-lettertitle" value="${escapeHtml(draft.letterTitle ?? "")}"/></label>
        <label>Your letter (opens the email, signed “— Mark”)<textarea id="e-letter" rows="7">${escapeHtml(draft.letter ?? draft.intro ?? "")}</textarea></label>
      </div>
      <fieldset class="card"><legend>Worth booking this week (the main CTA)</legend>
        <label class="inc"><input type="checkbox" id="e-booking-inc" ${draft.booking ? "checked" : ""}/> include</label>
        <label>Headline<input type="text" id="e-booking-headline" value="${escapeHtml(draft.booking?.headline ?? "")}"/></label>
        <label>Pitch<textarea id="e-booking-body" rows="3">${escapeHtml(draft.booking?.body ?? "")}</textarea></label>
      </fieldset>
      <fieldset class="card"><legend>Quick hits (plain one-liners, no links)</legend>
        ${hitEditors || "<p style='font-size:13px;color:#6b7280;margin:6px 0'>None this week.</p>"}
        <label>Add another<textarea class="s-hit" rows="2"></textarea></label>
      </fieldset>
      <fieldset class="card"><legend>The Sunny Side (Laugh More)</legend>
        <label>Sunny Side passage (empty = drop it)<textarea id="e-sunnyside" rows="4">${escapeHtml(draft.sunnySide ?? "")}</textarea></label>
        ${draft.photo ? `<label>Photo caption<textarea id="e-photocaption" rows="2">${escapeHtml(draft.photoCaption ?? "")}</textarea></label>
        <label class="inc"><input type="checkbox" id="e-photo-inc" checked/> keep photo (${escapeHtml(draft.photo.photographer || "Pexels")})</label>` : ""}
      </fieldset>
      ${draft.video ? `<fieldset class="card"><legend>Video</legend>
        <label class="inc"><input type="checkbox" id="e-video-inc" checked/> include</label>
        <label>Card headline<input type="text" id="e-video-title" value="${escapeHtml(draft.video.title)}"/></label>
        <label>Blurb<textarea id="e-video-blurb" rows="2">${escapeHtml(draft.video.blurb)}</textarea></label>
      </fieldset>` : ""}
      ${draft.affiliate ? `<fieldset class="card"><legend>Gear pick — ${escapeHtml(draft.affiliate.title)}</legend>
        <label class="inc"><input type="checkbox" id="e-affiliate-inc" checked/> include</label>
        <label>Blurb<textarea id="e-affiliate-blurb" rows="2">${escapeHtml(draft.affiliate.blurb)}</textarea></label>
      </fieldset>` : ""}
      <div class="card">
        <label>P.S. (booking nudge)<textarea id="e-ps" rows="2">${escapeHtml(draft.agencyPs)}</textarea></label>
        <label>P.P.S. (playful sign-off, empty = drop it)<textarea id="e-pps" rows="2">${escapeHtml(draft.pps ?? "")}</textarea></label>
        <button class="save" onclick="saveEdits()">💾 Save changes &amp; refresh preview</button>
      </div>
    </details>`
    : "";

  const preview = draft
    ? `<iframe title="preview" src="/api/newsletter/email?lang=${lang}&token=${encodeURIComponent(token)}" style="width:100%;height:78vh;border:0;border-radius:14px;background:#04112e;"></iframe>`
    : "";

  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>Still Afloat — Newsletter Review (${lang.toUpperCase()})</title>
<style>
 body{margin:0;font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#04112e;color:#111827}
 header{background:#07183f;color:#fff;padding:14px 18px;position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
 header h1{margin:0;font-size:17px}
 .btns button{border:0;border-radius:8px;padding:9px 14px;font-weight:700;color:#fff;cursor:pointer;margin-left:6px}
 .gen{background:#0077b6}.send{background:#16a34a}
 .langtabs a{display:inline-block;padding:5px 12px;border-radius:7px;font-size:13px;font-weight:700;text-decoration:none;margin-right:6px}
 .langtabs a.on{background:#5dff9a;color:#07183f}.langtabs a.off{background:rgba(255,255,255,.15);color:#fff}
 .wrap{max-width:640px;margin:0 auto;padding:16px 8px 50px}
 .meta{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}
 .pill{font-size:12px;background:#fff;border:1px solid #d1d5db;border-radius:6px;padding:3px 9px}
 .pill.pend{background:#fef3c7;border-color:#fde68a;color:#92400e}
 .pill.sent{background:#dcfce7;border-color:#bbf7d0;color:#166534}
 #msg{font-size:13px;color:#cbd5e1;margin:8px 0}
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
     subject:val('e-subject'), letterTitle:val('e-lettertitle'), letter:val('e-letter'), agencyPs:val('e-ps'),
     sunnySide:val('e-sunnyside'), pps:val('e-pps'), photoCaption:val('e-photocaption'), quickHits:[]
   };
   document.querySelectorAll('.s-hit').forEach(function(el){
     if(el.value && el.value.trim()) body.quickHits.push({text:el.value.trim(), url:el.getAttribute('data-url')||''});
   });
   var bookInc=document.getElementById('e-booking-inc');
   if(bookInc && !bookInc.checked){ body.removeBooking=true; }
   else { body.bookingHeadline=val('e-booking-headline'); body.bookingBody=val('e-booking-body'); }
   body.videoTitle=val('e-video-title');
   addBlock(body,'video'); addBlock(body,'affiliate');
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
     .then(r=>r.json()).then(j=>{ document.getElementById('msg').textContent = j.success ? ('Sending to '+j.total+' subscriber'+(j.total===1?'':'s')+', one every 45 seconds (about '+j.minutes+' min). You will get a notification with the delivered count; refresh this page to watch it.') : ('Failed: '+(j.error||'error')); })
     .catch(()=>document.getElementById('msg').textContent='Network error');
 }
</script>
</body></html>`);
});

// Who got this issue: the ledger's true counts, and anyone held back with the server's reason.
function deliveryLine(d: NewsletterDraft["delivery"]): string {
  if (!d) return "";
  const c = deliveryCounts(d);
  const who = (rs: typeof c.retrying): string => rs.map((r) => `${escapeHtml(r.email)}${r.note ? ` — ${escapeHtml(r.note)}` : ""}`).join("<br/>");
  const retryAt = d.retryAt
    ? new Date(d.retryAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: process.env["TIMEZONE"] || "America/New_York" })
    : "";
  return `<div class="card" style="font-size:16px;color:#07183f">
    <b>Delivered to ${c.delivered} of ${c.total}</b>${c.queued ? ` · ${c.queued} still to go (one every 45 seconds)` : ""}${d.bounceCheck === "unavailable" ? " · bounce check could not run, count unconfirmed" : ""}
    ${c.retrying.length ? `<br/>Held by the mail server${retryAt ? `, trying again at ${retryAt}` : ""}:<br/>${who(c.retrying)}` : ""}
    ${c.undeliverable.length ? `<br/>Not delivered:<br/>${who(c.undeliverable)}` : ""}
  </div>`;
}

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export default router;
