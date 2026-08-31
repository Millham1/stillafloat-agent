import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger";
import { PATHS, readJson } from "./persistence";
import { resolvePublicDir } from "./public-dir";

// ─────────────────────────────────────────────────────────────────────────────
// News PRE-RENDERER — replaces the JS-built news pages with real static HTML.
//
// The news index (news.html / es/news.html) and per-story detail pages were
// rendered entirely client-side (js/news.js + story.html?id=…), so Google saw
// empty shells and query-param URLs — none of the editorial content was
// indexable. This module renders the same content the JS pages showed, from
// the same platform_state data the newsagent maintains (story-details, with
// per-story *_es overlays), into static files under server/public that nginx
// serves directly:
//
//   /news/<slug>.html        one crawlable page per story (EN)
//   /es/news/<slug>.html     Spanish twin (same slug — hreflang pair)
//   /news.html, /es/news.html   the full listing, overwritten in place
//   /news-sitemap.xml        all story URLs (robots.txt points here)
//
// Runs on boot + hourly (the newsagent only updates once a day at 08:00 ET).
// Old story pages are deliberately never deleted — their search value accrues;
// the sitemap always reflects the current story set. Deploys `git reset --hard`
// over the tracked listing pages; the next tick regenerates them.
//
// ARCHIVE MERGE (task 669ea94b): the newsagent's daily sweep now moves stories
// older than 21 days out of story-details into `archive-stories`. The story
// pages are gitignored and regenerated purely from platform_state, so if the
// prerenderer only saw story-details, a redeploy would silently drop every
// archived page — 404ing URLs Google has indexed (GSC news sitemap). To keep
// that SEO asset intact, archived stories are merged back in here: their detail
// pages keep regenerating, they stay in the sitemap, and they remain reachable
// as "Earlier stories" links on the listing page. Only the full feed CARDS (the
// newest FULL_CARDS) shrink to the live set — which they do naturally, because
// live stories are always newer than archived ones.
//
// NOTE: storySlug() has a byte-for-byte twin in public/js/news.js (storySlug)
// so client-rendered cards link to the same static URLs. Change them together.
// ─────────────────────────────────────────────────────────────────────────────

const SITE = "https://stillafloatcruising.com";
const LOGO = `${SITE}/assets/images/still_afloat_logo.png`;

export interface NewsStory {
  id?: string;
  title?: string;
  title_es?: string;
  summary?: string;
  summary_es?: string;
  travelerImpact?: string;
  travelerImpact_es?: string;
  editorialReasoning?: string;
  editorialReasoning_es?: string;
  category?: string;
  impactLevel?: string;
  featured?: boolean;
  image?: string;
  link?: string;
  originalLink?: string;
  sources?: string[];
  sourceAttribution?: string[];
  approvedAt?: string;
  generatedAt?: string;
}

type Lang = "en" | "es";

// ── slug (twin lives in public/js/news.js) ──────────────────────────────────
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0").slice(-6);
}

// Slug is a pure function of the stable story id (NOT the title — the ES feeds
// overlay Spanish titles onto the same records, so a title-based slug would
// differ between languages). The newsagent's ids are already slug-shaped but
// often embed the source URL ("…-https-cruiserad"); strip that tail for clean
// URLs and disambiguate with a short hash of the full id.
export function storySlug(story: NewsStory): string {
  const raw = String(story.id || "story");
  const base = raw
    .toLowerCase()
    .replace(/-https?-.*$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/, "");
  return `${base || "story"}-${djb2(raw)}`;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pick(story: NewsStory, field: keyof NewsStory, lang: Lang): string {
  if (lang === "es") {
    const es = story[`${String(field)}_es` as keyof NewsStory];
    if (typeof es === "string" && es.trim()) return es;
  }
  const v = story[field];
  return typeof v === "string" ? v : "";
}

function sourceName(story: NewsStory): string {
  const s = story.sources ?? story.sourceAttribution;
  return (Array.isArray(s) && s[0]) || "Still Afloat AI";
}

function metaDescription(story: NewsStory, lang: Lang): string {
  const raw = (pick(story, "travelerImpact", lang) || pick(story, "summary", lang))
    .replace(/\s+/g, " ")
    .trim();
  return raw.length > 158 ? `${raw.slice(0, 155)}…` : raw;
}

// ── per-story SEO overrides ──────────────────────────────────────────────────
// Optional, keyed by story id (platform_state key `seo-overrides`). They tune the
// <title>/meta/OG snippet a page presents to search engines WITHOUT touching the
// visible <h1> headline or the story body. Living under their own key means the
// newsagent's daily story-details rewrite can never clobber them. Any field left
// unset falls back to the normal title/summary behavior.
export interface SeoOverride {
  title?: string; // EN search title (the " | Still Afloat" suffix is added by the template)
  desc?: string; // EN meta description
  title_es?: string; // ES search title
  desc_es?: string; // ES meta description
  bodyHtml?: string; // optional long-form HTML appended below the cliffnote (deep-dive stories)
  bodyHtml_es?: string;
}
export type SeoOverrideMap = Record<string, SeoOverride>;

function seoTitleFor(story: NewsStory, lang: Lang, ov?: SeoOverride): string {
  const v = ov && (lang === "es" ? ov.title_es : ov.title);
  if (typeof v === "string" && v.trim()) return v.trim();
  return pick(story, "title", lang);
}

function seoDescFor(story: NewsStory, lang: Lang, ov?: SeoOverride): string {
  const v = ov && (lang === "es" ? ov.desc_es : ov.desc);
  if (typeof v === "string" && v.trim()) return v.trim();
  return metaDescription(story, lang);
}

function fmtDate(iso: string | undefined, lang: Lang): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(lang === "es" ? "es-419" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

interface Badge {
  label: string;
  style: string;
}

// Mirrors badgeConfig() + tier derivation in js/news.js.
function badge(story: NewsStory, lang: Lang): Badge {
  const impact =
    Boolean(story.featured) || String(story.impactLevel || "").toLowerCase().includes("high");
  if (impact) {
    return {
      label: lang === "es" ? "✈️ Impacto en Viajes" : "✈️ Travel Impact",
      style: "background:rgba(255,77,109,.18);color:#ffd5dd;border:1px solid rgba(255,77,109,.34);",
    };
  }
  return {
    label: lang === "es" ? "🚢 Pulso de Cruceros" : "🚢 Cruise Pulse",
    style: "background:rgba(67,97,238,.18);color:#d8e2ff;border:1px solid rgba(67,97,238,.34);",
  };
}

function urls(slug: string): { en: string; es: string } {
  return { en: `${SITE}/news/${slug}.html`, es: `${SITE}/es/news/${slug}.html` };
}

function hreflangLinks(slug: string, lang: Lang): string {
  const u = urls(slug);
  return [
    `<link rel="canonical" href="${lang === "es" ? u.es : u.en}">`,
    `<link rel="alternate" hreflang="en" href="${u.en}">`,
    `<link rel="alternate" hreflang="es" href="${u.es}">`,
    `<link rel="alternate" hreflang="x-default" href="${u.en}">`,
  ].join("\n");
}

// ── story detail page ────────────────────────────────────────────────────────
// Chrome/styles lifted from the existing story.html so the static pages look
// identical to what the JS page rendered.
const STORY_CSS = `:root{--bg:#07111f;--panel:rgba(9,18,34,.84);--border:rgba(255,255,255,.10)}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top right, rgba(0,119,182,.18), transparent 24%),linear-gradient(to bottom,#040b16 0%,#071523 30%,#0c2035 100%);color:white;font-family:Poppins,sans-serif}.story-page-header{position:relative;height:184px;width:100%}.story-shell{max-width:1100px;margin:auto;padding:0 24px 80px}.hero{width:100%;aspect-ratio:1392/418;max-height:480px;border-radius:34px;overflow:hidden;margin:6px 0 0;background:url('/assets/images/cliffnotes-hero-art.png') center center/cover no-repeat;border:1px solid rgba(255,255,255,.08);box-shadow:0 28px 70px rgba(0,0,0,.42)}.story-card{position:relative;z-index:5;width:100%;margin:20px auto 0;border-radius:34px;background:var(--panel);backdrop-filter:blur(14px);border:1px solid var(--border);overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.45)}.story-image{width:100%;max-height:460px;object-fit:cover;display:block}.story-content{padding:38px}.badge{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:999px;background:rgba(93,255,154,.12);border:1px solid rgba(93,255,154,.22);color:#bdfdd3;font-size:12px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;margin-bottom:22px}.story-title{font-size:clamp(34px,5vw,64px);line-height:1.05;margin:0 0 18px;font-weight:900}.story-meta{color:rgba(255,255,255,.58);margin-bottom:28px;font-weight:700}.story-summary{font-size:20px;line-height:1.8;color:rgba(255,255,255,.88);margin-bottom:34px}.story-longform{margin-top:14px;font-size:17px;line-height:1.8;color:rgba(255,255,255,.9)}.story-longform h2{font-size:24px;font-weight:800;margin:30px 0 12px;color:#fff}.story-longform h3{font-size:20px;font-weight:800;margin:24px 0 10px;color:#fff}.story-longform p{margin:0 0 15px}.story-longform ul{margin:0 0 16px;padding-left:22px}.story-longform li{margin:0 0 8px}.story-longform strong{color:#fff}.story-longform table{width:100%;border-collapse:collapse;margin:8px 0 20px;font-size:15px;display:block;overflow-x:auto}.story-longform th,.story-longform td{text-align:left;padding:9px 11px;border-bottom:1px solid rgba(255,255,255,.14);vertical-align:top}.story-longform th{color:#bdfdd3;text-transform:uppercase;font-size:12px;letter-spacing:.04em}.traveler-impact-panel{margin-top:28px;padding:22px 26px;border-radius:22px;background:rgba(93,255,154,.07);border:1px solid rgba(93,255,154,.18)}.traveler-impact-panel p{margin:8px 0 0;font-size:17px;line-height:1.7;color:rgba(255,255,255,.88)}.tip-label{font-size:11px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#5dff9a}.editorial-panel{margin-top:18px;padding:24px;border-radius:24px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08)}.editorial-panel .tip-label{color:#7de3ff}.editorial-panel p{margin:8px 0 0;font-size:16px;line-height:1.75;color:rgba(255,255,255,.80);font-style:italic}.actions{display:flex;gap:14px;flex-wrap:wrap;margin-top:30px}.actions a{display:inline-flex;align-items:center;gap:10px;padding:16px 24px;border-radius:999px;text-decoration:none;color:white;font-weight:800;background:linear-gradient(180deg,#0e4672,#0a2748);border:1px solid rgba(102,215,255,.24)}.note{margin-top:30px;padding:18px 22px;border-radius:20px;background:rgba(255,255,255,.05);color:rgba(255,255,255,.70);line-height:1.7;font-size:14px}.related{width:100%;margin:34px auto 0}.related h2{font-size:20px;margin:0 0 14px}.related a{display:block;padding:12px 0;border-bottom:1px solid rgba(255,255,255,.10);color:white;text-decoration:none;font-weight:700;line-height:1.4}.related a:hover{color:#5dff9a}footer{text-align:center;padding:40px 20px 60px;color:rgba(255,255,255,.52)}@media(max-width:1200px){.story-page-header{height:150px}}@media(max-width:860px){.story-page-header{height:74px}.story-card{margin-top:-16px;width:96%}.story-content{padding:26px}}`;

const L = {
  en: {
    impactLabel: "💡 What This Means For You",
    editorialLabel: "📝 Mark's Take",
    readOriginal: "Read Full Article",
    backToFeed: "Return to Feed",
    related: "More cruise news",
    note: "Still Afloat curates and summarizes cruise industry developments, travel disruptions, weather impacts and destination intelligence while crediting and linking directly to original publishers.",
    feedTitle: "Cruise News & Travel Pulse | Still Afloat",
    feedH1: "Cruise News & Travel Pulse",
    feedIntro:
      "Real-time cruise operations, weather impacts, destination changes, passenger disruptions and curated travel intelligence.",
    feedDesc:
      "Real-time cruise operations, weather impacts, destination changes, passenger disruptions, and curated travel intelligence — updated daily by Still Afloat.",
    archive: "Earlier stories",
    openDetail: "Open Story Detail →",
    feedPath: "/news.html",
    ctaTitle: "Planning a cruise?",
    ctaBody:
      "Talk to Mark — a real cruise advisor who's sailed it himself, not a call center. Honest picks, no pressure, and no booking fees to you.",
    ctaButton: "Work with Mark →",
    ctaHref: "/work-with-mark.html",
  },
  es: {
    impactLabel: "💡 Lo que esto significa para ti",
    editorialLabel: "🎙️ Por qué importa",
    readOriginal: "Leer el artículo original (en inglés)",
    backToFeed: "Volver a noticias",
    related: "Más noticias de cruceros",
    note: "Still Afloat cura y resume novedades de la industria de cruceros, interrupciones de viaje, impactos del clima e inteligencia de destinos, siempre acreditando y enlazando directamente a los editores originales.",
    feedTitle: "Noticias de Cruceros y Viajes | Still Afloat",
    feedH1: "Noticias de Cruceros y Viajes",
    feedIntro:
      "Operaciones de cruceros en tiempo real, impactos del clima, cambios de destino, interrupciones para pasajeros e inteligencia de viajes curada.",
    feedDesc:
      "Operaciones de cruceros en tiempo real, impactos del clima, cambios de destino e inteligencia de viajes curada — actualizado a diario por Still Afloat.",
    archive: "Historias anteriores",
    openDetail: "Ver detalle →",
    feedPath: "/es/news.html",
    ctaTitle: "¿Estás planeando un crucero?",
    ctaBody:
      "Habla con Mark — un asesor de cruceros de verdad que los ha navegado, no un centro de llamadas. Recomendaciones honestas, sin presión y sin costo para ti.",
    ctaButton: "Trabaja con Mark →",
    ctaHref: "/es/work-with-mark.html",
  },
} as const;

function jsonLd(story: NewsStory, slug: string, lang: Lang, ov?: SeoOverride): string {
  const u = urls(slug);
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: pick(story, "title", lang),
    description: seoDescFor(story, lang, ov),
    datePublished: story.approvedAt || story.generatedAt || undefined,
    inLanguage: lang === "es" ? "es-419" : "en-US",
    mainEntityOfPage: lang === "es" ? u.es : u.en,
    isBasedOn: story.originalLink || story.link || undefined,
    author: [{ "@type": "Organization", name: "Still Afloat Cruising", url: SITE }],
    publisher: {
      "@type": "Organization",
      name: "Still Afloat Cruising",
      logo: { "@type": "ImageObject", url: LOGO },
    },
  };
  if (story.image) data["image"] = [story.image];
  // JSON-LD lives inside a <script> tag: escape "<" so story text can never
  // break out of it.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function storyPageHtml(
  story: NewsStory,
  slug: string,
  lang: Lang,
  related: NewsStory[],
  ov?: SeoOverride,
): string {
  const t = L[lang];
  const u = urls(slug);
  const self = lang === "es" ? u.es : u.en;
  // Zero-intent Carnival-outage ES article — keep it out of the index to preserve
  // crawl equity (it ranks pos ~36 for "is carnival down", never converts). Task 2fa90ac7.
  const noindex = lang === "es" && slug.startsWith("carnival-s-website-is-down-for-18-hours");
  // `title` is the on-page <h1> headline (unchanged); `seoTitle` is what search
  // engines see in <title>/OG — the two differ only when an SEO override is set.
  const title = escapeHtml(pick(story, "title", lang));
  const seoTitle = escapeHtml(seoTitleFor(story, lang, ov));
  const desc = escapeHtml(seoDescFor(story, lang, ov));
  const summary = escapeHtml(pick(story, "summary", lang));
  const impact = escapeHtml(pick(story, "travelerImpact", lang));
  const editorial = escapeHtml(pick(story, "editorialReasoning", lang));
  const longform = (ov && (lang === "es" ? ov.bodyHtml_es : ov.bodyHtml)) || ""; // trusted HTML — deep-dive body
  const original = escapeHtml(story.originalLink || story.link || "");
  const b = badge(story, lang);
  const date = fmtDate(story.approvedAt || story.generatedAt, lang);
  const metaLine = [escapeHtml(sourceName(story)), date, escapeHtml(story.impactLevel || "")]
    .filter(Boolean)
    .join(" · ");

  const relatedHtml = related.length
    ? `<section class="related"><h2>${t.related}</h2>${related
        .map((r) => {
          const rs = storySlug(r);
          const href = lang === "es" ? `/es/news/${rs}.html` : `/news/${rs}.html`;
          return `<a href="${href}">${escapeHtml(pick(r, "title", lang))}</a>`;
        })
        .join("")}</section>`
    : "";

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${seoTitle} | Still Afloat</title>
<meta name="description" content="${desc}">
${noindex ? '<meta name="robots" content="noindex">' : ""}
${hreflangLinks(slug, lang)}
<meta property="og:type" content="article">
<meta property="og:site_name" content="Still Afloat Cruising">
<meta property="og:url" content="${self}">
<meta property="og:title" content="${seoTitle}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${story.image ? escapeHtml(story.image) : LOGO}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${seoTitle}">
<meta name="twitter:description" content="${desc}">
<link rel="stylesheet" href="/css/styles.css">
<script type="application/ld+json">${jsonLd(story, slug, lang, ov)}</script>
<style>${STORY_CSS}</style>
</head>
<body>
<header class="story-page-header"><div id="navbar-container"></div></header>
<div class="story-shell">
<section class="hero"></section>
<article class="story-card">
${story.image ? `<img class="story-image" src="${escapeHtml(story.image)}" alt="${title}" loading="lazy">` : ""}
<div class="story-content">
<div class="badge" style="${b.style}">${b.label}</div>
<h1 class="story-title">${title}</h1>
<div class="story-meta">${metaLine}</div>
<div class="story-summary">${summary}</div>
${impact ? `<div class="traveler-impact-panel"><div class="tip-label">${t.impactLabel}</div><p>${impact}</p></div>` : ""}
${editorial ? `<div class="editorial-panel"><div class="tip-label">${t.editorialLabel}</div><p>${editorial}</p></div>` : ""}
${longform ? `<div class="story-longform">${longform}</div>` : ""}
<div class="actions">
${original ? `<a href="${original}" target="_blank" rel="noopener noreferrer">${t.readOriginal}</a>` : ""}
<a href="${t.feedPath}">${t.backToFeed}</a>
</div>
<div class="note">${t.note}</div>
</div>
</article>
<section class="story-cta" style="max-width:1100px;width:92%;margin:26px auto 0;padding:28px 30px;border-radius:26px;background:linear-gradient(135deg,rgba(93,255,154,.10),rgba(0,119,182,.12));border:1px solid rgba(93,255,154,.24);text-align:center;box-shadow:0 12px 32px rgba(0,0,0,.24)">
<h2 style="margin:0 0 8px;font-size:24px;font-weight:900;color:#fff">${t.ctaTitle}</h2>
<p style="margin:0 auto 18px;max-width:560px;color:rgba(255,255,255,.84);line-height:1.65">${t.ctaBody}</p>
<a href="${t.ctaHref}" style="display:inline-block;padding:14px 30px;border-radius:16px;background:linear-gradient(135deg,#0077b6,#023e6e);color:#5dff9a;font-weight:800;text-decoration:none;box-shadow:0 10px 28px rgba(0,0,0,.30)">${t.ctaButton}</a>
</section>
${relatedHtml}
</div>
<footer>© 2026 Still Afloat LLC — Cruise smarter. Laugh more. <img src="/assets/images/stay-afloat-text.png" alt="Stay Afloat" class="brand-img-sm"></footer>
<script src="/components/navbar.js?v=20260626-live"></script>
</body>
</html>`;
}

// ── listing page (overwrites news.html / es/news.html in place) ──────────────
const FEED_CSS = `body{background:radial-gradient(circle at top right, rgba(0,119,182,0.24), transparent 28%),radial-gradient(circle at left center, rgba(93,255,154,0.10), transparent 30%),linear-gradient(to bottom,#06111f 0%,#0b2238 35%,#102f4d 100%);min-height:100vh;color:white}.news-page-header{position:relative;height:110px;width:100%}.news-wrap{max-width:1100px;margin:auto;padding:24px 22px 70px}.news-panel{margin-bottom:26px;padding:22px 24px;border-radius:26px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.10);backdrop-filter:blur(16px);box-shadow:0 18px 44px rgba(0,0,0,.24)}.news-panel h1{margin:0 0 12px;font-size:44px;line-height:1}.news-panel p{margin:0;color:rgba(255,255,255,.72);line-height:1.6}article.story{margin-bottom:18px;padding:20px 22px;border-radius:22px;background:rgba(210,230,255,0.10);backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.08);box-shadow:0 8px 22px rgba(0,0,0,.16);transition:all .22s ease}article.story:hover{transform:translateY(-4px);box-shadow:0 18px 38px rgba(0,0,0,.24);border-color:rgba(93,255,154,.24)}article.story h2{font-size:22px;line-height:1.28;margin:0 0 10px}article.story h2 a{color:white;text-decoration:none}article.story h2 a:hover{color:#5dff9a}article.story p{line-height:1.55;color:rgba(255,255,255,.76);margin:0 0 14px;font-size:15px}article.story .more{color:#7de3ff;font-weight:800;text-decoration:none;font-size:14px}.story-top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}.pill{padding:4px 10px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.03em}.src{font-size:11px;font-weight:800;color:rgba(255,255,255,.62);text-transform:uppercase;letter-spacing:.05em}.when{font-size:11px;color:rgba(255,255,255,.52);font-weight:700}.archive{margin-top:34px}.archive h2{font-size:20px}.archive a{display:block;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.10);color:white;text-decoration:none;font-weight:700;line-height:1.4}.archive a:hover{color:#5dff9a}footer{padding:30px 20px 50px;text-align:center;color:rgba(255,255,255,.52)}@media(max-width:768px){.news-page-header{height:70px}.news-wrap{padding:16px 14px 50px}.news-panel{padding:18px 16px;border-radius:18px}.news-panel h1{font-size:26px}.news-panel p{font-size:15px}}`;

const FULL_CARDS = 20; // full cards on the listing; the rest become archive links

function feedPageHtml(stories: NewsStory[], lang: Lang): string {
  const t = L[lang];
  const self = `${SITE}${t.feedPath}`;
  const other = lang === "es" ? `${SITE}${L.en.feedPath}` : `${SITE}${L.es.feedPath}`;

  const card = (story: NewsStory): string => {
    const slug = storySlug(story);
    const href = lang === "es" ? `/es/news/${slug}.html` : `/news/${slug}.html`;
    const b = badge(story, lang);
    const date = fmtDate(story.approvedAt || story.generatedAt, lang);
    // The FULL cliffnote, untruncated — matching the pre-2026-07-08 page
    // (Mark: the listing must carry the cliffnotes, not one-line teasers).
    // Richer static text is also better SEO, so the goals align.
    const desc = escapeHtml(pick(story, "summary", lang) || pick(story, "travelerImpact", lang));
    return `<article class="story">
<div class="story-top"><div><span class="pill" style="${b.style}">${b.label}</span> <span class="src">${escapeHtml(sourceName(story))}</span></div>${date ? `<span class="when">${date}</span>` : ""}</div>
<h2><a href="${href}">${escapeHtml(pick(story, "title", lang))}</a></h2>
<p>${desc}</p>
<a class="more" href="${href}">${t.openDetail}</a>
</article>`;
  };

  const archiveLink = (story: NewsStory): string => {
    const slug = storySlug(story);
    const href = lang === "es" ? `/es/news/${slug}.html` : `/news/${slug}.html`;
    return `<a href="${href}">${escapeHtml(pick(story, "title", lang))}</a>`;
  };

  const cards = stories.slice(0, FULL_CARDS).map(card).join("\n");
  const rest = stories.slice(FULL_CARDS);
  const archive = rest.length
    ? `<section class="archive"><h2>${t.archive}</h2>${rest.map(archiveLink).join("")}</section>`
    : "";

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${t.feedTitle}</title>
<meta name="description" content="${t.feedDesc}">
<link rel="canonical" href="${self}">
<link rel="alternate" hreflang="${lang}" href="${self}">
<link rel="alternate" hreflang="${lang === "es" ? "en" : "es"}" href="${other}">
<link rel="alternate" hreflang="x-default" href="${SITE}${L.en.feedPath}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Still Afloat Cruising">
<meta property="og:url" content="${self}">
<meta property="og:title" content="${t.feedTitle}">
<meta property="og:description" content="${t.feedDesc}">
<meta property="og:image" content="${LOGO}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t.feedTitle}">
<meta name="twitter:description" content="${t.feedDesc}">
<link rel="stylesheet" href="/css/styles.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<style>${FEED_CSS}</style>
</head>
<body>
<header class="news-page-header">
  <div id="navbar-container"></div>
</header>
<main class="news-wrap">
<div class="news-panel">
<h1>${t.feedH1}</h1>
<p>${t.feedIntro}</p>
</div>
${cards}
${archive}
</main>
<footer>© 2026 Still Afloat LLC — Cruise smarter. Laugh more. <img src="/assets/images/stay-afloat-text.png" alt="Stay Afloat" class="brand-img-sm"></footer>
<script src="/components/navbar.js?v=20260626-live"></script>
</body>
</html>`;
}

// ── sitemap ──────────────────────────────────────────────────────────────────
function sitemapXml(stories: NewsStory[]): string {
  const entries: string[] = [];
  const day = (iso?: string): string => {
    const d = iso ? new Date(iso) : new Date();
    return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().slice(0, 10);
  };
  const newest = stories[0]?.approvedAt;
  entries.push(
    `<url><loc>${SITE}/news.html</loc><lastmod>${day(newest)}</lastmod><changefreq>daily</changefreq></url>`,
    `<url><loc>${SITE}/es/news.html</loc><lastmod>${day(newest)}</lastmod><changefreq>daily</changefreq></url>`,
  );
  for (const story of stories) {
    const u = urls(storySlug(story));
    const lastmod = day(story.approvedAt || story.generatedAt);
    entries.push(
      `<url><loc>${u.en}</loc><lastmod>${lastmod}</lastmod></url>`,
      `<url><loc>${u.es}</loc><lastmod>${lastmod}</lastmod></url>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`;
}

// ── archived-story normalization ─────────────────────────────────────────────
// archive-stories holds the RAW approved story objects (the newsagent's
// normalizeStory() shape): editorial reasoning lives in `reasoning` and there
// is no `originalLink`. Map onto the publishing NewsStory shape so archived
// pages render identically to when the story was live.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function archivedToNewsStory(raw: Record<string, any>): NewsStory {
  return {
    ...raw,
    editorialReasoning: raw["editorialReasoning"] || raw["reasoning"] || "",
    originalLink: raw["originalLink"] || raw["link"] || "",
  } as NewsStory;
}

// ── main entry ───────────────────────────────────────────────────────────────
export async function runNewsPrerender(): Promise<{ stories: number; pages: number }> {
  const data = await readJson<{ generatedAt?: string; stories?: NewsStory[] }>(
    PATHS.storyDetails,
    { generatedAt: undefined, stories: [] },
  );
  // Archived stories (aged out of the live feed by the newsagent's 21-day
  // sweep) — merged back in so their pages + sitemap entries persist.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const archiveData = await readJson<{ stories?: Record<string, any>[] }>(
    PATHS.archive,
    { stories: [] },
  );
  // Per-story SEO title/description overrides (optional; keyed by story id).
  const seoOverrides = await readJson<SeoOverrideMap>(PATHS.seoOverrides, {});
  const seenSlugs = new Set<string>();
  // Live stories FIRST: when the same story exists in both collections (the
  // archive is also an approval-time copy ledger), the slug dedup below keeps
  // the live/publishing version. Array.sort is stable, so equal-date live
  // entries stay ahead of their archived twins.
  const combined: NewsStory[] = [
    ...(data.stories ?? []),
    ...(archiveData.stories ?? []).map(archivedToNewsStory),
  ];
  const stories = combined
    .filter((s) => s && s.id && s.title)
    .sort((a, b) =>
      String(b.approvedAt || b.generatedAt || "").localeCompare(
        String(a.approvedAt || a.generatedAt || ""),
      ),
    )
    // story-details occasionally carries duplicate records for the same id —
    // keep the newest so each page (and sitemap entry) appears exactly once.
    .filter((s) => {
      const slug = storySlug(s);
      if (seenSlugs.has(slug)) return false;
      seenSlugs.add(slug);
      return true;
    });
  if (stories.length === 0) {
    logger.info("News prerender: no stories in story-details — nothing generated");
    return { stories: 0, pages: 0 };
  }

  const publicDir = resolvePublicDir();
  const enDir = path.join(publicDir, "news");
  const esDir = path.join(publicDir, "es", "news");
  await mkdir(enDir, { recursive: true });
  await mkdir(esDir, { recursive: true });

  let pages = 0;
  for (const story of stories) {
    const slug = storySlug(story);
    const related = stories
      .filter((r) => r.id !== story.id && r.category === story.category)
      .slice(0, 3);
    const rel = related.length ? related : stories.filter((r) => r.id !== story.id).slice(0, 3);
    const ov = story.id ? seoOverrides[story.id] : undefined;
    await writeFile(path.join(enDir, `${slug}.html`), storyPageHtml(story, slug, "en", rel, ov));
    await writeFile(path.join(esDir, `${slug}.html`), storyPageHtml(story, slug, "es", rel, ov));
    pages += 2;
  }

  await writeFile(path.join(publicDir, "news.html"), feedPageHtml(stories, "en"));
  await writeFile(path.join(publicDir, "es", "news.html"), feedPageHtml(stories, "es"));
  await writeFile(path.join(publicDir, "news-sitemap.xml"), sitemapXml(stories));
  pages += 3;

  logger.info({ stories: stories.length, pages }, "News prerender complete");
  return { stories: stories.length, pages };
}
