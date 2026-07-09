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
    fromMark: "From Mark's desk",
    fullTake: "my full take is on the site →",
    signoff: "— Mark",
    worthBooking: "🛳 Worth booking this week",
    bookingCta: "Have Mark check your dates →",
    quickHitsLabel: "⚓ Quick hits — worth knowing this week",
    tagline2: "Cruise smarter. Laugh more. Stay Afloat.",
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
    fromMark: "Desde el escritorio de Mark",
    fullTake: "mi opinión completa está en el sitio →",
    signoff: "— Mark",
    worthBooking: "🛳 Vale la pena reservar esta semana",
    bookingCta: "Que Mark revise tus fechas →",
    quickHitsLabel: "⚓ En corto — lo que vale saber esta semana",
    tagline2: "Navega más inteligente. Ríe más.",
  },
} as const;

export interface Story {
  id: string;
  title: string;
  summary: string;
  link: string;
  impact: string;
}

// Redesigned 2026-07-09 after Mark's hard reject of the news-digest format:
// the newsletter is a personal, branded letter that drives BOOKINGS, not story
// clicks. Mark's letter opens (distilled from his commentary when one exists),
// "Worth booking this week" is the centerpiece with the only big CTA, the
// week's news is demoted to 2–4 link-free one-liners, and the Laugh More
// corner keeps it fun. Every field is editable on the review page.
export interface NewsletterDraft {
  subject: string;
  intro: string; // legacy field, superseded by `letter`
  letter?: string; // Mark's opening letter (his voice; from his commentary when available)
  quickHits?: string[]; // 2–4 plain one-liners, deliberately NO links/buttons
  booking?: { headline: string; body: string }; // the booking CTA centerpiece
  storyIds: string[];
  // Snapshot of the stories the AI worked from (grounding/reference; the new
  // template renders quickHits, not story cards).
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
): Promise<{ id: string; title: string; excerpt: string; url: string; body: string } | null> {
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
    body: body.slice(0, 1500), // raw material for distilling Mark's letter
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

const SYSTEM_PROMPT = `You write "Still Afloat Weekly" AS Mark Millham — this email is a letter from Mark to friends, never a corporate newsletter.

WHO MARK IS: retired IT senior manager, veteran, lived aboard his own sailboat for about 12 years, 20+ years of cruising, now a travel advisor who books cruises for people. Tagline: "Cruise smarter. Laugh more. Stay Afloat."

VOICE — the experienced friend on the next barstool: first person singular ("I", never "we"), contractions, plainspoken, warm, wry. Humor is seasoning; useful information is the meal. Reads like Mark talking, not a brand campaign.

BANNED (instant rewrite if you catch yourself): "navigating", "dive into/diving into", "explore the world of", "journey" as filler, "elevate", "unlock", "thrilling", "exciting news", "well-informed", "stay tuned", "in the world of cruising", subject lines shaped like "Verb-ing the X and Y of Z", empty superlatives, clickbait, ALL CAPS.
NEVER invent personal anecdotes, trips, or experiences for Mark. If his commentary is provided, his words are the raw material; keep his phrases where you can.

THE POINT OF THIS EMAIL: the reader should finish it feeling like cruising is fun and smart people book through Mark. It exists to drive BOOKINGS (replies and clicks to his booking page) — NOT to drive clicks to news stories.

TONE ON NEWS: the reader gets doom headlines everywhere else. Pick what a traveler can USE (deals, changes that affect planning, good news). At most ONE cautionary item, and only if travelers genuinely need it — deliver it in one calm line, never as a scare.

You will receive this week's stories, possibly Mark's latest commentary, a featured video, and one affiliate product. Produce:
- subject: <= 60 chars, sounds like a text from a friend — specific, human, a little fun. (Good shape: "A 50% sale, a $26 water bottle, and my two cents".)
- letter: Mark's opening letter, 3–5 sentences. Do NOT begin with a greeting ("Hey friends," etc.) — the email inserts "Hey <first name>," automatically; start mid-thought. If his commentary is provided, distill IT — his stance, his phrasing, first person — and end with one easy sentence that turns the reader toward planning/booking. If no commentary, open warm and seasonal without inventing personal stories.
- quick_hits: 2–4 one-liners from the provided stories, each <= 22 words, plain and useful, no hype. These render WITHOUT links on purpose.
- booking_headline: <= 8 words naming this week's most bookable angle from the stories (a sale, a season, a destination) — or, if nothing qualifies, an evergreen angle (e.g. off-season pricing). Plain and specific, no exclamation marks, no "exciting".
- booking_body: 2–3 sentences on why that angle is smart, ending with Mark offering to check it against the reader's dates ("reply to this email or hit the button").
- fun_fact: 1–2 sentences for the "Laugh More" corner — a REAL, widely documented cruise or ocean fun fact told with actual humor. HARD RULE: only facts you are highly confident are true; never invent numbers or records.
- video_blurb: one inviting, honest sentence about the featured video.
- affiliate_blurb: one candid sentence on why the product earns its place in a suitcase.
- agency_ps: one soft, personal P.S. offering booking help.

Respond ONLY with JSON: { "subject", "letter", "quick_hits":[], "booking_headline", "booking_body", "fun_fact", "video_blurb", "affiliate_blurb", "agency_ps" }.`;

const SYSTEM_PROMPT_ES = `Escribes "Still Afloat Semanal" COMO Mark Millham — este correo es una carta de Mark a sus amigos, nunca un boletín corporativo. Español latinoamericano neutro (es-419).

QUIÉN ES MARK: gerente senior de TI retirado, veterano, vivió unos 12 años a bordo de su propio velero, 20+ años tomando cruceros, hoy asesor de viajes que reserva cruceros para la gente. Lema: "Navega más inteligente. Ríe más."

VOZ — el amigo con experiencia en la barra de al lado: primera persona singular ("yo", nunca "nosotros"), cercano, directo, cálido, con humor seco. El humor es el condimento; la información útil es el plato. Mantén nombres propios en su idioma original (líneas, barcos, puertos, "Amazon").

PROHIBIDO (reescribe si te descubres): "navegando por", "sumérgete", "explora el mundo de", "eleva", "emocionante", "no te lo pierdas", "mantente informado", asuntos con forma "Verbo-ando lo X y lo Y de Z", superlativos vacíos, clickbait, MAYÚSCULAS.
NUNCA inventes anécdotas, viajes ni experiencias personales de Mark. Si se provee su commentary, sus palabras son la materia prima.

EL OBJETIVO DEL CORREO: que el lector termine sintiendo que crucerear es divertido y que la gente lista reserva con Mark. Existe para generar RESERVAS (respuestas y clics a su página de reservas) — NO para llevar tráfico a noticias.

TONO CON LAS NOTICIAS: el lector ya recibe titulares negativos en todas partes. Elige lo que un viajero puede USAR (ofertas, cambios que afectan la planificación, buenas noticias). Máximo UNA nota de precaución, solo si es realmente necesaria, en una línea tranquila.

Recibirás las noticias de la semana, posiblemente el commentary más reciente de Mark, un video destacado y un producto de afiliado. Produce, TODO en español:
- subject: <= 60 caracteres, suena a mensaje de un amigo — específico, humano, con gracia.
- letter: la carta de apertura de Mark, 3–5 frases. NO empieces con un saludo ("Hola amigos," etc.) — el correo inserta "Hola <nombre>," automáticamente; empieza en medio del pensamiento. Si hay commentary, destílalo — su postura, sus frases, primera persona — y cierra con una frase fácil que lleve al lector hacia planear/reservar. Sin commentary, abre cálido y de temporada sin inventar historias personales.
- quick_hits: 2–4 líneas de las noticias provistas, cada una <= 22 palabras, útiles y sin exageración. Se muestran SIN enlaces a propósito.
- booking_headline: <= 8 palabras con el ángulo más reservable de la semana (una oferta, una temporada, un destino) — o un ángulo permanente si nada califica. Directo y específico, sin signos de exclamación, sin "emocionante".
- booking_body: 2–3 frases de por qué conviene, cerrando con Mark ofreciendo revisarlo contra las fechas del lector ("responde a este correo o toca el botón").
- fun_fact: 1–2 frases para "Ríe más" — un dato curioso REAL y ampliamente documentado sobre cruceros o el mar, contado con humor de verdad. REGLA DURA: solo datos verificables; nunca inventes cifras ni récords.
- video_blurb: una frase honesta e invitadora sobre el video.
- affiliate_blurb: una frase sincera de por qué el producto se gana su lugar en la maleta.
- agency_ps: una posdata breve y personal ofreciendo ayuda para reservar.

Responde SOLO con JSON: { "subject", "letter", "quick_hits":[], "booking_headline", "booking_body", "fun_fact", "video_blurb", "affiliate_blurb", "agency_ps" }.`;

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
      commentary_post: commentary ? { title: commentary.title, body: commentary.body } : null,
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
    letter?: string;
    quick_hits?: string[];
    booking_headline?: string;
    booking_body?: string;
    fun_fact?: string;
    video_blurb?: string;
    affiliate_blurb?: string;
    agency_ps?: string;
  };

  const quickHits = (Array.isArray(parsed.quick_hits) ? parsed.quick_hits : [])
    .map((h) => String(h).trim())
    .filter(Boolean)
    .slice(0, 4);

  const draft: NewsletterDraft = {
    subject: (parsed.subject ?? (lang === "es" ? "Still Afloat Semanal" : "Still Afloat Weekly")).trim(),
    intro: "",
    // Belt & suspenders: the template adds "Hey <name>," itself, so strip any
    // greeting line the model opens with despite the prompt.
    letter: (parsed.letter ?? "").trim().replace(/^(hey|hi|hello|ahoy|hola|saludos)[^\n.!?]{0,40}[,!—–-]\s*\n*/i, ""),
    quickHits,
    booking: {
      headline: (parsed.booking_headline ?? (lang === "es" ? "¿Listo para tu próximo crucero?" : "Ready for your next cruise?")).trim(),
      body: (parsed.booking_body ?? (lang === "es"
        ? "Cuéntame tus fechas y tu presupuesto y yo busco la mejor opción — responde a este correo o toca el botón."
        : "Tell me your dates and budget and I'll hunt down the best option — reply to this email or hit the button.")).trim(),
    },
    storyIds: stories.map((s) => s.id),
    // Grounding snapshot (what the AI worked from) — kept for reference.
    stories,
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
    // The letter distills the commentary; the post link rides under it.
    draft.commentary = {
      id: commentary.id,
      title: commentary.title,
      excerpt: commentary.excerpt,
      url: utm(commentary.url, "commentary"),
      blurb: "",
    };
  }
  const funFact = (parsed.fun_fact ?? "").trim();
  if (funFact) draft.funFact = funFact;
  if (photo) draft.photo = photo;

  logger.info(
    {
      quickHits: draft.quickHits?.length ?? 0,
      hasLetter: !!draft.letter,
      hasBooking: !!draft.booking,
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

  // ── Mark's letter (his voice; the heart of the email) ──
  const letterText = (draft.letter ?? draft.intro ?? "").trim();
  const letterBlock = letterText
    ? `
    <p style="margin:0 0 6px;font-size:12px;color:#b8860b;font-weight:700;text-transform:uppercase;letter-spacing:.08em;">${t.fromMark}</p>
    <p style="margin:0 0 8px;color:#243b53;font-size:16px;line-height:1.75;">${t.hi(firstName)}</p>
    <p style="margin:0 0 8px;color:#243b53;font-size:16px;line-height:1.75;">${letterText.replace(/\n+/g, '</p><p style="margin:0 0 8px;color:#243b53;font-size:16px;line-height:1.75;">')}</p>
    <p style="margin:0 0 4px;color:#243b53;font-size:16px;font-weight:700;">${t.signoff}</p>
    ${draft.commentary ? `<p style="margin:0;font-size:13px;color:#64748b;font-style:italic;">(<a href="${draft.commentary.url}" style="color:#0077b6;">${t.fullTake}</a>)</p>` : ""}`
    : "";

  // ── Worth booking this week — THE call to action ──
  const bookingUrl = utm(`${baseUrl}${esPrefix}/work-with-mark.html#contact`, "booking");
  const bookingBlock = draft.booking
    ? `
    <div style="border:2px solid #f6b83c;border-radius:14px;padding:22px 24px;margin:26px 0 8px;background:#fffaf0;">
      <p style="margin:0 0 8px;font-size:13px;color:#b45309;font-weight:800;text-transform:uppercase;letter-spacing:.06em;">${t.worthBooking}</p>
      <h2 style="margin:0 0 10px;font-size:19px;color:#0c2035;line-height:1.35;font-weight:800;">${draft.booking.headline}</h2>
      <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.7;">${draft.booking.body}</p>
      <a href="${bookingUrl}" style="display:inline-block;background:#0077b6;color:#ffffff;padding:13px 26px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:800;">${t.bookingCta}</a>
    </div>`
    : "";

  // ── Quick hits: plain one-liners, deliberately link-free ──
  const hits = (draft.quickHits ?? []).filter(Boolean);
  const quickHitsBlock = hits.length
    ? `
    <div style="margin:22px 0 6px;">
      <p style="margin:0 0 10px;font-size:13px;color:#0077b6;font-weight:800;text-transform:uppercase;letter-spacing:.06em;">${t.quickHitsLabel}</p>
      ${hits.map((h) => `<p style="margin:0 0 8px;color:#374151;font-size:14px;line-height:1.65;">• &nbsp;${h}</p>`).join("")}
    </div>`
    : "";

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
<body style="font-family:Georgia,'Times New Roman',serif;background:#eaf4f9;padding:0;margin:0;">
  <div style="max-width:600px;margin:28px auto;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(7,24,63,.12);background:#fffdf8;">
    <div style="background:#fffdf8;padding:26px 32px 18px;text-align:center;">
      <img src="${SITE}/assets/images/still_afloat_transparent.png" alt="Still Afloat" width="210" style="display:block;width:210px;max-width:60%;height:auto;margin:0 auto 8px;"/>
      <p style="margin:0;color:#0c2035;font-size:13px;font-style:italic;">${t.tagline2}</p>
    </div>
    <div style="height:6px;background:linear-gradient(90deg,#0077b6,#5bc8f5,#f6b83c,#0077b6);"></div>
    <div style="background:#fffdf8;padding:26px 32px;">
      ${letterBlock}
      ${bookingBlock}
      ${quickHitsBlock}
      ${laughBlock}
      ${videoBlock}
      ${affiliateBlock}
      ${draft.agencyPs ? `<p style="margin:24px 0 0;color:#475569;font-size:14px;line-height:1.7;border-top:1px solid #ead9b8;padding-top:18px;"><strong>${t.ps}</strong> ${draft.agencyPs} <a href="${agencyUrl}" style="color:#0077b6;">${t.psCta}</a></p>` : ""}
    </div>
    <div style="background:#07183f;padding:18px 32px;text-align:center;">
      <p style="margin:0;color:#9fb3c8;font-size:12px;line-height:1.8;">
        Still Afloat · <em style="color:#5bc8f5;">${t.footTag}</em><br>
        <a href="${unsub}" style="color:#9fb3c8;font-size:11px;">${t.unsub}</a>
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
