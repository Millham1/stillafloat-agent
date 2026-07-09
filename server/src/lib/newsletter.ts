import { logger } from "./logger";
import { sendMail } from "./mailer";
import { readJson, writeJson, PATHS, getSupabase } from "./persistence";
import { buildUtm, fetchChannelVideos, type Lang } from "./social-agent";
import { unsubscribeUrl } from "../routes/subscribe";

// ─────────────────────────────────────────────────────────────────────────────
// Newsletter agent — assembles the weekly "Still Afloat Weekly" email:
// curated approved stories + Mark's latest commentary + a featured video + one
// affiliate pick + a "Laugh More" corner (verified fun fact + licensed Pexels
// photo) + a soft travel-agency P.S., in the brand voice ("Cruise smarter,
// laugh more"), value-never-hype. Produces a draft for approval; every field
// of the draft is editable on the review page before sending (Mark, 2026-07-09).
// Sending is a separate, explicit step (approve-first).
// ─────────────────────────────────────────────────────────────────────────────

const SITE = "https://stillafloatcruising.com";
const draftKey = (lang: Lang): string => (lang === "es" ? "newsletter-draft-es" : "newsletter-draft");

// Per-language UI strings for the rendered email.
const L = {
  en: {
    kicker: "Still Afloat Weekly",
    tagline: "Your curated cruise & travel intelligence",
    hi: (n: string) => `Hey ${n},`,
    readMore: "Read More →",
    watch: "▶ Watch this week",
    gear: "Gear worth packing",
    gearCta: "Check it out →",
    affNote: "Affiliate link — supports Still Afloat at no cost to you.",
    seeAll: "See All Cruise News →",
    ps: "P.S.",
    psCta: "Get in touch →",
    footTag: "Cruise smarter. Laugh more. Stay Afloat.",
    unsub: "Unsubscribe",
    marksTake: "🗣 Mark's Take",
    readTake: "Read the full take →",
    laughMore: "😄 Laugh More",
    funFactLabel: "Fun fact of the week",
    photoBy: "Photo",
  },
  es: {
    kicker: "Still Afloat Semanal",
    tagline: "Tu resumen de cruceros y viajes",
    hi: (n: string) => `Hola ${n},`,
    readMore: "Leer más →",
    watch: "▶ Para ver esta semana",
    gear: "Equipo que vale la pena",
    gearCta: "Míralo →",
    affNote: "Enlace de afiliado — apoya a Still Afloat sin costo para ti.",
    seeAll: "Ver más noticias de cruceros →",
    ps: "P.D.",
    psCta: "Escríbeme →",
    footTag: "Navega más inteligente. Ríe más.",
    unsub: "Cancelar suscripción",
    marksTake: "🗣 La opinión de Mark",
    readTake: "Leer la opinión completa →",
    laughMore: "😄 Ríe más",
    funFactLabel: "Dato curioso de la semana",
    photoBy: "Foto",
  },
} as const;

export interface Story {
  id: string;
  title: string;
  summary: string;
  link: string;
  impact: string;
}

export interface NewsletterDraft {
  subject: string;
  intro: string;
  storyIds: string[];
  // Editable snapshot of the chosen stories, taken at draft time. When present
  // this is the source of truth for rendering/sending (edits on the review page
  // land here and never mutate the approved-stories store). Absent on legacy
  // drafts, which fall back to a live approved-stories lookup by storyIds.
  stories?: Story[];
  commentary?: { id: string; title: string; excerpt: string; url: string; blurb: string };
  funFact?: string;
  photo?: { url: string; alt: string; photographer: string; photographerUrl: string };
  video?: { id: string; title: string; blurb: string; url: string; thumbnail: string };
  affiliate?: { id: string; title: string; blurb: string; imageUrl: string; link: string };
  agencyPs: string;
  lang: Lang;
  generatedAt: string;
  status: "pending" | "sent";
  sentAt?: string;
}

function stripHtmlTags(str: string): string {
  return String(str).replace(/<[^>]*>/g, "");
}

function utm(base: string, content: string): string {
  return buildUtm(base, { source: "newsletter", medium: "email", campaign: "weekly", content });
}

async function gatherApprovedStories(lang: Lang = "en"): Promise<Story[]> {
  const data = await readJson<{ stories?: Record<string, unknown>[] }>(PATHS.approved, { stories: [] });
  return (data.stories ?? []).map((s) => ({
    id: String(s.id ?? ""),
    // ES uses the Spanish cliffnote/title when present, else falls back to EN.
    title: String((lang === "es" && s["title_es"]) || s.title || ""),
    summary: String(
      (lang === "es" && (s["summary_es"] ?? s["cliffnote_es"])) || s.summary || s.synopsis || "",
    ),
    link: String(s.link ?? s.originalLink ?? ""),
    impact: String((lang === "es" && s["impactLevel_es"]) || s.impactLevel || s.travelerImpact || ""),
  })).filter((s) => s.id && s.title);
}

async function gatherFeaturedVideo(): Promise<{ id: string; title: string; thumbnail: string } | null> {
  // Prefer the manually featured video; fall back to the latest channel upload.
  const ch = await readJson<{ featuredId?: string; videos?: Array<Record<string, unknown>> }>(
    "youtube-channel",
    {},
  );
  const vids = ch.videos ?? [];
  if (ch.featuredId) {
    const v = vids.find((x) => String(x["id"]) === ch.featuredId);
    if (v) return { id: ch.featuredId, title: String(v["title"] ?? ""), thumbnail: String(v["thumbnail"] ?? "") };
  }
  const first = vids[0];
  if (first) {
    return { id: String(first["id"] ?? ""), title: String(first["title"] ?? ""), thumbnail: String(first["thumbnail"] ?? "") };
  }
  try {
    const latest = await fetchChannelVideos(1);
    const v = latest[0];
    if (v) {
      return { id: v.id, title: v.title, thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` };
    }
  } catch (err) {
    logger.warn({ err }, "newsletter: channel video fetch failed");
  }
  return null;
}

async function gatherFeaturedAffiliate(): Promise<{ id: string; title: string; description: string; imageUrl: string; affiliateLink: string } | null> {
  const store = await readJson<{ items?: Array<Record<string, unknown>> }>(PATHS.affiliateItems, { items: [] });
  const items = store.items ?? [];
  if (items.length === 0) return null;
  const pick = items.find((i) => Boolean(i["featured"])) ?? items[0];
  if (!pick) return null;
  return {
    id: String(pick["id"] ?? ""),
    title: String(pick["title"] ?? ""),
    description: String(pick["description"] ?? ""),
    imageUrl: String(pick["imageUrl"] ?? ""),
    affiliateLink: String(pick["affiliateLink"] ?? `${SITE}/affiliate.html`),
  };
}

// Latest published commentary post (Mark's weekly op-ed) — the brand's voice,
// so the newsletter carries it whenever a reasonably fresh one exists.
const COMMENTARY_MAX_AGE_DAYS = 30;
async function gatherLatestCommentary(
  lang: Lang,
): Promise<{ id: string; title: string; excerpt: string; url: string } | null> {
  const store = await readJson<{ posts?: Array<Record<string, unknown>> }>(PATHS.commentary, { posts: [] });
  const published = (store.posts ?? [])
    .filter((p) => String(p["status"]) === "published")
    .sort((a, b) => String(b["published_at"] ?? "").localeCompare(String(a["published_at"] ?? "")));
  const post = published[0];
  if (!post) return null;
  const publishedAt = Date.parse(String(post["published_at"] ?? ""));
  if (Number.isFinite(publishedAt) && Date.now() - publishedAt > COMMENTARY_MAX_AGE_DAYS * 86_400_000) {
    return null; // nothing fresh — skip the section rather than resurface an old take
  }
  const body = stripHtmlTags(String((lang === "es" && post["body_es"]) || post["body_en"] || "")).trim();
  const excerpt = body.length > 220 ? `${body.slice(0, 220).replace(/\s+\S*$/, "")}…` : body;
  const esPrefix = lang === "es" ? "/es" : "";
  return {
    id: String(post["id"] ?? ""),
    title: String(post["title"] ?? ""),
    excerpt,
    url: `${SITE}${esPrefix}/commentary-post.html?id=${encodeURIComponent(String(post["id"] ?? ""))}`,
  };
}

// One licensed cruise photo for the "Laugh More" corner, via Pexels (free
// commercial license; we credit the photographer anyway). NEVER hotlink random
// web images into an email — licensing. No key / no results → section renders
// without a photo.
const PHOTO_QUERIES = [
  "cruise ship ocean",
  "cruise ship deck",
  "caribbean beach turquoise",
  "cruise ship sunset",
  "tropical island harbor",
];
async function fetchCruisePhoto(): Promise<NewsletterDraft["photo"] | null> {
  const key = process.env["PEXELS_API_KEY"] || "";
  if (!key) return null;
  const query = PHOTO_QUERIES[Math.floor(Math.random() * PHOTO_QUERIES.length)]!;
  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=15&orientation=landscape`,
      { headers: { authorization: key }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, "newsletter: pexels search failed");
      return null;
    }
    const data = (await res.json()) as { photos?: Array<Record<string, unknown>> };
    const photos = data.photos ?? [];
    if (photos.length === 0) return null;
    const pick = photos[Math.floor(Math.random() * photos.length)]!;
    const src = (pick["src"] ?? {}) as Record<string, unknown>;
    const url = String(src["large"] ?? src["medium"] ?? "");
    if (!url) return null;
    return {
      url,
      alt: String(pick["alt"] ?? "") || "Cruise photo of the week",
      photographer: String(pick["photographer"] ?? ""),
      photographerUrl: String(pick["photographer_url"] ?? ""),
    };
  } catch (err) {
    logger.warn({ err }, "newsletter: pexels fetch failed");
    return null;
  }
}

const SYSTEM_PROMPT = `You are the editor of "Still Afloat Weekly," a cruise & travel email newsletter.

Brand voice: "Cruise smarter, laugh more." Warm, smart, lightly funny — written by a host with 40 years of cruising. The audience is experienced, fairly affluent cruisers who value honest, useful insight.

CORE RULE — VALUE, NEVER HYPE: be specific and genuinely useful. No empty superlatives or clickbait ("you won't believe," "ultimate," "amazing," "must-see"). The subject line earns the open with real value, not shock.

You will receive this week's approved stories, possibly Mark's latest commentary post, a featured video, and one affiliate product. Produce:
- subject: a specific, value-led subject line (<= 60 chars), no hype, no ALL CAPS.
- intro: 1–2 warm sentences welcoming the reader and framing the week (brand voice).
- storyIds: the best 3–6 story ids, ordered most-valuable first (use ONLY ids provided).
- commentary_blurb: (only if a commentary post was provided) one warm sentence inviting the reader into Mark's take — his voice is the draw, so tease it, don't summarize it.
- fun_fact: 1–2 sentences for the "Laugh More" corner — a REAL, widely documented cruise or ocean-travel fun fact, told with a light touch. HARD RULE: only facts you are highly confident are true and verifiable; never invent numbers, records, or statistics. Charm comes from the telling, not from exaggeration.
- video_blurb: one inviting sentence about the featured video (honest, not hype).
- affiliate_blurb: one honest sentence on why the product is genuinely worth it (it's an affiliate pick — be candid, not salesy).
- agency_ps: one soft, personal P.S. offering travel-agency help (e.g., "Planning a cruise? I book them professionally now — just reply.").

Respond ONLY with JSON: { "subject", "intro", "storyIds":[], "commentary_blurb", "fun_fact", "video_blurb", "affiliate_blurb", "agency_ps" }.`;

const SYSTEM_PROMPT_ES = `Eres el editor de "Still Afloat Semanal", un boletín por correo sobre cruceros y viajes, para una audiencia hispanohablante (es-419, español latinoamericano neutro).

Voz de marca: "Navega más inteligente. Ríe más." Cálida, lista y con un toque de humor — escrita por un anfitrión con 40 años de experiencia en cruceros. Mantén nombres propios/de marca en su idioma original (líneas de crucero, barcos, puertos, "Amazon").

REGLA CENTRAL — VALOR, NUNCA EXAGERACIÓN: sé específico y genuinamente útil. Nada de superlativos vacíos ni clickbait ("no vas a creer", "increíble", "lo último"). El asunto se gana la apertura con valor real, no con escándalo.

Recibirás las noticias aprobadas de esta semana, posiblemente la opinión (commentary) más reciente de Mark, un video destacado y un producto de afiliado. Produce, TODO en español:
- subject: un asunto específico y con valor (<= 60 caracteres), sin exageración, sin MAYÚSCULAS.
- intro: 1–2 frases cálidas que reciben al lector y enmarcan la semana (voz de marca).
- storyIds: los mejores 3–6 ids de noticias, del más valioso al menos (usa SOLO los ids provistos).
- commentary_blurb: (solo si se provee un commentary) una frase cálida que invite a leer la opinión de Mark — su voz es el atractivo; provoca la lectura, no la resumas.
- fun_fact: 1–2 frases para la sección "Ríe más" — un dato curioso REAL y ampliamente documentado sobre cruceros o viajes por mar, contado con humor ligero. REGLA DURA: solo datos verificables de los que estés muy seguro; nunca inventes cifras, récords ni estadísticas.
- video_blurb: una frase honesta e invitadora sobre el video destacado.
- affiliate_blurb: una frase honesta de por qué el producto vale la pena (es un enlace de afiliado — sé sincero, no vendedor).
- agency_ps: una posdata breve y personal ofreciendo ayuda como agente de viajes (ej.: "¿Planeando un crucero? Ahora los reservo profesionalmente — solo responde a este correo.").

Responde SOLO con JSON: { "subject", "intro", "storyIds":[], "commentary_blurb", "fun_fact", "video_blurb", "affiliate_blurb", "agency_ps" }.`;

export async function draftNewsletter(lang: Lang = "en"): Promise<NewsletterDraft> {
  const apiKey = process.env["OPENAI_API_KEY"] || "";
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const [stories, video, affiliate, commentary, photo] = await Promise.all([
    gatherApprovedStories(lang),
    gatherFeaturedVideo(),
    gatherFeaturedAffiliate(),
    gatherLatestCommentary(lang),
    fetchCruisePhoto(),
  ]);
  if (stories.length === 0) throw new Error("No approved stories to build a newsletter from");

  const userContent = JSON.stringify(
    {
      stories: stories.map((s) => ({ id: s.id, title: s.title, summary: s.summary, impact: s.impact })),
      commentary_post: commentary ? { title: commentary.title, excerpt: commentary.excerpt } : null,
      featured_video: video ? { title: video.title } : null,
      affiliate_product: affiliate ? { title: affiliate.title, description: affiliate.description } : null,
    },
    null,
    2,
  );

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: lang === "es" ? SYSTEM_PROMPT_ES : SYSTEM_PROMPT },
        { role: "user", content: `Build this week's newsletter from:\n\n${userContent}` },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = (await response.json()) as any;
  const content: string = payload?.choices?.[0]?.message?.content ?? "";
  const parsed = JSON.parse(content) as {
    subject?: string;
    intro?: string;
    storyIds?: string[];
    commentary_blurb?: string;
    fun_fact?: string;
    video_blurb?: string;
    affiliate_blurb?: string;
    agency_ps?: string;
  };

  const validIds = new Set(stories.map((s) => s.id));
  const storyIds = (Array.isArray(parsed.storyIds) ? parsed.storyIds : [])
    .map(String)
    .filter((id) => validIds.has(id))
    .slice(0, 6);

  const chosenIds = storyIds.length ? storyIds : stories.slice(0, 5).map((s) => s.id);
  const byId = new Map(stories.map((s) => [s.id, s]));
  const draft: NewsletterDraft = {
    subject: (parsed.subject ?? (lang === "es" ? "Still Afloat Semanal" : "Still Afloat Weekly")).trim(),
    intro: (parsed.intro ?? "").trim(),
    storyIds: chosenIds,
    // Snapshot the chosen stories so review-page edits have a home of their own.
    stories: chosenIds.map((id) => byId.get(id)).filter((s): s is Story => Boolean(s)),
    agencyPs: (parsed.agency_ps ?? (lang === "es"
      ? "¿Planeando un crucero? Ahora los reservo profesionalmente — solo responde a este correo."
      : "Planning a cruise? I book them professionally now — just reply to this email.")).trim(),
    lang,
    generatedAt: new Date().toISOString(),
    status: "pending",
  };
  if (video) {
    draft.video = {
      id: video.id,
      title: video.title,
      blurb: (parsed.video_blurb ?? "").trim(),
      url: utm(`https://www.youtube.com/watch?v=${video.id}`, "video"),
      thumbnail: video.thumbnail,
    };
  }
  if (affiliate) {
    draft.affiliate = {
      id: affiliate.id,
      title: affiliate.title,
      blurb: (parsed.affiliate_blurb ?? "").trim(),
      imageUrl: affiliate.imageUrl,
      link: utm(affiliate.affiliateLink, "affiliate"),
    };
  }
  if (commentary) {
    draft.commentary = {
      ...commentary,
      url: utm(commentary.url, "commentary"),
      blurb: (parsed.commentary_blurb ?? "").trim(),
    };
  }
  const funFact = (parsed.fun_fact ?? "").trim();
  if (funFact) draft.funFact = funFact;
  if (photo) draft.photo = photo;

  logger.info(
    {
      stories: draft.storyIds.length,
      hasVideo: !!draft.video,
      hasAffiliate: !!draft.affiliate,
      hasCommentary: !!draft.commentary,
      hasFunFact: !!draft.funFact,
      hasPhoto: !!draft.photo,
    },
    "Drafted newsletter",
  );
  return draft;
}

export async function saveDraft(draft: NewsletterDraft): Promise<void> {
  await writeJson(draftKey(draft.lang ?? "en"), draft);
}
export async function loadDraft(lang: Lang = "en"): Promise<NewsletterDraft | null> {
  const d = await readJson<NewsletterDraft | null>(draftKey(lang), null);
  return d && d.subject ? d : null;
}

// ── Enriched email renderer ──────────────────────────────────────────────────
export function renderEnrichedNewsletter(
  draft: NewsletterDraft,
  stories: Story[],
  recipientName: string,
  recipientEmail: string,
  baseUrl: string,
): string {
  const lang: Lang = draft.lang ?? "en";
  const t = L[lang];
  const esPrefix = lang === "es" ? "/es" : "";
  const unsub = unsubscribeUrl(recipientEmail, baseUrl);
  const firstName = (recipientName || (lang === "es" ? "hola" : "there")).split(" ")[0] || "there";
  const byId = new Map(stories.map((s) => [s.id, s]));

  // Draft snapshot (edited on the review page) wins; legacy drafts fall back
  // to a live lookup against the approved-stories store.
  const draftStories: Story[] =
    draft.stories && draft.stories.length
      ? draft.stories
      : draft.storyIds.map((id) => byId.get(id)).filter((s): s is Story => Boolean(s));

  const storyRows = draftStories
    .map((s) => {
      const storyUrl = s.link || `${baseUrl}${esPrefix}/story.html?id=${s.id}`;
      return `
    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:20px 22px;margin-bottom:16px;background:#fff;">
      ${s.impact ? `<span style="display:inline-block;background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:2px 10px;font-size:12px;color:#1d4ed8;font-weight:700;margin-bottom:10px;">${s.impact}</span>` : ""}
      <h2 style="margin:0 0 10px;font-size:17px;color:#0c2035;line-height:1.4;font-weight:800;">${s.title}</h2>
      <p style="margin:0 0 14px;color:#374151;font-size:14px;line-height:1.7;">${s.summary}</p>
      <a href="${storyUrl}" style="display:inline-block;background:#0077b6;color:#fff;padding:9px 18px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700;">${t.readMore}</a>
    </div>`;
    })
    .join("");

  const videoBlock = draft.video
    ? `
    <div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;margin:24px 0 16px;background:#fff;">
      <a href="${draft.video.url}" style="text-decoration:none;">
        ${draft.video.thumbnail ? `<img src="${draft.video.thumbnail}" alt="" style="display:block;width:100%;max-width:600px;"/>` : ""}
        <div style="padding:16px 22px;">
          <p style="margin:0 0 4px;font-size:12px;color:#0077b6;font-weight:700;text-transform:uppercase;letter-spacing:.06em;">${t.watch}</p>
          <h3 style="margin:0 0 6px;font-size:16px;color:#0c2035;font-weight:800;">${draft.video.title}</h3>
          ${draft.video.blurb ? `<p style="margin:0;color:#374151;font-size:14px;line-height:1.6;">${draft.video.blurb}</p>` : ""}
        </div>
      </a>
    </div>`
    : "";

  const affiliateBlock = draft.affiliate
    ? `
    <div style="border:1px dashed #cbd5e1;border-radius:12px;padding:18px 22px;margin:16px 0;background:#fbfdff;">
      <p style="margin:0 0 6px;font-size:12px;color:#0e7490;font-weight:700;text-transform:uppercase;letter-spacing:.06em;">${t.gear}</p>
      <h3 style="margin:0 0 6px;font-size:16px;color:#0c2035;font-weight:800;">${draft.affiliate.title}</h3>
      ${draft.affiliate.blurb ? `<p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.6;">${draft.affiliate.blurb}</p>` : ""}
      <a href="${draft.affiliate.link}" style="display:inline-block;background:#0e7490;color:#fff;padding:9px 18px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700;">${t.gearCta}</a>
      <p style="margin:8px 0 0;color:#9ca3af;font-size:11px;">${t.affNote}</p>
    </div>`
    : "";

  // Mark's Take — his voice is the differentiator, so it leads the issue.
  const commentaryBlock = draft.commentary
    ? `
    <div style="border-left:4px solid #0077b6;border-radius:12px;padding:18px 22px;margin:0 0 20px;background:#eef7fc;">
      <p style="margin:0 0 6px;font-size:12px;color:#0077b6;font-weight:700;text-transform:uppercase;letter-spacing:.06em;">${t.marksTake}</p>
      <h2 style="margin:0 0 8px;font-size:17px;color:#0c2035;line-height:1.4;font-weight:800;">${draft.commentary.title}</h2>
      ${draft.commentary.blurb ? `<p style="margin:0 0 10px;color:#374151;font-size:14px;line-height:1.7;">${draft.commentary.blurb}</p>` : ""}
      ${draft.commentary.excerpt ? `<p style="margin:0 0 14px;color:#4b5563;font-size:14px;line-height:1.7;font-style:italic;">“${draft.commentary.excerpt}”</p>` : ""}
      <a href="${draft.commentary.url}" style="display:inline-block;background:#07183f;color:#5dff9a;padding:9px 18px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700;">${t.readTake}</a>
    </div>`
    : "";

  // Laugh More corner — licensed photo + verified fun fact.
  const laughBlock = draft.funFact || draft.photo
    ? `
    <div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;margin:24px 0 16px;background:#fff;">
      ${draft.photo ? `<img src="${draft.photo.url}" alt="${escapeAttr(draft.photo.alt)}" style="display:block;width:100%;max-width:600px;"/>` : ""}
      <div style="padding:16px 22px;">
        <p style="margin:0 0 4px;font-size:12px;color:#d97706;font-weight:700;text-transform:uppercase;letter-spacing:.06em;">${t.laughMore} — ${t.funFactLabel}</p>
        ${draft.funFact ? `<p style="margin:0;color:#374151;font-size:14px;line-height:1.7;">${draft.funFact}</p>` : ""}
        ${draft.photo && draft.photo.photographer ? `<p style="margin:8px 0 0;color:#9ca3af;font-size:11px;">${t.photoBy}: <a href="${draft.photo.photographerUrl || "https://www.pexels.com"}" style="color:#9ca3af;">${draft.photo.photographer}</a> / Pexels</p>` : ""}
      </div>
    </div>`
    : "";

  const agencyUrl = utm(`${baseUrl}${esPrefix}/work-with-mark.html#contact`, "agency");

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f0f4f8;padding:0;margin:0;">
  <div style="max-width:600px;margin:32px auto;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);">
    <div style="background:linear-gradient(135deg,#07183f,#0077b6);padding:28px 32px;text-align:center;">
      <p style="margin:0 0 6px;color:rgba(255,255,255,.6);font-size:12px;letter-spacing:.10em;text-transform:uppercase;">${t.kicker}</p>
      <h1 style="margin:0 0 6px;color:#5dff9a;font-size:24px;font-weight:900;">${draft.subject}</h1>
      <p style="margin:0;color:rgba(255,255,255,.65);font-size:13px;">${t.tagline}</p>
    </div>
    <div style="background:#f9fafb;padding:28px 32px;">
      <p style="margin:0 0 18px;color:#1e3a5f;font-size:15px;line-height:1.6;">${t.hi(firstName)}${draft.intro ? ` ${draft.intro}` : ""}</p>
      ${commentaryBlock}
      ${storyRows}
      ${videoBlock}
      ${laughBlock}
      ${affiliateBlock}
      <div style="text-align:center;margin-top:24px;">
        <a href="${utm(lang === "es" ? `${baseUrl}/es/` : `${baseUrl}/news.html`, "see-all")}" style="display:inline-block;background:linear-gradient(135deg,#0077b6,#07183f);color:#5dff9a;padding:14px 28px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;">${t.seeAll}</a>
      </div>
      ${draft.agencyPs ? `<p style="margin:24px 0 0;color:#475569;font-size:14px;line-height:1.6;border-top:1px solid #e5e7eb;padding-top:18px;"><strong>${t.ps}</strong> ${draft.agencyPs} <a href="${agencyUrl}" style="color:#0077b6;">${t.psCta}</a></p>` : ""}
    </div>
    <div style="background:#fff;padding:16px 32px;border-top:1px solid #e5e7eb;text-align:center;">
      <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.7;">
        Still Afloat · <em>${t.footTag}</em><br>
        <a href="${unsub}" style="color:#9ca3af;font-size:11px;">${t.unsub}</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

// Newsletter goes out via the ops-manager Gmail sender (same path as
// transactional mail since the 2026-07-01 Resend key compromise). Gmail is fine
// at the current list size; past the cap below, deliverability and the ~500/day
// Gmail ceiling both say: move to a real ESP before sending.
const GMAIL_LIST_CAP = 200;

// ── Send (explicit, approve-first) ───────────────────────────────────────────
export async function sendNewsletterDraft(
  draft: NewsletterDraft,
  baseUrl: string,
): Promise<{ sent: number; failed: number; total: number }> {
  const lang: Lang = draft.lang ?? "en";
  const stories = await gatherApprovedStories(lang);
  const supabase = getSupabase();
  const { data: subscribers, error } = await supabase
    .from("subscribers")
    .select("email, name")
    .eq("status", "confirmed")
    .eq("lang", lang); // only this edition's language
  if (error) throw new Error("Failed to load subscribers");
  const list = (subscribers ?? []) as Array<{ email: string; name: string }>;
  if (list.length === 0) return { sent: 0, failed: 0, total: 0 };
  if (list.length > GMAIL_LIST_CAP) {
    throw new Error(
      `Subscriber list (${list.length}) exceeds the Gmail send cap (${GMAIL_LIST_CAP}) — migrate newsletter sending to a real ESP first.`,
    );
  }

  let sent = 0;
  let failed = 0;
  for (const sub of list) {
    const html = renderEnrichedNewsletter(draft, stories, sub.name, sub.email, baseUrl);
    const ok = await sendMail({ to: sub.email, subject: draft.subject, html, fromName: "Still Afloat" });
    ok ? sent++ : failed++;
    await new Promise((r) => setTimeout(r, 1200)); // pace the Gmail API
  }
  logger.info({ subject: draft.subject, sent, failed }, "Newsletter (agent) send complete");
  return { sent, failed, total: list.length };
}

function escapeAttr(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function previewStories(draft: NewsletterDraft, stories: Story[]): Story[] {
  if (draft.stories && draft.stories.length) return draft.stories;
  const byId = new Map(stories.map((s) => [s.id, s]));
  return draft.storyIds.map((id) => byId.get(id)).filter((s): s is Story => Boolean(s));
}

export { gatherApprovedStories };
