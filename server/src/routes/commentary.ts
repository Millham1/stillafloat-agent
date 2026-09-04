import { Router, type IRouter, type Request, type Response, json as expressJson } from "express";
import crypto from "crypto";
import { PATHS, readJson, writeJson } from "../lib/persistence";
import {
  loadCommentaryDraft,
  saveCommentaryDraft,
  stageWeeklyCommentary,
  rejectAndRestage,
  startCommentaryRun,
  commentaryRunState,
  synthesizeCommentary,
} from "../lib/commentary-agent";

const router: IRouter = Router();

export interface CommentaryPost {
  id: string;
  title: string;
  title_es?: string;
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
    const resolvedTitleEs = stripHtml(await autoTranslate(stripHtml(String(title))));
    const store = await getStore();
    const now = new Date().toISOString();
    const post: CommentaryPost = {
      id: crypto.randomUUID(),
      title: stripHtml(String(title)),
      ...(resolvedTitleEs ? { title_es: resolvedTitleEs } : {}),
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
// COMMENTARY AGENT surface — Mark's-opinion-first pipeline: stage the story
// cluster + questions → Mark gives his take → synthesize (his stance as the
// spine, woven for impact, backed by archive research) → Mark publishes.
// Approve-first: the cron only stages and nudges; nothing publishes without
// Mark's button press.
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/commentary/draft — stage this week's ask (one subject story + questions).
// `subjectId` restages on a story Mark picked himself from the runners-up.
router.post("/commentary/draft", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  const body = req.body as { notify?: boolean; subjectId?: string } | undefined;
  const notify = body?.notify !== false;
  const subjectId = body?.subjectId ? String(body.subjectId) : undefined;
  // Starts the run and returns at once — the work outlives this request (see
  // startCommentaryRun). The page polls GET /api/commentary/draft.
  const started = startCommentaryRun("stage", () =>
    stageWeeklyCommentary({ notify, subjectId }),
  );
  if (!started) {
    res.status(409).json({ success: false, error: "A commentary run is already in progress." });
    return;
  }
  res.status(202).json({ success: true, started: true });
});

// POST /api/commentary/reject — Mark threw the topic back. Bench it, record why,
// and write a fresh piece on the next-best topic ("a reject sends the agent back
// to step one", 9/4).
router.post("/commentary/reject", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  try {
    const reason = String((req.body as { reason?: string } | undefined)?.reason ?? "").slice(0, 500);
    const started = startCommentaryRun("reject", () => rejectAndRestage(reason));
    if (!started) {
      res.status(409).json({ success: false, error: "A commentary run is already in progress." });
      return;
    }
    res.status(202).json({ success: true, started: true });
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
  res.json({ success: true, draft: await loadCommentaryDraft(), ...commentaryRunState() });
});

// POST /api/commentary/synthesize — { take } → write the commentary from
// Mark's opinion (repeatable: revise the take, re-synthesize)
router.post("/commentary/synthesize", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  try {
    const b = req.body as { take?: string; autonomous?: boolean } | undefined;
    const take = String(b?.take ?? "").trim();
    if (!take && !b?.autonomous) {
      res.status(400).json({ success: false, error: "take is required (or autonomous: true)" });
      return;
    }
    const started = startCommentaryRun(take ? "rewrite" : "write", () =>
      synthesizeCommentary(take || null),
    );
    if (!started) {
      res.status(409).json({ success: false, error: "A commentary run is already in progress." });
      return;
    }
    res.status(202).json({ success: true, started: true });
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
    if (!draft || draft.status !== "drafted") {
      res.status(400).json({ success: false, error: "No synthesized commentary to publish — give your take first" });
      return;
    }
    const store = await getStore();
    const now = new Date().toISOString();
    const draftTitle = stripHtml(draft.suggestedTitle);
    const draftTitleEs = stripHtml(await autoTranslate(draftTitle));
    const post: CommentaryPost = {
      id: crypto.randomUUID(),
      title: draftTitle,
      ...(draftTitleEs ? { title_es: draftTitleEs } : {}),
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
  if (draft && (draft.status === "awaiting_take" || draft.status === "drafted")) {
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

  const active = draft && (draft.status === "awaiting_take" || draft.status === "drafted");
  const storyLine = (s: { title: string; summary: string; link: string }): string =>
    `<div class="storyline"><b>${esc(s.title)}</b><br><span class="muted">${esc(
      s.summary,
    )}</span>${s.link ? ` <a href="${esc(s.link)}" target="_blank" rel="noopener">source →</a>` : ""}</div>`;

  // ONE story is the subject. Anything else on this page is labelled as background the
  // piece may cite — never as a second thing the commentary is also about (Mark, 9/4:
  // "it's not a commentary if it is synthesizing multiple ideas, that is a newsletter").
  const subject = active ? draft!.stories[0] : undefined;
  const legacyExtras = active ? draft!.stories.slice(1) : [];
  const background = active ? [...legacyExtras, ...draft!.research] : [];
  const storiesHtml = subject ? storyLine(subject) : "";

  const backgroundHtml =
    background.length > 0
      ? `<details style="margin-top:12px"><summary class="muted small" style="cursor:pointer">Background coverage the piece may cite (${background.length}) — not what it's about</summary>
         <div style="margin-top:8px">${background.map(storyLine).join("")}</div></details>`
      : "";

  const alternatesHtml =
    active && draft!.status === "awaiting_take" && (draft!.alternates ?? []).length > 0
      ? `<details style="margin-top:12px"><summary class="muted small" style="cursor:pointer">Rather argue a different story?</summary>
         <div style="margin-top:8px">${draft!
           .alternates!.map(
             (s) =>
               `<div class="storyline"><b>${esc(s.title)}</b><br><span class="muted">${esc(
                 s.summary,
               )}</span><br><button class="btn" style="margin-top:8px;padding:7px 14px;font-size:13px" onclick="reSubject(${JSON.stringify(
                 esc(s.id),
               )})">Use this story instead</button></div>`,
           )
           .join("")}</div></details>`
      : "";

  // The finished piece leads. Mark's three doors are Approve / Add my thoughts /
  // Reject (9/4) — his input is an option on a written piece, not a precondition.
  const traction = subject?.traction;
  const body = !active
    ? `<p class="muted">No commentary in progress.</p>
       <button class="btn" onclick="gen()">Find this week's topic &amp; write it</button>`
    : draft!.status !== "drafted"
      ? `<div class="panel">
    <div class="label">This week's story</div>
    ${storiesHtml}
    <p class="muted small">Staged but not yet written.</p>
    <div class="row">
      <button class="btn primary" onclick="write(this)">Write it now</button>
      <button class="btn danger" onclick="discard()">Skip this week</button>
    </div>
  </div>`
      : `
  ${
    draft!.sensitive
      ? `<div class="panel" style="border-color:rgba(255,180,80,.55);background:rgba(255,180,80,.10)">
    <div class="label" style="color:#ffcc80">⚠️ Sensitive subject — read before publishing</div>
    <p class="muted small" style="margin:0">${esc(draft!.sensitiveWhy || "This topic can hurt a reader personally.")} Autopilot will not publish this one; it needs your call.</p>
  </div>`
      : ""
  }
  ${
    (draft!.bannedWords ?? []).length > 0
      ? `<div class="panel" style="border-color:rgba(255,180,80,.55)">
    <div class="label" style="color:#ffcc80">Banned words scrubbed</div>
    <p class="muted small" style="margin:0">Removed before you saw this: ${draft!.bannedWords!.map((w) => esc(w)).join(", ")}. Worth a glance that the sentence still reads right.</p>
  </div>`
      : ""
  }
  <div class="panel">
    <div class="label">${draft!.authoredBy === "agent" ? "This week's commentary — written for you" : "Rewritten with your thoughts"}</div>
    <h2>${esc(draft!.suggestedTitle)}</h2>
    <div class="body">${draft!.draftHtml}</div>
    <div class="row">
      <button class="btn primary" onclick="publish()">✅ Approve as-is — publish EN + ES</button>
      <button class="btn" onclick="document.getElementById('takePanel').style.display='block';this.scrollIntoView()">✍️ Add my thoughts</button>
      <button class="btn danger" onclick="reject(this)">❌ Reject — find another topic</button>
    </div>
    <p class="muted small">Approve publishes to the Commentary section, Spanish auto-translated, and the piece then feeds the Short. Reject benches this topic for 30 days, records why, and writes a fresh one on the next-best topic.</p>
  </div>

  <div class="panel">
    <div class="label">Why this topic</div>
    ${storiesHtml}
    ${draft!.subjectReason ? `<p class="muted small" style="margin:10px 0 0"><b>The pick:</b> ${esc(draft!.subjectReason)}</p>` : ""}
    ${
      traction
        ? `<p class="muted small" style="margin:6px 0 0"><b>Traction ${traction.score}/100:</b> ${esc(traction.basis)}</p>`
        : `<p class="muted small" style="margin:6px 0 0">Traction signals unavailable this run — picked on editorial rank.</p>`
    }
    ${
      (draft!.rejectedThisCycle ?? 0) > 0
        ? `<p class="muted small" style="margin:6px 0 0">↩︎ ${draft!.rejectedThisCycle} topic(s) rejected this cycle.</p>`
        : ""
    }
    ${
      draft!.agentTake
        ? `<div class="storyline" style="border-left:3px solid #17a457;padding-left:10px;margin-top:12px">
      <div class="label" style="margin:0 0 6px">The position it argued — judge this first</div>
      <b>${esc(draft!.agentTake.position)}</b>
      <div class="muted small" style="margin-top:6px">
        <b>Who's wrong:</b> ${esc(draft!.agentTake.whos_wrong)}<br>
        <b>What should change:</b> ${esc(draft!.agentTake.what_should_change)}
      </div>
    </div>`
        : ""
    }
    ${
      draft!.verifiedBy === "sources-only"
        ? `<p class="muted small" style="margin:10px 0 0;color:#ffcc80">⚠️ Verified against the source articles ONLY — the live web-search check failed on this run. Treat outside-world claims (who runs it, who owns it, industry practice) as unchecked.</p>`
        : draft!.verifiedBy === "search"
          ? `<p class="muted small" style="margin:10px 0 0">🔎 Verified against live web search${(draft!.searched ?? []).length > 0 ? ` — ${draft!.searched!.length} lookup(s): ${draft!.searched!.map((q) => esc(q)).join(" · ")}` : ""}</p>`
          : ""
    }
    ${
      draft!.factCheck && draft!.factCheck.length > 0
        ? `<p class="muted small" style="margin:10px 0 0">🔍 Fact-check repaired ${draft!.factCheck.length} unsupported claim(s) before you saw this: ${draft!.factCheck
            .map((f) => esc(f.problem))
            .join(" · ")}</p>`
        : draft!.authoredBy === "agent"
          ? `<p class="muted small" style="margin:10px 0 0">🔍 Fact-check found nothing to repair.</p>`
          : ""
    }
    ${backgroundHtml}
    ${alternatesHtml}
  </div>

  <div class="panel" id="takePanel" style="${draft!.markTake ? "" : "display:none"}">
    <div class="label">Your thoughts — they become the spine, the piece gets rewritten around them</div>
    ${draft!.questions.length > 0 ? `<p class="muted small" style="margin:0 0 8px">If it helps: ${draft!.questions.map((q) => esc(q)).join(" · ")}</p>` : ""}
    <textarea id="take" rows="8" placeholder="Your raw take — opinions, experiences, what you'd tell a client. Rough is fine; it gets woven for impact, not quoted verbatim.">${esc(draft!.markTake)}</textarea>
    <div class="row">
      <button class="btn primary" onclick="synth()">Rewrite with my thoughts</button>
    </div>
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
.storyline{padding:10px 0;border-bottom:1px solid rgba(255,255,255,.1);line-height:1.5}
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
// A run takes 2-6 minutes and nginx closes proxied connections at 120s, so the
// POST only STARTS the work and we poll for the result. Waiting on the POST here
// is what produced a 504 on prod while the piece was written correctly anyway.
async function call(path, payload){
  const r=await fetch(path,{method:"POST",headers:{"content-type":"application/json","x-affiliate-token":TOKEN},body:JSON.stringify(payload||{})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||d.success===false){alert(d.error||("HTTP "+r.status));return false}
  return true;
}
function note(msg){
  let el=document.getElementById("workNote");
  if(!el){el=document.createElement("div");el.id="workNote";el.className="panel";
    el.style.cssText="border-color:#17a457;background:rgba(23,164,87,.12)";
    document.body.insertBefore(el,document.body.children[1]||null);}
  el.innerHTML=msg;
}
// Polls until the server reports it is no longer busy, then reloads. Survives the
// page being closed and reopened — the work is server-side, not in this tab.
async function waitForRun(label){
  const started=Date.now();
  note("<b>"+label+"</b><br><span class=\"muted small\">Working… this takes 2-6 minutes (the fact-check searches the web). Safe to leave this page open; the run continues on the server either way.</span>");
  for(;;){
    await new Promise(r=>setTimeout(r,5000));
    let d;
    try{
      const r=await fetch("/api/commentary/draft",{headers:{"x-affiliate-token":TOKEN}});
      d=await r.json();
    }catch(e){ continue; }           // transient network blip — keep waiting
    const secs=Math.round((Date.now()-started)/1000);
    if(d.busy){
      note("<b>"+label+"</b><br><span class=\"muted small\">Working… "+secs+"s elapsed. The fact-check searches the web, so 2-6 minutes is normal.</span>");
      continue;
    }
    if(d.lastError){ alert("The run failed: "+d.lastError); location.reload(); return; }
    location.reload(); return;
  }
}
async function gen(){ if(await call("/api/commentary/draft",{notify:false})) waitForRun("Finding this week's topic and writing it"); }
async function write(btn){ btn.disabled=true; btn.textContent="Writing…";
  if(await call("/api/commentary/synthesize",{autonomous:true})) waitForRun("Writing the commentary"); else btn.disabled=false; }
async function reSubject(id){
  if(!confirm("Write this week's commentary on that story instead?"))return;
  if(await call("/api/commentary/draft",{notify:false,subjectId:id})) waitForRun("Rewriting on the story you picked");
}
async function reject(btn){
  const reason=prompt("Reject this topic — why? (helps the picker learn)","");
  if(reason===null)return;
  btn.disabled=true; btn.textContent="Finding another topic…";
  if(await call("/api/commentary/reject",{reason})) waitForRun("Rejected — finding another topic and writing it");
  else { btn.disabled=false; btn.textContent="❌ Reject — find another topic"; }
}
async function synth(){
  const take=document.getElementById("take").value.trim();
  if(!take){alert("Add your thoughts first, or just approve the piece as-is.");return}
  const btn=event.target; btn.disabled=true; btn.textContent="Rewriting…";
  if(await call("/api/commentary/synthesize",{take})) waitForRun("Rewriting around your thoughts"); else {btn.disabled=false;}
}
async function publish(){
  if(!confirm("Publish this commentary to the website (EN + ES)?"))return;
  if(await call("/api/commentary/publish-draft")) { alert("Published!"); location.reload(); }
}
async function discard(){ if(confirm("Skip this week?") && await call("/api/commentary/draft/discard")) location.reload(); }
</script>
</body></html>`);
});

export default router;
