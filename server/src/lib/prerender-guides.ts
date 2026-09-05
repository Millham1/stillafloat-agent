import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger";
import { PATHS, readJson } from "./persistence";
import { resolvePublicDir } from "./public-dir";

// ─────────────────────────────────────────────────────────────────────────────
// CRUISING GUIDES pre-renderer.
//
// Evergreen, curated long-form advisory articles (the Track A/B SEO play). Unlike
// the news pages, guides are hand-curated and change rarely, so their body is
// stored as trusted, ready-to-render HTML in the platform_state `guides` key:
//
//   { updatedAt?, guides: Guide[] }
//
// A guide can exist in EN, ES, or both — each language is emitted only when that
// language has a title + body. This module writes:
//
//   /guides.html, /es/guides.html          the index (one per language)
//   /guides/<slug>.html, /es/guides/<slug>.html   one crawlable page per guide
//   /guides-sitemap.xml                     all guide URLs
//
// Runs on boot + hourly (see server/src/index.ts), same cadence as the news
// prerender. Deploys `git reset --hard` over any tracked output; the next tick
// regenerates from the current `guides` data.
// ─────────────────────────────────────────────────────────────────────────────

const SITE = "https://stillafloatcruising.com";
const LOGO = `${SITE}/assets/images/still_afloat_logo.png`;

export interface Guide {
  slug?: string;
  title?: string;
  title_es?: string;
  hook?: string; // short blurb for the index card
  hook_es?: string;
  category?: string; // small label, e.g. "Ships & Cabins"
  category_es?: string;
  seoTitle?: string; // optional <title> override; falls back to title
  seoTitle_es?: string;
  seoDesc?: string; // meta description; falls back to hook
  seoDesc_es?: string;
  bodyHtml?: string; // TRUSTED, ready-to-render HTML (our own curated content)
  bodyHtml_es?: string;
  image?: string;
  // TOOL TILES: when set, the index tile links straight to this path instead of a
  // prerendered /guides/<slug> page and no guide page is generated. Lets first-class
  // tools (Room Concierge) sit in the guides grid without faking a bodyHtml.
  toolHref?: string;
  toolHref_es?: string;
  toolCta?: string;   // tile CTA label override, e.g. "Open the tool →"
  toolCta_es?: string;
  published?: boolean;
  sort?: number;
  updatedAt?: string;
}

type Lang = "en" | "es";

function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function field(guide: Guide, base: "title" | "hook" | "category" | "seoTitle" | "seoDesc" | "bodyHtml", lang: Lang): string {
  const key = (lang === "es" ? `${base}_es` : base) as keyof Guide;
  const v = guide[key];
  return typeof v === "string" ? v.trim() : "";
}

// A guide is available in a language when it has both a title and a body there.
// A tool tile only needs a title — its destination is a real page already.
export function hasLang(guide: Guide, lang: Lang): boolean {
  if (toolHrefFor(guide, lang)) return Boolean(field(guide, "title", lang));
  return Boolean(field(guide, "title", lang) && field(guide, "bodyHtml", lang));
}

export function toolHrefFor(guide: Guide, lang: Lang): string {
  const v = lang === "es" ? guide.toolHref_es || guide.toolHref : guide.toolHref;
  return typeof v === "string" ? v.trim() : "";
}

export function cleanSlug(guide: Guide): string {
  return String(guide.slug || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "guide";
}

function guideUrls(slug: string): { en: string; es: string } {
  return { en: `${SITE}/guides/${slug}.html`, es: `${SITE}/es/guides/${slug}.html` };
}

const T = {
  en: {
    indexTitle: "Cruising Guides | Still Afloat",
    indexH1: "Cruising Guides",
    indexIntro:
      "Straight-talking guides to help you with ships, rooms and ports — and the decisions worth getting right before you book.",
    indexDesc:
      "Practical cruise-planning guides from Still Afloat — ships and cabins, ports and embarkation, and the calls that make or break a trip.",
    readGuide: "Read the guide →",
    backToGuides: "← All cruising guides",
    ctaTitle: "Planning a cruise?",
    ctaBody:
      "Talk to Mark — a real cruise advisor who has sailed it himself, not a call center. Honest picks, no pressure, and no booking fees to you.",
    ctaButton: "Work with Mark →",
    ctaHref: "/work-with-mark.html",
    indexPath: "/guides.html",
  },
  es: {
    indexTitle: "Guías de Crucero | Still Afloat",
    indexH1: "Guías de Crucero",
    indexIntro:
      "Guías claras para ayudarte con barcos, cabinas y puertos — y las decisiones que conviene acertar antes de reservar.",
    indexDesc:
      "Guías prácticas de planificación de cruceros de Still Afloat — barcos y cabinas, puertos y embarque, y las decisiones clave del viaje.",
    readGuide: "Leer la guía →",
    backToGuides: "← Todas las guías",
    ctaTitle: "¿Estás planeando un crucero?",
    ctaBody:
      "Habla con Mark — un asesor de cruceros de verdad que los ha navegado, no un centro de llamadas. Recomendaciones honestas, sin presión y sin costo para ti.",
    ctaButton: "Trabaja con Mark →",
    ctaHref: "/es/work-with-mark.html",
    indexPath: "/es/guides.html",
  },
} as const;

const GUIDE_CSS = `:root{--bg:#07111f;--panel:rgba(9,18,34,.84);--border:rgba(255,255,255,.10)}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top right, rgba(0,119,182,.18), transparent 24%),linear-gradient(to bottom,#040b16 0%,#071523 30%,#0c2035 100%);color:white;font-family:Poppins,sans-serif}.g-header{position:relative;height:184px;width:100%}.g-shell{max-width:900px;margin:auto;padding:0 24px 80px}.g-card{position:relative;z-index:5;width:100%;margin:20px auto 0;border-radius:34px;background:var(--panel);backdrop-filter:blur(14px);border:1px solid var(--border);overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.45)}.g-content{padding:40px}.g-badge{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:999px;background:rgba(93,255,154,.12);border:1px solid rgba(93,255,154,.22);color:#bdfdd3;font-size:12px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;margin-bottom:20px}.g-title{font-size:clamp(30px,5vw,52px);line-height:1.08;margin:0 0 24px;font-weight:900}.g-body{font-size:18px;line-height:1.8;color:rgba(255,255,255,.9)}.g-body h2,.g-body h3{color:#fff;line-height:1.25;margin:34px 0 12px;font-weight:800}.g-body h2{font-size:26px}.g-body h3{font-size:21px}.g-body p{margin:0 0 16px}.g-body ul,.g-body ol{margin:0 0 18px;padding-left:24px}.g-body li{margin:0 0 8px}.g-body strong{color:#fff}.g-body em{color:rgba(255,255,255,.72)}.g-body a{color:#7de3ff}.g-body table{width:100%;border-collapse:collapse;margin:8px 0 22px;font-size:15px;display:block;overflow-x:auto}.g-body th,.g-body td{text-align:left;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.14);vertical-align:top}.g-body th{color:#bdfdd3;text-transform:uppercase;font-size:12px;letter-spacing:.04em}.g-hero{float:right;width:min(340px,42%);margin:4px 0 22px 26px;border-radius:18px;border:1px solid var(--border);box-shadow:0 12px 32px rgba(0,0,0,.45);height:auto}@media(max-width:640px){.g-hero{float:none;width:100%;margin:0 0 20px}}.g-picks{list-style:none;margin:6px 0 4px;padding:0;display:grid;gap:12px}.g-pick{display:flex;gap:16px;align-items:center;padding:12px 16px;border-radius:16px;background:rgba(255,255,255,.05);border:1px solid var(--border)}.g-pick img{width:62px;height:62px;object-fit:contain;background:#fff;border-radius:10px;flex:none;padding:6px}.g-pick-b{display:block;font-weight:800;color:#7de3ff;text-decoration:none;margin-bottom:2px}.g-pick-w{display:block;font-size:14px;color:rgba(255,255,255,.72);line-height:1.5}.g-disc{font-size:13px;color:rgba(255,255,255,.58);line-height:1.7;margin:14px 0 20px}.g-back{display:inline-block;margin:26px 0 0;color:#7de3ff;font-weight:800;text-decoration:none}.g-note{margin-top:24px;padding:16px 20px;border-radius:16px;background:rgba(255,255,255,.05);color:rgba(255,255,255,.62);font-size:13px;line-height:1.7}footer{text-align:center;padding:40px 20px 60px;color:rgba(255,255,255,.52)}
.g-index-hero{max-width:900px;margin:0 auto;padding:26px 24px 6px}.g-index-hero .kick{font-size:12px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#5dff9a;margin:0 0 10px}.g-index-hero h1{font-size:clamp(34px,6vw,60px);line-height:1.02;margin:0 0 14px;font-weight:900}.g-index-hero p{font-size:19px;line-height:1.6;color:rgba(255,255,255,.76);max-width:60ch;margin:0}.g-grid{max-width:900px;margin:18px auto 0;padding:0 24px 70px;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}.g-tile{display:flex;flex-direction:column;padding:26px;border-radius:24px;background:rgba(210,230,255,.08);border:1px solid rgba(255,255,255,.10);text-decoration:none;color:#fff;transition:transform .22s ease,border-color .22s ease,box-shadow .22s ease}.g-tile:hover{transform:translateY(-5px);border-color:rgba(93,255,154,.30);box-shadow:0 18px 40px rgba(0,0,0,.28)}.g-tile .cat{font-size:11px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#bdfdd3;margin:0 0 12px}.g-tile h2{font-size:23px;line-height:1.2;margin:0 0 12px;font-weight:800}.g-tile p{font-size:15px;line-height:1.6;color:rgba(255,255,255,.74);margin:0 0 18px;flex:1}.g-tile .more{color:#7de3ff;font-weight:800;font-size:14px}
.cta{margin:24px auto 0;max-width:900px;padding:28px 30px;border-radius:26px;background:linear-gradient(135deg,rgba(93,255,154,.10),rgba(0,119,182,.12));border:1px solid rgba(93,255,154,.24);text-align:center}.cta h2{margin:0 0 8px;font-size:24px;font-weight:900;color:#fff}.cta p{margin:0 auto 18px;max-width:560px;color:rgba(255,255,255,.84);line-height:1.65}.cta a{display:inline-block;padding:14px 30px;border-radius:16px;background:linear-gradient(135deg,#0077b6,#023e6e);color:#5dff9a;font-weight:800;text-decoration:none}@media(max-width:860px){.g-header{height:74px}.g-content{padding:26px}}`;

function ctaHtml(lang: Lang): string {
  const t = T[lang];
  return `<section class="cta"><h2>${t.ctaTitle}</h2><p>${t.ctaBody}</p><a href="${t.ctaHref}">${t.ctaButton}</a></section>`;
}

function jsonLd(guide: Guide, slug: string, lang: Lang): string {
  const u = guideUrls(slug);
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: field(guide, "title", lang),
    description: field(guide, "seoDesc", lang) || field(guide, "hook", lang),
    inLanguage: lang === "es" ? "es-419" : "en-US",
    mainEntityOfPage: lang === "es" ? u.es : u.en,
    author: [{ "@type": "Organization", name: "Still Afloat Cruising", url: SITE }],
    publisher: {
      "@type": "Organization",
      name: "Still Afloat Cruising",
      logo: { "@type": "ImageObject", url: LOGO },
    },
  };
  if (guide.image) data["image"] = [guide.image];
  if (guide.updatedAt) data["dateModified"] = guide.updatedAt;
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function hreflang(guide: Guide, slug: string, lang: Lang): string {
  const u = guideUrls(slug);
  const both = hasLang(guide, "en") && hasLang(guide, "es");
  const self = lang === "es" ? u.es : u.en;
  const links = [`<link rel="canonical" href="${self}">`];
  if (both) {
    links.push(
      `<link rel="alternate" hreflang="en" href="${u.en}">`,
      `<link rel="alternate" hreflang="es" href="${u.es}">`,
      `<link rel="alternate" hreflang="x-default" href="${u.en}">`,
    );
  }
  return links.join("\n");
}

function guidePageHtml(guide: Guide, slug: string, lang: Lang): string {
  const t = T[lang];
  const u = guideUrls(slug);
  const self = lang === "es" ? u.es : u.en;
  const title = escapeHtml(field(guide, "title", lang));
  const seoTitle = escapeHtml(field(guide, "seoTitle", lang) || field(guide, "title", lang));
  const desc = escapeHtml(field(guide, "seoDesc", lang) || field(guide, "hook", lang));
  const category = escapeHtml(field(guide, "category", lang));
  const body = field(guide, "bodyHtml", lang); // trusted HTML — not escaped

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${seoTitle} | Still Afloat</title>
<meta name="description" content="${desc}">
${hreflang(guide, slug, lang)}
<meta property="og:type" content="article">
<meta property="og:site_name" content="Still Afloat Cruising">
<meta property="og:url" content="${self}">
<meta property="og:title" content="${seoTitle}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${guide.image ? escapeHtml(guide.image) : LOGO}">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/css/styles.css">
<script type="application/ld+json">${jsonLd(guide, slug, lang)}</script>
<style>${GUIDE_CSS}</style>
</head>
<body>
<header class="g-header"><div id="navbar-container"></div></header>
<div class="g-shell">
<article class="g-card">
<div class="g-content">
${category ? `<div class="g-badge">${category}</div>` : ""}
<h1 class="g-title">${title}</h1>
<div class="g-body">${body}</div>
<a class="g-back" href="${t.indexPath}">${t.backToGuides}</a>
</div>
</article>
${ctaHtml(lang)}
</div>
<footer>© 2026 Still Afloat LLC — Cruise smarter. Laugh more. <img src="/assets/images/stay-afloat-text.png" alt="Stay Afloat" class="brand-img-sm"></footer>
<script src="/components/navbar.js?v=20260905-homeonly"></script>
</body>
</html>`;
}

function guidesIndexHtml(guides: Guide[], lang: Lang): string {
  const t = T[lang];
  const self = `${SITE}${t.indexPath}`;
  const other = lang === "es" ? `${SITE}${T.en.indexPath}` : `${SITE}${T.es.indexPath}`;
  const tiles = guides
    .map((guide) => {
      const slug = cleanSlug(guide);
      const tool = toolHrefFor(guide, lang);
      const href = tool || (lang === "es" ? `/es/guides/${slug}.html` : `/guides/${slug}.html`);
      const cat = escapeHtml(field(guide, "category", lang));
      const title = escapeHtml(field(guide, "title", lang));
      const hook = escapeHtml(field(guide, "hook", lang) || field(guide, "seoDesc", lang));
      const cta = tool
        ? escapeHtml((lang === "es" ? guide.toolCta_es : guide.toolCta) || t.readGuide)
        : t.readGuide;
      return `<a class="g-tile" href="${href}">${cat ? `<span class="cat">${cat}</span>` : ""}<h2>${title}</h2><p>${hook}</p><span class="more">${cta}</span></a>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${t.indexTitle}</title>
<meta name="description" content="${escapeHtml(t.indexDesc)}">
<link rel="canonical" href="${self}">
<link rel="alternate" hreflang="${lang}" href="${self}">
<link rel="alternate" hreflang="${lang === "es" ? "en" : "es"}" href="${other}">
<link rel="alternate" hreflang="x-default" href="${SITE}${T.en.indexPath}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Still Afloat Cruising">
<meta property="og:url" content="${self}">
<meta property="og:title" content="${escapeHtml(t.indexTitle)}">
<meta property="og:description" content="${escapeHtml(t.indexDesc)}">
<meta property="og:image" content="${LOGO}">
<link rel="stylesheet" href="/css/styles.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<style>${GUIDE_CSS}</style>
</head>
<body>
<header class="g-header"><div id="navbar-container"></div></header>
<div class="g-index-hero">
<p class="kick">${t.indexH1}</p>
<h1>${t.indexH1}</h1>
<p>${t.indexIntro}</p>
</div>
${tiles ? `<div class="g-grid">${tiles}</div>` : ""}
${ctaHtml(lang)}
<footer>© 2026 Still Afloat LLC — Cruise smarter. Laugh more. <img src="/assets/images/stay-afloat-text.png" alt="Stay Afloat" class="brand-img-sm"></footer>
<script src="/components/navbar.js?v=20260905-homeonly"></script>
</body>
</html>`;
}

function sitemapXml(guides: Guide[]): string {
  const day = (iso?: string): string => {
    const d = iso ? new Date(iso) : new Date();
    return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().slice(0, 10);
  };
  const entries: string[] = [
    `<url><loc>${SITE}/guides.html</loc><changefreq>weekly</changefreq></url>`,
    `<url><loc>${SITE}/es/guides.html</loc><changefreq>weekly</changefreq></url>`,
  ];
  for (const guide of guides) {
    const slug = cleanSlug(guide);
    const u = guideUrls(slug);
    const lastmod = day(guide.updatedAt);
    // tool tiles have no /guides/<slug> page — their real page lives in the main sitemap
    if (toolHrefFor(guide, "en") || toolHrefFor(guide, "es")) continue;
    if (hasLang(guide, "en")) entries.push(`<url><loc>${u.en}</loc><lastmod>${lastmod}</lastmod></url>`);
    if (hasLang(guide, "es")) entries.push(`<url><loc>${u.es}</loc><lastmod>${lastmod}</lastmod></url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`;
}

/**
 * The pages this data SHOULD produce, per language — the renderer's own rules,
 * exported so a drift check can compare against reality without re-implementing
 * (and mis-implementing) them. The first version of routes/guides.ts assumed
 * every published guide gets an English page and reported a false alarm on the
 * Spanish-only "como-elegir-tu-primer-crucero"; a status endpoint that cries
 * wolf gets ignored, which is worse than not having one.
 */
export async function expectedGuidePages(): Promise<{ en: string[]; es: string[] }> {
  const data = await readJson<{ guides?: Guide[] }>(PATHS.guides, { guides: [] });
  const all = (data.guides ?? []).filter((g) => g && g.published !== false && g.slug);
  const en: string[] = [];
  const es: string[] = [];
  const seen = new Set<string>();
  for (const g of all) {
    const slug = cleanSlug(g);
    if (seen.has(slug)) continue;
    seen.add(slug);
    if (toolHrefFor(g, "en") || toolHrefFor(g, "es")) continue;  // tool tiles link out
    if (hasLang(g, "en")) en.push(slug);
    if (hasLang(g, "es")) es.push(slug);
  }
  return { en, es };
}

export async function runGuidesPrerender(): Promise<{ guides: number; pages: number }> {
  const data = await readJson<{ updatedAt?: string; guides?: Guide[] }>(PATHS.guides, { guides: [] });
  const all = (data.guides ?? []).filter((g) => g && g.published !== false && g.slug);
  const seen = new Set<string>();
  const guides = all
    .filter((g) => {
      const slug = cleanSlug(g);
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    })
    .sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999));

  const publicDir = resolvePublicDir();
  const enDir = path.join(publicDir, "guides");
  const esDir = path.join(publicDir, "es", "guides");
  await mkdir(enDir, { recursive: true });
  await mkdir(esDir, { recursive: true });

  let pages = 0;
  for (const guide of guides) {
    const slug = cleanSlug(guide);
    // tool tiles link out to a real page — never render a (bodyless) guide page for them
    if (toolHrefFor(guide, "en") || toolHrefFor(guide, "es")) continue;
    if (hasLang(guide, "en")) {
      await writeFile(path.join(enDir, `${slug}.html`), guidePageHtml(guide, slug, "en"));
      pages += 1;
    }
    if (hasLang(guide, "es")) {
      await writeFile(path.join(esDir, `${slug}.html`), guidePageHtml(guide, slug, "es"));
      pages += 1;
    }
  }

  const enGuides = guides.filter((g) => hasLang(g, "en"));
  const esGuides = guides.filter((g) => hasLang(g, "es"));
  await writeFile(path.join(publicDir, "guides.html"), guidesIndexHtml(enGuides, "en"));
  await writeFile(path.join(publicDir, "es", "guides.html"), guidesIndexHtml(esGuides, "es"));
  await writeFile(path.join(publicDir, "guides-sitemap.xml"), sitemapXml(guides));
  pages += 3;

  logger.info({ guides: guides.length, pages }, "Guides prerender complete");
  return { guides: guides.length, pages };
}
