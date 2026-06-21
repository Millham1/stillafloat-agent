import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken, extractToken } from "../lib/http-auth";
import {
  generateSocialBatch,
  enqueueBatch,
  loadQueue,
  setBatchStatus,
  scanAndQueue,
  regenerateQueue,
  type Track,
  type Lang,
  type SocialVideo,
} from "../lib/social-agent";
import { logger } from "../lib/logger";
import { notifyTelegram, reviewUrl } from "../lib/telegram";
import { publishBatch, loadMediaMap, setMedia } from "../lib/social-publish";
import {
  scheduleApprovedBatch,
  listSchedule,
  loadScheduleConfig,
  saveScheduleConfig,
  type ScheduleConfig,
} from "../lib/social-schedule";

const router: IRouter = Router();

// POST /api/social/generate — generate a batch for one video and queue it.
// Body: { videoId, title, lang, track?, format? }
router.post("/social/generate", requireToken, async (req: Request, res: Response) => {
  try {
    const { videoId, title, lang, track, format, transcript } = req.body as {
      videoId?: string;
      title?: string;
      lang?: Lang;
      track?: Track;
      format?: "short" | "long";
      transcript?: string;
    };
    if (!videoId || !title || (lang !== "en" && lang !== "es")) {
      res.status(400).json({ success: false, error: "videoId, title and lang('en'|'es') are required" });
      return;
    }
    const resolvedTrack: Track = track === "A" || track === "B" ? track : lang === "es" ? "A" : "B";
    const video: SocialVideo = { id: videoId, title, lang, ...(format ? { format } : {}) };
    const batch = await generateSocialBatch(video, resolvedTrack, transcript);
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

// POST /api/social/regenerate — pull every hook in the current campaign back to
// pending and regenerate the copy with the latest logic (transcript grounding).
// Runs in the background (many sequential OpenAI calls) so the request returns
// immediately; a single Telegram fires when the fresh batches are ready.
router.post("/social/regenerate", requireToken, async (_req: Request, res: Response) => {
  const queue = await loadQueue();
  const targets = new Set(queue.batches.map((b) => `${b.videoId}:${b.track}`)).size;
  if (targets === 0) {
    res.json({ success: true, started: false, message: "Queue is empty — nothing to regenerate." });
    return;
  }
  res.json({ success: true, started: true, regenerating: targets });
  void (async () => {
    try {
      const fresh = await regenerateQueue();
      if (fresh.length > 0) {
        await notifyTelegram({
          heading: `♻️ <b>${fresh.length} hook(s) regenerated</b>`,
          lines: fresh.map((b) => `Track ${b.track}: ${b.title}`),
          url: reviewUrl("/api/social/review"),
          buttonLabel: `Review ${fresh.length} →`,
        });
      }
    } catch (err) {
      logger.error({ err }, "social/regenerate failed");
    }
  })();
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
    // Approved. Default = SCHEDULE: spread the posts across the calendar; the
    // poster cron sends each at its slot time. `?mode=now` posts immediately
    // (the old behavior) for an urgent/test push.
    const mode = String(req.query["mode"] ?? "");
    if (mode === "now") {
      const publish = await publishBatch(batch);
      const anyPosted = publish.some((p) => p.ok);
      const finalBatch = anyPosted ? await setBatchStatus(batch.id, "posted") : batch;
      res.json({ success: true, id: batch.id, status: finalBatch?.status ?? "approved", mode: "now", publish });
      return;
    }
    const scheduled = await scheduleApprovedBatch(batch);
    const slots = scheduled.posts
      .filter((p) => p.scheduledFor)
      .map((p) => ({ surface: p.surface, platform: p.platform, scheduledFor: p.scheduledFor }));
    res.json({ success: true, id: batch.id, status: scheduled.status, mode: "scheduled", slots });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// GET /api/social/media — registered hosted clip URLs (videoId → Cloudinary URL).
router.get("/social/media", requireToken, async (_req: Request, res: Response) => {
  const map = await loadMediaMap();
  res.json({ success: true, items: map.items });
});

// POST /api/social/media — register a hosted clip URL for a video.
// Body: { videoId, videoUrl }  (videoUrl = public Cloudinary/CDN .mp4 for IG Reels / FB video)
router.post("/social/media", requireToken, async (req: Request, res: Response) => {
  const { videoId, videoUrl } = req.body as { videoId?: string; videoUrl?: string };
  if (!videoId || !videoUrl || !/^https?:\/\//.test(videoUrl)) {
    res.status(400).json({ success: false, error: "videoId and a public http(s) videoUrl are required" });
    return;
  }
  await setMedia(videoId, videoUrl);
  res.json({ success: true, videoId, videoUrl });
});

// GET /api/social/config — Cloudinary upload config for the uploader page.
router.get("/social/config", requireToken, (_req: Request, res: Response) => {
  res.json({
    success: true,
    cloudName: "duvhvhc2k",
    uploadPreset: process.env["CLOUDINARY_UPLOAD_PRESET"] ?? null,
  });
});

// GET /api/social/upload?token=… — drop a clip → uploads to Cloudinary (unsigned)
// → registers its URL against a videoId, readying it for Instagram Reels.
router.get("/social/upload", requireToken, (req: Request, res: Response) => {
  const token = extractToken(req);
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex,nofollow"/>
<title>Still Afloat — Clip Uploader</title>
<style>
 body{margin:0;font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f3f4f6;color:#111827}
 header{background:#0f766e;color:#fff;padding:14px 18px}header h1{margin:0;font-size:17px}
 .wrap{max-width:560px;margin:0 auto;padding:20px 16px}
 label{display:block;font-size:13px;font-weight:700;margin:14px 0 4px}
 input{width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;box-sizing:border-box}
 button{margin-top:16px;background:#0f766e;color:#fff;border:0;border-radius:8px;padding:11px 18px;font-weight:700;cursor:pointer}
 button:disabled{opacity:.5}
 #msg{margin-top:14px;font-size:13px;line-height:1.6;word-break:break-all}
 .hint{color:#6b7280;font-size:12px;margin-top:4px}
</style></head><body>
<header><h1>Still Afloat — Clip Uploader</h1></header>
<div class="wrap">
 <p class="hint">Pick a Short's video file and its YouTube video ID. It uploads to Cloudinary and registers the URL for Instagram Reels.</p>
 <label>YouTube video ID</label>
 <input id="vid" placeholder="e.g. u1yqFjLVnvQ"/>
 <label>Clip file (.mp4)</label>
 <input id="file" type="file" accept="video/*"/>
 <button id="go" onclick="up()">Upload &amp; register</button>
 <div id="msg"></div>
</div>
<script>
 var TOKEN=${JSON.stringify(token)};
 var CFG=null;
 fetch('/api/social/config',{headers:{'x-affiliate-token':TOKEN}}).then(r=>r.json()).then(c=>{CFG=c;
   if(!c.uploadPreset){document.getElementById('msg').innerHTML='<b style="color:#b91c1c">Cloudinary upload preset not configured.</b> Add CLOUDINARY_UPLOAD_PRESET to the server env first.';}});
 function up(){
   var vid=document.getElementById('vid').value.trim();
   var f=document.getElementById('file').files[0];
   var msg=document.getElementById('msg');
   if(!CFG||!CFG.uploadPreset){msg.textContent='No upload preset configured.';return;}
   if(!vid||!f){msg.textContent='Need a video ID and a file.';return;}
   document.getElementById('go').disabled=true; msg.textContent='Uploading to Cloudinary…';
   var fd=new FormData(); fd.append('file',f); fd.append('upload_preset',CFG.uploadPreset);
   fetch('https://api.cloudinary.com/v1_1/'+CFG.cloudName+'/video/upload',{method:'POST',body:fd})
    .then(r=>r.json()).then(function(cu){
       if(!cu.secure_url){throw new Error(cu.error&&cu.error.message||'Cloudinary upload failed');}
       msg.textContent='Registering…';
       return fetch('/api/social/media',{method:'POST',headers:{'Content-Type':'application/json','x-affiliate-token':TOKEN},body:JSON.stringify({videoId:vid,videoUrl:cu.secure_url})}).then(r=>r.json()).then(function(j){
         msg.innerHTML = j.success ? ('✅ Registered:<br>'+cu.secure_url) : ('Register failed: '+(j.error||'error'));
       });
    }).catch(function(e){msg.textContent='Error: '+e.message;}).finally(function(){document.getElementById('go').disabled=false;});
 }
</script>
</body></html>`);
});

// GET /api/social/compose?token=… — the forward workflow: for a NEW video, paste
// its script/transcript, pick the track, and generate hooks GROUNDED in the real
// content (no YouTube scraping). Queues into the same review flow.
router.get("/social/compose", requireToken, (req: Request, res: Response) => {
  const token = extractToken(req);
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex,nofollow"/>
<title>Still Afloat — Compose Hooks</title>
<style>
 body{margin:0;font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f3f4f6;color:#111827}
 header{background:#0f766e;color:#fff;padding:14px 18px}header h1{margin:0;font-size:17px}
 .wrap{max-width:640px;margin:0 auto;padding:20px 16px}
 label{display:block;font-size:13px;font-weight:700;margin:14px 0 4px}
 input,select,textarea{width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit}
 textarea{min-height:200px;resize:vertical}
 .row{display:flex;gap:10px}.row>div{flex:1}
 button{margin-top:16px;background:#0f766e;color:#fff;border:0;border-radius:8px;padding:11px 18px;font-weight:700;cursor:pointer}
 button:disabled{opacity:.5}
 #msg{margin-top:14px;font-size:13px;line-height:1.6}
 .hint{color:#6b7280;font-size:12px;margin-top:4px}
 a{color:#0f766e}
</style></head><body>
<header><h1>Still Afloat — Compose Grounded Hooks</h1></header>
<div class="wrap">
 <p class="hint">Paste the video's <b>script / transcript</b> so the hooks describe what the video ACTUALLY contains — not just the title. Generates one batch into the review queue.</p>
 <label>YouTube video ID</label>
 <input id="vid" placeholder="e.g. OVwKK-FR1Xc"/>
 <p class="hint">From the watch URL: youtube.com/watch?v=<b>VIDEO_ID</b></p>
 <label>Title</label>
 <input id="title" placeholder="The video's title"/>
 <div class="row">
   <div>
     <label>Track</label>
     <select id="track">
       <option value="B">B — English (value / convert)</option>
       <option value="A">A — Spanish (reach)</option>
     </select>
   </div>
   <div>
     <label>Format</label>
     <select id="format">
       <option value="long">Long-form</option>
       <option value="short">Short</option>
     </select>
   </div>
 </div>
 <label>Script / transcript</label>
 <textarea id="script" placeholder="Paste the VO script or a description of what's actually in the video…"></textarea>
 <button id="go" onclick="gen()">Generate hooks →</button>
 <div id="msg"></div>
</div>
<script>
 var TOKEN=${JSON.stringify(token)};
 function gen(){
   var vid=document.getElementById('vid').value.trim();
   var title=document.getElementById('title').value.trim();
   var track=document.getElementById('track').value;
   var format=document.getElementById('format').value;
   var script=document.getElementById('script').value.trim();
   var msg=document.getElementById('msg');
   if(!vid||!title){msg.textContent='Need a video ID and title.';return;}
   if(!script){if(!confirm('No script pasted — hooks will fall back to the title only. Continue?'))return;}
   var lang = track==='A' ? 'es' : 'en';
   document.getElementById('go').disabled=true; msg.textContent='Generating grounded hooks…';
   fetch('/api/social/generate',{method:'POST',headers:{'Content-Type':'application/json','x-affiliate-token':TOKEN},
     body:JSON.stringify({videoId:vid,title:title,lang:lang,track:track,format:format,transcript:script})})
    .then(function(r){return r.json();}).then(function(j){
       if(j.success){msg.innerHTML='✅ Hooks generated for Track '+(j.batch&&j.batch.track)+'. <a href="/api/social/review?token='+encodeURIComponent(TOKEN)+'">Open the review page →</a>';}
       else{msg.textContent='Failed: '+(j.error||'error');}
    }).catch(function(e){msg.textContent='Error: '+e.message;}).finally(function(){document.getElementById('go').disabled=false;});
 }
</script>
</body></html>`);
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

// GET /api/social/schedule-config — current cadence. POST to update.
router.get("/social/schedule-config", requireToken, async (_req: Request, res: Response) => {
  res.json({ success: true, config: await loadScheduleConfig() });
});
router.post("/social/schedule-config", requireToken, async (req: Request, res: Response) => {
  const body = req.body as Partial<ScheduleConfig>;
  const current = await loadScheduleConfig();
  const next: ScheduleConfig = {
    tz: typeof body.tz === "string" && body.tz ? body.tz : current.tz,
    times: Array.isArray(body.times) && body.times.length
      ? body.times.filter((t) => /^\d{1,2}:\d{2}$/.test(t))
      : current.times,
    leadMinutes: typeof body.leadMinutes === "number" ? body.leadMinutes : current.leadMinutes,
  };
  await saveScheduleConfig(next);
  res.json({ success: true, config: next });
});

// GET /api/social/schedule?token=… — the posting calendar (HTML; ?format=json for data).
router.get("/social/schedule", requireToken, async (req: Request, res: Response) => {
  const items = await listSchedule();
  if (String(req.query["format"]) === "json") {
    res.json({ success: true, count: items.length, items });
    return;
  }
  const cfg = await loadScheduleConfig();
  res.status(200).type("html").send(renderSchedulePage(items, cfg));
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
          ${p.gloss ? `<p class="gloss">🇬🇧 ${esc(p.gloss)}</p>` : ""}
          ${p.hashtags?.length ? `<p class="tags">${esc(p.hashtags.join(" "))}</p>` : ""}
          <p class="link">${esc(p.link)}</p>
        </div>`,
        )
        .join("");
      const grounded =
        typeof b.transcriptChars === "number"
          ? b.transcriptChars > 0
            ? `<span class="grd ok" title="Hooks grounded in the video transcript">📄 transcript (${b.transcriptChars} chars)</span>`
            : `<span class="grd warn" title="No transcript was available — hooks written from the title only">⚠ no transcript — title only</span>`
          : "";
      return `
      <div class="batch" id="b-${esc(b.id)}">
        <div class="bhead">
          <div><span class="trk trk-${esc(b.track)}">Track ${esc(b.track)}</span> <strong>${esc(b.title)}</strong> ${grounded}</div>
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
 .grd{display:inline-block;font-size:11px;border-radius:5px;padding:2px 7px;margin-left:4px}
 .grd.ok{background:#dcfce7;color:#166534;border:1px solid #bbf7d0}
 .grd.warn{background:#fef3c7;color:#92400e;border:1px solid #fde68a}
 .post{border-top:1px solid #eee;padding:10px 0}
 .meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
 .pill{font-size:11px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:5px;padding:2px 7px}
 .pill.cta{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8}
 .pill.bio{background:#fef3c7;border-color:#fde68a;color:#92400e}
 .cap{margin:4px 0;font-size:15px;line-height:1.5;white-space:pre-wrap}
 .gloss{margin:2px 0 4px;font-size:13px;line-height:1.45;color:#475569;background:#f1f5f9;border-left:3px solid #94a3b8;padding:6px 9px;border-radius:4px}
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
 function fmt(s){try{return new Date(s).toLocaleString([], {weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}catch(e){return s;}}
 function decide(id,action){
   fetch('/api/social/queue/'+id+'/'+action,{method:'POST',headers:{'x-affiliate-token':TOKEN}})
     .then(function(r){return r.json();})
     .then(function(j){
       var el=document.getElementById('b-'+id);
       if(!j.success||!el){alert('Failed: '+(j.error||'error'));return;}
       el.style.opacity=.55;
       if(action==='reject'){el.querySelector('.acts').innerHTML='✕ Rejected';return;}
       var when=(j.slots&&j.slots.length)?(' — first '+fmt(j.slots[0].scheduledFor)):'';
       el.querySelector('.acts').innerHTML='✅ Scheduled'+when+' · <a href="/api/social/schedule?token='+encodeURIComponent(TOKEN)+'">calendar →</a>';
     }).catch(function(){alert('Network error');});
 }
</script>
</body></html>`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderSchedulePage(items: any[], cfg: { tz: string; times: string[] }): string {
  const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: cfg.tz, weekday: "short", month: "short", day: "numeric" });
  const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: cfg.tz, hour: "numeric", minute: "2-digit" });
  const groups = new Map<string, any[]>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const it of items) {
    const when = it.scheduledFor || it.postedAt;
    const day = when ? dayFmt.format(new Date(when)) : "Unscheduled";
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(it);
  }
  const badge = (it: { postState?: string }) => {
    if (it.postState === "posted") return '<span class="st posted">✅ posted</span>';
    if (it.postState === "failed") return '<span class="st failed">⚠ failed</span>';
    return '<span class="st sched">🕒 scheduled</span>';
  };
  const sections = [...groups.entries()].map(([day, list]) => `
    <div class="day"><h2>${esc(day)}</h2>
      ${list.map((it) => {
        const when = it.scheduledFor || it.postedAt;
        const time = when ? timeFmt.format(new Date(when)) : "—";
        return `<div class="row">
          <div class="t">${esc(time)}</div>
          <div class="body">
            <div class="line"><span class="trk trk-${esc(it.track)}">${esc(it.track)}</span>
              <span class="plat">${esc(it.platform)}</span> ${badge(it)}</div>
            <div class="cap">${esc((it.caption || "").slice(0, 120))}</div>
            <div class="ttl">${esc(it.title)}</div>
            ${it.postError ? `<div class="err">${esc(it.postError)}</div>` : ""}
          </div></div>`;
      }).join("")}
    </div>`).join("");

  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex,nofollow"/>
<title>Still Afloat — Posting Calendar</title>
<style>
 body{margin:0;font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f3f4f6;color:#111827}
 header{background:#0f766e;color:#fff;padding:14px 18px;position:sticky;top:0}
 header h1{margin:0;font-size:17px}header p{margin:4px 0 0;font-size:12px;opacity:.85}
 .wrap{max-width:760px;margin:0 auto;padding:16px 14px 60px}
 .day{margin-bottom:18px}.day h2{font-size:14px;color:#374151;border-bottom:2px solid #e5e7eb;padding-bottom:4px}
 .row{display:flex;gap:12px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:10px;margin:8px 0}
 .t{font-weight:700;font-size:14px;min-width:64px;color:#0f766e}
 .body{flex:1}.line{display:flex;gap:6px;align-items:center;margin-bottom:3px}
 .trk{font-size:11px;font-weight:700;border-radius:5px;padding:1px 6px;color:#fff}
 .trk-A{background:#7c3aed}.trk-B{background:#0369a1}
 .plat{font-size:12px;color:#374151;text-transform:capitalize}
 .st{font-size:11px;border-radius:5px;padding:1px 6px}
 .st.sched{background:#fef3c7;color:#92400e}.st.posted{background:#dcfce7;color:#166534}.st.failed{background:#fee2e2;color:#991b1b}
 .cap{font-size:13px;line-height:1.4}.ttl{font-size:11px;color:#9ca3af;margin-top:2px}
 .err{font-size:11px;color:#b91c1c;margin-top:2px}
 .empty{text-align:center;color:#6b7280;padding:50px 0}
</style></head><body>
<header><h1>Still Afloat — Posting Calendar</h1><p>Slots ${esc(cfg.times.join(", "))} · ${esc(cfg.tz)}</p></header>
<div class="wrap">${sections || '<div class="empty">Nothing scheduled yet. Approve a batch to schedule it.</div>'}</div>
</body></html>`;
}

export default router;
