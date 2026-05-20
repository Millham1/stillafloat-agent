import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "crypto";
import { PATHS, readJson, writeJson } from "../lib/persistence";

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
  const token = process.env["AGENT_APPROVAL_TOKEN"];
  if (!token) return true;
  const provided = req.headers["x-affiliate-token"] || req.query["token"];
  return provided === token;
}

// GET /api/commentary
// Returns all posts sorted newest-first.
// Optional: ?status=published  ?id=<uuid>
router.get("/commentary", async (req: Request, res: Response) => {
  try {
    const store = await getStore();
    let posts = [...store.posts].sort(
      (a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
    );

    if (req.query["id"]) {
      const post = store.posts.find((p) => p.id === String(req.query["id"]));
      if (!post) {
        res.status(404).json({ success: false, error: "Post not found" });
        return;
      }
      res.json({ success: true, post });
      return;
    }

    if (req.query["status"]) {
      posts = posts.filter((p) => p.status === String(req.query["status"]));
    }

    res.json({ success: true, count: posts.length, posts });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// POST /api/commentary — create and immediately publish a post
router.post("/commentary", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  try {
    const { title, body_en, body_es, tags } = req.body as {
      title?: string;
      body_en?: string;
      body_es?: string;
      tags?: string[];
    };
    if (!title || !body_en) {
      res.status(400).json({ success: false, error: "title and body_en are required" });
      return;
    }
    const store = await getStore();
    const now = new Date().toISOString();
    const post: CommentaryPost = {
      id: crypto.randomUUID(),
      title: String(title),
      body_en: String(body_en),
      body_es: String(body_es || ""),
      tags: Array.isArray(tags) ? tags.map(String) : [],
      status: "published",
      published_at: now,
      updated_at: now,
    };
    store.posts.unshift(post);
    await saveStore(store);
    res.json({ success: true, post });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// PATCH /api/commentary/:id — update title, body, tags, status
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
    const { title, body_en, body_es, tags, status } = req.body as Partial<CommentaryPost>;
    if (title !== undefined) post.title = String(title);
    if (body_en !== undefined) post.body_en = String(body_en);
    if (body_es !== undefined) post.body_es = String(body_es);
    if (tags !== undefined) post.tags = Array.isArray(tags) ? tags.map(String) : [];
    if (status !== undefined) post.status = status as "published" | "unpublished";
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
    const apiKey = process.env["OPENAI_API_KEY"] || process.env["REPLIT_OPENAI_API_KEY"];
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
router.post("/transcribe", async (req: Request, res: Response) => {
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
    const apiKey = process.env["OPENAI_API_KEY"] || process.env["REPLIT_OPENAI_API_KEY"];
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

export default router;
