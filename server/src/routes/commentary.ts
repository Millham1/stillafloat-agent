import { Router, type IRouter, type Request, type Response, json as expressJson } from "express";
import crypto from "crypto";
import { PATHS, readJson, writeJson } from "../lib/persistence";
import {
  draftWeeklyCommentary,
  loadCommentaryDraft,
  saveCommentaryDraft,
  weaveCommentary,
} from "../lib/commentary-agent";

const router: IRouter = Router();

export interface CommentaryPost {
  id: string;
  title: string;
  body_en: string;
  body_es: string;
  tags: string[];
  status: "published" | "unpublished";
  published_at: string;
  updated_at: string;
  videoUrl?: string;
  imageUrl?: string;
}

interface CommentaryStore {
  posts: CommentaryPost[];
}

async function getStore(): Promise<CommentaryStore> {
  return readJson<CommentaryStore>(PATHS.commentary, { posts: [] });
}

async function saveStore(store: CommentaryStore): Promise<void> {
  await writeJson(PATHS.commentary, store);
}

function checkToken(req: Request): boolean {
  const expected = process.env["AGENT_APPROVAL_TOKEN"];
  if (!expected) return false;
  const header = req.headers["x-affiliate-token"];
  const query = req.query["token"];
  const provided = (Array.isArray(header) ? header[0] : header) ?? String(query ?? "");
  return provided === expected;
}

function stripHtml(str: string): string {
  return String(str).replace(/<[^>]*>/g, "");
}

// GET /api/commentary
// Returns posts sorted newest-first.
// Unauthenticated callers only see published posts (default).
// Authenticated callers (valid token) can pass ?status=unpublished or see all via ?status=all.
// Optional: ?id=<uuid> for single post lookup.
router.get("/commentary", async (req: Request, res: Response) => {
  try {
    const store = await getStore();
    const authed = checkToken(req);

    if (req.query["id"]) {
      const post = store.posts.find((p) => p.id === String(req.query["id"]));
      if (!post) {
        res.status(404).json({ success: false, error: "Post not found" });
        return;
      }
      if (post.status === "unpublished" && !authed) {
        res.status(404).json({ success: false, error: "Post not found" });
        return;
      }
      res.json({ success: true, post });
      return;
    }

    let posts = [...store.posts].sort(
      (a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
    );

    const statusFilter = String(req.query["status"] || "").toLowerCase();
    if (!authed) {
      // Public callers: always only published, ignore status param
      posts = posts.filter((p) => p.status === "published");
    } else if (statusFilter && statusFilter !== "all") {
      posts = posts.filter((p) => p.status === statusFilter);
    }

    res.json({ success: true, count: posts.length, posts });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

async function autoTranslate(text: string): Promise<string> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey || !text.trim()) return "";
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a professional translator. Translate the following English text to Latin American Spanish (es-419). Preserve ALL HTML tags exactly as-is — only translate the visible text content between tags. Preserve the tone, personality, paragraph structure, and formatting. Return only the translated HTML — no explanations, no preamble.",
          },
          { role: "user", content: text },
        ],
        temperature: 0.3,
      }),
    });
    if (!response.ok) return "";
    const data = (await response.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content?.trim() ?? "";
  } catch {
    return "";
  }
}

// POST /api/commentary — create and immediately publish a post
// If body_es is omitted or empty, it is auto-translated from body_en via OpenAI.
router.post("/commentary", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  try {
    const { title, body_en, body_es, tags, videoUrl, imageUrl } = req.body as {
      title?: string;
      body_en?: string;
      body_es?: string;
      tags?: string[];
      videoUrl?: string;
      imageUrl?: string;
    };
    if (!title || !body_en) {
      res.status(400).json({ success: false, error: "title and body_en are required" });
      return;
    }
    const resolvedBodyEs = (body_es || "").trim()
      ? String(body_es)
      : await autoTranslate(String(body_en));
    const store = await getStore();
    const now = new Date().toISOString();
    const post: CommentaryPost = {
      id: crypto.randomUUID(),
      title: stripHtml(String(title)),
      body_en: String(body_en),
      body_es: resolvedBodyEs,
      tags: Array.isArray(tags) ? tags.map(String) : [],
      status: "published",
      published_at: now,
      updated_at: now,
      ...(videoUrl ? { videoUrl: String(videoUrl) } : {}),
      ...(imageUrl ? { imageUrl: String(imageUrl) } : {}),
    };
    store.posts.unshift(post);
    await saveStore(store);
    res.json({ success: true, post });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// PATCH /api/commentary/:id — update title, body, tags, status, videoUrl, imageUrl
router.patch("/commentary/:id", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  try {
    const store = await getStore();
    const idx = store.posts.findIndex((p) => p.id === req.params["id"]);
    if (idx === -1) {
      res.status(404).json({ success: false, error: "Post not found" });
      return;
    }
    const post = store.posts[idx]!;
    const { title, body_en, body_es, tags, status, videoUrl, imageUrl } = req.body as Partial<CommentaryPost>;
    if (title !== undefined) post.title = stripHtml(String(title));
    if (body_en !== undefined) post.body_en = String(body_en);
    if (body_es !== undefined) post.body_es = String(body_es);
    if (tags !== undefined) post.tags = Array.isArray(tags) ? tags.map(String) : [];
    if (status !== undefined) post.status = status as "published" | "unpublished";
    if (videoUrl !== undefined) post.videoUrl = videoUrl ? String(videoUrl) : undefined;
    if (imageUrl !== undefined) post.imageUrl = imageUrl ? String(imageUrl) : undefined;
    post.updated_at = new Date().toISOString();
    await saveStore(store);
    res.json({ success: true, post });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// DELETE /api/commentary/:id
router.delete("/commentary/:id", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  try {
    const store = await getStore();
    const before = store.posts.length;
    store.posts = store.posts.filter((p) => p.id !== req.params["id"]);
    if (store.posts.length === before) {
      res.status(404).json({ success: false, error: "Post not found" });
      return;
    }
    await saveStore(store);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// POST /api/translate-commentary — return Spanish translation without saving
router.post("/translate-commentary", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  try {
    const { text } = req.body as { text?: string };
    if (!text) {
      res.status(400).json({ success: false, error: "text is required" });
      return;
    }
    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      res.status(503).json({ success: false, error: "OpenAI not configured" });
      return;
    }
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a professional translator. Translate the following English text to Latin American Spanish (es-419). Preserve the tone, personality, paragraph structure, and formatting. Return only the translated text — no explanations, no preamble.",
          },
          { role: "user", content: String(text) },
        ],
        temperature: 0.3,
      }),
    });
    if (!response.ok) {
      const err = await response.text();
      res.status(502).json({ success: false, error: `OpenAI error: ${err}` });
      return;
    }
    const data = (await response.json()) as { choices: { message: { content: string } }[] };
    const translation = data.choices[0]?.message?.content?.trim() ?? "";
    res.json({ success: true, translation });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// POST /api/transcribe — OpenAI Whisper audio transcription
// Body (JSON): { audioBase64: string, fileName?: string, mimeType?: string }
// Uses a 25 MB body limit to accommodate base64-encoded audio files
router.post("/transcribe", expressJson({ limit: "25mb" }), async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  try {
    const { audioBase64, fileName, mimeType } = req.body as {
      audioBase64?: string;
      fileName?: string;
      mimeType?: string;
    };
    if (!audioBase64) {
      res.status(400).json({ success: false, error: "audioBase64 is required" });
      return;
    }
    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      res.status(503).json({ success: false, error: "OpenAI not configured" });
      return;
    }
    const buffer = Buffer.from(audioBase64, "base64");
    const mime = mimeType || "audio/webm";
    const name = fileName || "audio.webm";
    const blob = new Blob([buffer], { type: mime });
    const file = new File([blob], name, { type: mime });

    const formData = new FormData();
    formData.append("file", file);
    formData.append("model", "whisper-1");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });
    if (!response.ok) {
      const err = await response.text();
      res.status(502).json({ success: false, error: `OpenAI Whisper error: ${err}` });
      return;
    }
    const data = (await response.json()) as { text: string };
    res.json({ success: true, transcript: data.text });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// COMMENTARY AGENT surface — weekly draft → Mark adds his take → weave →
// publish (into the CMS above, which auto-translates ES). Approve-first: the
// cron only drafts and nudges; nothing publishes without Mark's button press.
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/commentary/draft — generate (or regenerate) this week's draft
router.post("/commentary/draft", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  try {
    const notify = (req.body as { notify?: boolean } | undefined)?.notify !== false;
    const draft = await draftWeeklyCommentary({ notify });
    res.json({ success: true, draft });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// GET /api/commentary/draft — current draft state
router.get("/commentary/draft", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  res.json({ success: true, draft: await loadCommentaryDraft() });
});

// POST /api/commentary/weave — { context } → rewrite draft with Mark's take
router.post("/commentary/weave", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  try {
    const context = String((req.body as { context?: string } | undefined)?.context ?? "").trim();
    if (!context) {
      res.status(400).json({ success: false, error: "context is required" });
      return;
    }
    const draft = await weaveCommentary(context);
    res.json({ success: true, draft });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// POST /api/commentary/publish-draft — publish the woven draft to the site
router.post("/commentary/publish-draft", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  try {
    const draft = await loadCommentaryDraft();
    if (!draft || draft.status !== "pending") {
      res.status(400).json({ success: false, error: "No pending commentary draft" });
      return;
    }
    const store = await getStore();
    const now = new Date().toISOString();
    const post: CommentaryPost = {
      id: crypto.randomUUID(),
      title: stripHtml(draft.suggestedTitle),
      body_en: draft.draftHtml,
      body_es: await autoTranslate(draft.draftHtml),
      tags: draft.tags,
      status: "published",
      published_at: now,
      updated_at: now,
    };
    store.posts.unshift(post);
    await saveStore(store);
    draft.status = "published";
    await saveCommentaryDraft(draft);
    res.json({ success: true, post });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// POST /api/commentary/draft/discard — skip this week
router.post("/commentary/draft/discard", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  const draft = await loadCommentaryDraft();
  if (draft && draft.status === "pending") {
    draft.status = "discarded";
    await saveCommentaryDraft(draft);
  }
  res.json({ success: true });
});

// GET /api/commentary/review?token=… — self-contained review page:
// story + draft preview + the agent's questions + a textarea for Mark's take.
router.get("/commentary/review", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).send("Unauthorized");
    return;
  }
  const draft = await loadCommentaryDraft();
  const token = String(req.query["token"] ?? "");
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const body = !draft || draft.status !== "pending"
    ? `<p class="muted">No pending commentary draft. Generate one below.</p>
       <button class="btn" onclick="gen()">Generate this week's draft</button>`
    : `
  <div class="panel">
    <div class="label">Featured story</div>
    <h2>${esc(draft.story.title)}</h2>
    <p class="muted">${esc(draft.story.summary)}</p>
    ${draft.story.link ? `<a href="${esc(draft.story.link)}" target="_blank" rel="noopener">Original article →</a>` : ""}
  </div>
  <div class="panel">
    <div class="label">Draft commentary ${draft.wovenAt ? "(woven with your take)" : "(analysis only — your take not added yet)"}</div>
    <h2>${esc(draft.suggestedTitle)}</h2>
    <div class="body">${draft.draftHtml}</div>
  </div>
  <div class="panel">
    <div class="label">Your take — the agent asks:</div>
    <ul>${draft.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>
    <textarea id="ctx" rows="7" placeholder="Type your take — experiences, opinions, what you'd tell a client. The agent weaves it in using only what you write.">${esc(draft.markContext)}</textarea>
    <div class="row">
      <button class="btn" onclick="weave()">Weave my take &amp; regenerate</button>
      <button class="btn primary" onclick="publish()">Publish to site</button>
      <button class="btn danger" onclick="discard()">Skip this week</button>
    </div>
    <p class="muted small">Publish posts the woven draft to the Commentary section (Spanish version auto-translated). Nothing posts without this button.</p>
  </div>`;

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Commentary Review — Still Afloat</title>
<style>
body{font-family:system-ui,sans-serif;background:#0b2238;color:#fff;margin:0;padding:20px;max-width:760px;margin:auto}
h1{font-size:22px}h2{font-size:19px;margin:6px 0 10px}
.panel{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:16px 18px;margin:14px 0}
.label{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#5dff9a;margin-bottom:6px}
.body p{line-height:1.65;color:rgba(255,255,255,.9)}
.muted{color:rgba(255,255,255,.65)}.small{font-size:12px}
textarea{width:100%;box-sizing:border-box;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.25);color:#fff;padding:10px;font-size:15px}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
.btn{padding:12px 18px;border-radius:999px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#fff;font-weight:700;cursor:pointer}
.btn.primary{background:#0e7a3d;border-color:#17a457}.btn.danger{border-color:rgba(255,90,90,.5)}
a{color:#7de3ff}
</style></head><body>
<h1>🗣️ Weekly Commentary</h1>
${body}
<script>
const TOKEN=${JSON.stringify(token)};
async function call(path, payload){
  const r=await fetch(path,{method:"POST",headers:{"content-type":"application/json","x-affiliate-token":TOKEN},body:JSON.stringify(payload||{})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||d.success===false){alert(d.error||("HTTP "+r.status));return false}
  return true;
}
async function gen(){ if(await call("/api/commentary/draft",{notify:false})) location.reload(); }
async function weave(){
  const ctx=document.getElementById("ctx").value.trim();
  if(!ctx){alert("Type your take first — that's the whole point!");return}
  if(await call("/api/commentary/weave",{context:ctx})) location.reload();
}
async function publish(){
  if(!confirm("Publish this commentary to the website?"))return;
  if(await call("/api/commentary/publish-draft")) { alert("Published!"); location.reload(); }
}
async function discard(){ if(confirm("Skip this week?") && await call("/api/commentary/draft/discard")) location.reload(); }
</script>
</body></html>`);
});

export default router;
