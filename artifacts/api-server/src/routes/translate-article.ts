import { Router } from "express";
import { logger } from "../lib/logger";

const router = Router();

function extractArticleText(html: string): { title: string; paragraphs: string[] } {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s*[|\-–—].*$/, "").trim() : "";

  let body = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, " ")
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, " ")
    .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, " ")
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const articleMatch = body.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    ?? body.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    ?? body.match(/<div[^>]*class="[^"]*(?:article|post|content|entry)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (articleMatch) body = articleMatch[1];

  const decodeEntities = (s: string) =>
    s.replace(/&amp;/g, "&")
     .replace(/&lt;/g, "<")
     .replace(/&gt;/g, ">")
     .replace(/&quot;/g, '"')
     .replace(/&#39;/g, "'")
     .replace(/&nbsp;/g, " ")
     .replace(/&#\d+;/g, "");

  const paragraphs: string[] = [];
  for (const m of body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (text.length >= 50) paragraphs.push(text);
  }

  if (paragraphs.length < 3) {
    for (const m of body.matchAll(/<(?:h2|h3|li)[^>]*>([\s\S]*?)<\/(?:h2|h3|li)>/gi)) {
      const text = decodeEntities(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      if (text.length >= 30) paragraphs.push(text);
    }
  }

  return { title, paragraphs: paragraphs.slice(0, 25) };
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

router.get("/translate-article", async (req, res) => {
  const rawUrl = (req.query.url as string) ?? "";
  if (!rawUrl) {
    res.status(400).send("Missing url parameter");
    return;
  }

  let articleUrl: URL;
  try {
    articleUrl = new URL(rawUrl);
  } catch {
    res.status(400).send("Invalid URL");
    return;
  }

  try {
    const fetchRes = await fetch(rawUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(12000),
    });

    if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status} from source`);
    const html = await fetchRes.text();
    const { title, paragraphs } = extractArticleText(html);

    if (!title && paragraphs.length === 0) {
      throw new Error("Could not extract content from this article.");
    }

    const inputText =
      `TÍTULO: ${title}\n\n` + paragraphs.map((p, i) => `P${i + 1}: ${p}`).join("\n\n");

    const oaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env["OPENAI_API_KEY"] || process.env["REPLIT_OPENAI_API_KEY"]}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Traduce el siguiente artículo de noticias de cruceros del inglés al español latinoamericano. " +
              "Devuelve exactamente el mismo formato: primero una línea 'TÍTULO: ...' y luego párrafos 'P1: ...', 'P2: ...' etc. " +
              "Traduce naturalmente para lectores hispanohablantes de viajes y cruceros. No agregues comentarios.",
          },
          { role: "user", content: inputText },
        ],
        temperature: 0.2,
        max_tokens: 3000,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!oaiRes.ok) throw new Error(`OpenAI error ${oaiRes.status}`);
    const oaiData = (await oaiRes.json()) as { choices: { message: { content: string } }[] };
    const translated = oaiData.choices[0]?.message?.content ?? "";

    const titleMatch = translated.match(/^TÍTULO:\s*(.+)/m);
    const translatedTitle = titleMatch ? titleMatch[1].trim() : title;

    const translatedParas: string[] = [];
    for (const m of translated.matchAll(/^P\d+:\s*(.+)/gm)) {
      translatedParas.push(m[1].trim());
    }

    const safeTitle = escapeHtml(translatedTitle);
    const safeHost = escapeHtml(articleUrl.hostname);
    const safeOrigUrl = escapeHtml(rawUrl);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(`<!DOCTYPE html>
<html lang="es-419">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle} | Still Afloat</title>
<link rel="stylesheet" href="/css/styles.css">
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@400;700;800;900&family=Bree+Serif&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(circle at top right,rgba(0,119,182,.18),transparent 24%),linear-gradient(to bottom,#040b16 0%,#071523 30%,#0c2035 100%);color:white;font-family:'Baloo 2',Poppins,sans-serif;min-height:100vh}
.shell{max-width:860px;margin:auto;padding:48px 24px 90px}
.back{display:inline-flex;align-items:center;gap:8px;color:rgba(255,255,255,.48);font-size:14px;font-weight:700;text-decoration:none;margin-bottom:30px;transition:color .2s}
.back:hover{color:#5dff9a}
.badge{display:inline-flex;align-items:center;gap:8px;padding:7px 16px;border-radius:999px;background:rgba(93,255,154,.12);border:1px solid rgba(93,255,154,.22);color:#bdfdd3;font-size:11px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;margin-bottom:20px}
h1{font-family:'Bree Serif',serif;font-size:clamp(24px,5vw,44px);line-height:1.1;margin:0 0 18px;color:#fff}
.source-bar{color:rgba(255,255,255,.42);font-size:13px;margin-bottom:32px;padding-bottom:20px;border-bottom:1px solid rgba(255,255,255,.10)}
.source-bar a{color:#5dff9a;text-decoration:none}
.source-bar a:hover{text-decoration:underline}
.body-text{font-size:18px;line-height:1.85;color:rgba(255,255,255,.88)}
.body-text p{margin:0 0 1.5em}
.ai-note{margin-top:44px;padding:20px 24px;border-radius:20px;background:rgba(255,202,79,.06);border:1px solid rgba(255,202,79,.18);font-size:13px;color:rgba(255,255,255,.48);line-height:1.7}
.ai-note a{color:#5dff9a;text-decoration:none}
@media(max-width:600px){.shell{padding:24px 16px 60px}.body-text{font-size:16px}}
</style>
</head>
<body>
<div class="shell">
  <a href="javascript:history.back()" class="back">← Volver</a>
  <div class="badge">🌐 Traducción IA</div>
  <h1>${safeTitle}</h1>
  <div class="source-bar">
    Artículo original en inglés publicado por
    <a href="${safeOrigUrl}" target="_blank" rel="noopener noreferrer">${safeHost}</a>
  </div>
  <div class="body-text">
    ${translatedParas.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n    ")}
  </div>
  <div class="ai-note">
    ✨ Traducción automática generada por Still Afloat vía IA. Todo el contenido original pertenece a ${safeHost}.
    Leer el <a href="${safeOrigUrl}" target="_blank" rel="noopener noreferrer">artículo original en inglés →</a>
  </div>
</div>
</body>
</html>`);

    logger.info({ url: rawUrl, paragraphs: translatedParas.length }, "translate-article served");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ url: rawUrl, err: msg }, "translate-article failed");
    res.status(500).setHeader("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="es-419"><head><meta charset="UTF-8"><title>Error | Still Afloat</title>
<style>body{font-family:sans-serif;background:#040b16;color:white;padding:40px;max-width:600px;margin:auto}</style></head>
<body>
<p><a href="javascript:history.back()" style="color:#5dff9a">← Volver</a></p>
<h2>No se pudo traducir este artículo</h2>
<p style="color:rgba(255,255,255,.6)">${escapeHtml(msg)}</p>
<p><a href="${escapeHtml(rawUrl)}" target="_blank" rel="noopener" style="color:#5dff9a">Leer artículo original en inglés →</a></p>
</body></html>`);
  }
});

export default router;
