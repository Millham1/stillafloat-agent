import { logger } from "./logger";
import { sendMail } from "./mailer";
import { readJson, writeJson, PATHS, getSupabase } from "./persistence";
import { buildUtm, fetchChannelVideos, type Lang } from "./social-agent";
import { storySlug } from "./prerender-news";
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
    worthBooking: "Worth a look this week",
    bookingCta: "Have Mark check your dates →",
    quickHitsLabel: "Cruise report",
    quickHitsTitle: "What's happening out there",
    sunnyLabel: "Laugh more",
    sunnyTitle: "The Sunny Side",
    pps: "P.P.S.",
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
    worthBooking: "Vale la pena mirar esta semana",
    bookingCta: "Que Mark revise tus fechas →",
    quickHitsLabel: "Reporte crucero",
    quickHitsTitle: "Qué está pasando allá afuera",
    sunnyLabel: "Ríe más",
    sunnyTitle: "El Lado Soleado",
    pps: "P.P.D.",
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
  // Mark's opening letter. letterTitle is a punchy headline in HIS register
  // (his own example: "And the winner of the Darwin Award for Cruisers is……");
  // the letter paraphrases his commentary TRUE TO ITS INTENT — never softened.
  letterTitle?: string;
  letter?: string;
  quickHits?: Array<{ text: string; url?: string }>; // one-liners; headline links to the site's story page
  booking?: { headline: string; body: string }; // the booking CTA centerpiece
  storyIds: string[];
  // Snapshot of the stories the AI worked from (grounding/reference; the new
  // template renders quickHits, not story cards).
  stories?: Story[];
  commentary?: { id: string; title: string; excerpt: string; url: string; blurb: string };
  // "Laugh more" is a STYLE, not a joke repository (Mark, 2026-07-09): the
  // Sunny Side is a warm passage about enjoying cruise life; any humor rides
  // inside the writing. A groaner survives only as an optional playful P.P.S.
  sunnySide?: string;
  pps?: string;
  photoCaption?: string;
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

// Only offer stories fresh enough to still be news at send time (Mark,
// 2026-08-29: "it's useless to send a storm story if the storm has already
// dissipated" — the pool held 119 approved stories, 3 of them under 48h).
// A story with no parseable timestamp is treated as stale, never grandfathered.
const STORY_MAX_AGE_HOURS = Number(process.env["NEWSLETTER_STORY_MAX_AGE_HOURS"] ?? "48");

async function gatherApprovedStories(lang: Lang = "en"): Promise<Story[]> {
  const data = await readJson<{ stories?: Record<string, unknown>[] }>(PATHS.approved, { stories: [] });
  const cutoff = Date.now() - STORY_MAX_AGE_HOURS * 3_600_000;
  return (data.stories ?? []).filter((s) => {
    const ts = Date.parse(String(s["publishedAt"] ?? s["approvedAt"] ?? ""));
    return Number.isFinite(ts) && ts >= cutoff;
  }).map((s) => ({
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

// Spanish-title heuristic: accented/inverted characters are a reliable tell on
// this channel (EN titles don't use them; the ES localizations always do —
// that's also how the site routes them to /es/).
const SPANISH_TITLE = /[¡¿áéíóúñÁÉÍÓÚÑ]/;

async function gatherFeaturedVideo(lang: Lang): Promise<{ id: string; title: string; thumbnail: string } | null> {
  // Prefer the manually featured video; else the latest upload IN THIS
  // EDITION'S LANGUAGE (the 2026-07-09 EN issue featured the Spanish site-tour
  // video because "latest upload" was language-blind).
  const ch = await readJson<{ featuredId?: string; videos?: Array<Record<string, unknown>> }>(
    "youtube-channel",
    {},
  );
  const vids = ch.videos ?? [];
  if (ch.featuredId) {
    const v = vids.find((x) => String(x["id"]) === ch.featuredId);
    if (v) return { id: ch.featuredId, title: String(v["title"] ?? ""), thumbnail: String(v["thumbnail"] ?? "") };
  }
  const langMatch = (title: string): boolean =>
    lang === "es" ? SPANISH_TITLE.test(title) : !SPANISH_TITLE.test(title);
  const pickFrom = (list: Array<{ id: string; title: string; thumbnail: string }>): { id: string; title: string; thumbnail: string } | null =>
    list.find((v) => v.id && langMatch(v.title)) ?? list[0] ?? null;

  const stored = vids.map((v) => ({
    id: String(v["id"] ?? ""),
    title: String(v["title"] ?? ""),
    thumbnail: String(v["thumbnail"] ?? ""),
  }));
  const fromStore = pickFrom(stored);
  if (fromStore) return fromStore;
  try {
    const latest = await fetchChannelVideos(5);
    return pickFrom(latest.map((v) => ({ id: v.id, title: v.title, thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` })));
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

WHO MARK IS: retired senior IT manager, veteran, lived aboard his own sailboat for about 12 years, 20+ years of cruising, now a travel advisor who books cruises for people. Tagline: "Cruise smarter. Laugh more. Stay Afloat."

VOICE — the experienced friend on the next barstool: first person singular ("I", never "we"), contractions, plainspoken, warm, wry. Humor is seasoning; useful information is the meal. Reads like Mark talking, not a brand campaign.

BANNED (instant rewrite if you catch yourself): "navigating", "dive into/diving into", "explore the world of", "journey" as filler, "elevate", "unlock", "thrilling", "exciting", "well-informed", "stay tuned", "in the world of cruising", "adventure awaits", "stark reminder", "remain vigilant", "raises serious concerns", "shocking and sobering", "safety should always be a priority", subject lines shaped like "Verb-ing the X and Y of Z", empty superlatives, clickbait, exclamation-point enthusiasm, ALL CAPS.
THE MARKETING TEST: if a sentence could appear in a cruise line's promo email, rewrite it. This email IS marketing, but it must never FEEL like marketing — it feels like a letter from a friend who happens to book cruises.
NEVER invent personal anecdotes, trips, or experiences for Mark. If his commentary is provided, his words are the raw material; keep his phrases where you can.
LANGUAGE: everything you write is in English. If a provided story or video title is in Spanish, translate the substance or skip it — never let Spanish text leak into the issue.
TIME AWARENESS: you are given today's date. Never pitch a deal, sale, or event whose date has passed or is about to (a "July 4th sale" is dead on July 9). If you can't tell whether a promo is still live, pick a different angle.

THE POINT OF THIS EMAIL: the reader should finish it feeling like cruising is fun and smart people book through Mark. It exists to drive BOOKINGS (replies and clicks to his booking page) — NOT to drive clicks to news stories.

TONE ON NEWS: the reader gets doom headlines everywhere else. Pick what a traveler can USE (deals, changes that affect planning, good news). At most ONE cautionary item, and only if travelers truly need it — deliver it in one calm line, never as a scare.

You will receive this week's stories, possibly Mark's latest commentary, a featured video, one affiliate product, and a description of this week's photo. Produce:
- subject: <= 60 chars, sounds like a text from a friend — specific, human, a little fun. (Good shape: "A 50% sale, a $26 water bottle, and my two cents".)
- letter_title: HARVEST the headline from the commentary itself — find its sharpest line or funniest image and escalate it into the marquee. Worked example: the commentary lands the line "some folks seem bound and determined to prove Darwin was right" → Mark's title: "And the winner of the Darwin Award for Cruisers is……" (his own punchline, promoted to an award ceremony — a callback that assumes the reader is in on the joke). Never a summary, never a fresh joke unrelated to the piece, never a scary line.
- letter: Mark's opening letter, 3–5 sentences, paraphrasing his commentary TRUE TO ITS INTENT. PARAPHRASE MEANS RE-TELL: write fresh, compressed sentences in his voice — never stitch sentences copied from the commentary. At most ONE short phrase may survive verbatim, and it must be one of his vivid, funny, or personal lines (a first-person aside beats an advisory sentence every time) — never generic filler. ORDER: open with his TAKE — the lesson, the point, the wry observation — and touch the triggering news in one light clause; NEVER open with incident detail. Graphic or criminal specifics are banned from the letter entirely: point at the story ("the ugly story out of Alaska"), don't describe it. STANCE GUARD: the letter must NEVER contradict a position the commentary takes — if he argues for lifetime bans, the letter is for lifetime bans; when compressing, drop an argument rather than reverse it. STAY IN YOUR LANE: no deals, sales, or booking angles inside the letter — the booking section handles those. Do NOT begin with a greeting — the email inserts "Hey <first name>," automatically. Do NOT write a news-roundup frame. End with one easy, low-key sentence that turns the reader toward planning. No commentary provided → write about the season, warm and wry, without inventing personal stories. EMOTIONAL CONCLUSION: identify the note the commentary lands on (reassure, mock, celebrate, warn) and make the letter land on the SAME note — compression tends to keep the warnings and kill the mood; protect the mood. The reader should leave feeling what the commentary's reader feels, not just knowing what they know. Final test: read it aloud — if it doesn't sound like Mark summarizing his own piece to a friend, rewrite it.
- quick_hits: 2–4 items from the provided stories, each { "text": one-liner <= 22 words, plain and useful, no hype, "story_id": the id of the story it came from }. The text becomes a link to that story on Mark's site, so it must match its story. If NO stories are provided (a quiet news week), return an empty array — NEVER invent news or reach for anything not in the provided stories.
- booking_headline: <= 8 words naming this week's most bookable angle from the stories (a sale, a season, a destination) — or, if nothing qualifies, an evergreen angle (e.g. off-season pricing). Plain and specific, sentence case, no exclamation marks.
- booking_body: 2–3 sentences the way a friend passes along a tip over a beer — why it's worth a look, no sales-speak, no exclamation points — ending with the low-key offer: Mark can check it against the reader's dates (reply or hit the button).
- sunny_side: 2–4 sentences for "The Sunny Side" — the LAUGH MORE spirit: life, fun, the small pleasures of cruising. Anchor it in the most enjoyable thing in this week's material (a feel-good story, a season, the simple joy of a sea day). Written warm and a little playful — the humor lives IN the writing, never as a stand-alone joke. You may fold in ONE real, widely documented fun fact if it fits naturally (never invent numbers or records). No invented Mark anecdotes.
- photo_caption: one wry line captioning this week's photo (its description is provided) — observational, not salesy.
- pps: OPTIONAL one-line playful sign-off for a P.P.S. — a light pun or wink is fine here (this is the only place a joke may stand alone). Empty string if nothing lands.
- video_blurb: one inviting, honest sentence about the featured video.
- affiliate_blurb: one candid sentence on why the product earns its place in a suitcase.
- agency_ps: one soft, personal P.S. offering booking help.

Respond ONLY with JSON: { "subject", "letter_title", "letter", "quick_hits":[{"text","story_id"}], "booking_headline", "booking_body", "sunny_side", "photo_caption", "pps", "video_blurb", "affiliate_blurb", "agency_ps" }.`;

const SYSTEM_PROMPT_ES = `Escribes "Still Afloat Semanal" COMO Mark Millham — este correo es una carta de Mark a sus amigos, nunca un boletín corporativo. Español latinoamericano neutro (es-419).

QUIÉN ES MARK: gerente senior de TI retirado, veterano, vivió unos 12 años a bordo de su propio velero, 20+ años tomando cruceros, hoy asesor de viajes que reserva cruceros para la gente. Lema: "Navega más inteligente. Ríe más."

VOZ — el amigo con experiencia en la barra de al lado: primera persona singular ("yo", nunca "nosotros"), cercano, directo, cálido, con humor seco. El humor es el condimento; la información útil es el plato. Mantén nombres propios en su idioma original (líneas, barcos, puertos, "Amazon").

PROHIBIDO (reescribe si te descubres): "navegando por", "sumérgete", "explora el mundo de", "eleva", "emocionante", "no te lo pierdas", "mantente informado", asuntos con forma "Verbo-ando lo X y lo Y de Z", superlativos vacíos, clickbait, entusiasmo con signos de exclamación, MAYÚSCULAS.
LA PRUEBA DE MARKETING: si una frase podría aparecer en el correo promocional de una naviera, reescríbela. Este correo ES marketing, pero nunca debe SENTIRSE como marketing — se siente como la carta de un amigo que además reserva cruceros.
NUNCA inventes anécdotas, viajes ni experiencias personales de Mark. Si se provee su commentary, sus palabras son la materia prima.
CONCIENCIA DEL TIEMPO: recibirás la fecha de hoy. Nunca promociones una oferta o evento cuya fecha ya pasó o está por pasar. Si no sabes si una promo sigue viva, elige otro ángulo.

EL OBJETIVO DEL CORREO: que el lector termine sintiendo que crucerear es divertido y que la gente lista reserva con Mark. Existe para generar RESERVAS (respuestas y clics a su página de reservas) — NO para llevar tráfico a noticias.

TONO CON LAS NOTICIAS: el lector ya recibe titulares negativos en todas partes. Elige lo que un viajero puede USAR (ofertas, cambios que afectan la planificación, buenas noticias). Máximo UNA nota de precaución, solo si es realmente necesaria, en una línea tranquila.

Recibirás las noticias de la semana, posiblemente el commentary más reciente de Mark, un video destacado, un producto de afiliado y la descripción de la foto de la semana. Produce, TODO en español:
- subject: <= 60 caracteres, suena a mensaje de un amigo — específico, humano, con gracia.
- letter_title: COSECHA el titular del propio commentary — encuentra su línea más aguda o su imagen más graciosa y escálala a marquesina. Ejemplo real: el commentary remata con "algunas personas parecen decididas a demostrar que Darwin tenía razón" → el título de Mark: "Y el ganador del Premio Darwin de los cruceristas es……" (su propio remate, ascendido a ceremonia de premios). Nunca un resumen, nunca un chiste ajeno a la pieza, nunca una línea que asuste.
- letter: la carta de apertura de Mark, 3–5 frases, parafraseando su commentary FIEL A SU INTENCIÓN. PARAFRASEAR ES RECONTAR: frases nuevas y comprimidas en su voz — nunca coser frases copiadas del commentary. Como máximo UNA frase corta puede sobrevivir textual, y debe ser una de sus líneas vívidas, graciosas o personales — nunca relleno de advertencia. ORDEN: abre con SU CONCLUSIÓN — la lección, el punto, la observación irónica — y toca la noticia en una cláusula ligera; NUNCA abras con el detalle del incidente. Los detalles gráficos o criminales quedan prohibidos en la carta: señala la historia, no la describas. GUARDIA DE POSTURA: la carta NUNCA contradice una posición que el commentary toma — si él defiende los baneos de por vida, la carta también; al comprimir, elimina un argumento antes que invertirlo. EN TU CARRIL: nada de ofertas ni ángulos de reserva dentro de la carta — la sección de reservas se encarga. NO empieces con un saludo. NO hagas un resumen noticioso. Cierra con una frase fácil que lleve al lector hacia planear. Sin commentary → escribe de la temporada, cálido e irónico, sin inventar historias personales. CONCLUSIÓN EMOCIONAL: identifica la nota en la que aterriza el commentary (tranquilizar, burlarse, celebrar, advertir) y haz que la carta aterrice en la MISMA nota — la compresión suele conservar las advertencias y matar el ánimo; protege el ánimo. Prueba final: léela en voz alta — si no suena a Mark resumiéndole su propia pieza a un amigo, reescríbela.
- quick_hits: 2–4 items de las noticias provistas, cada uno { "text": una línea <= 22 palabras, útil y sin exageración, "story_id": el id de la noticia }. El texto será un enlace a esa historia en el sitio de Mark, así que debe corresponderle.
- booking_headline: <= 8 palabras con el ángulo más reservable de la semana (una oferta, una temporada, un destino) — o un ángulo permanente si nada califica. Directo y específico, sin signos de exclamación.
- booking_body: 2–3 frases como un amigo que pasa un dato tomando algo — por qué vale la pena, sin lenguaje de ventas, sin exclamaciones — cerrando con la oferta tranquila: Mark puede revisarlo contra tus fechas (responde o toca el botón).
- sunny_side: 2–4 frases para "El Lado Soleado" — el espíritu de RÍE MÁS: la vida, la diversión, los pequeños placeres de crucerear. Ánclalo en lo más disfrutable del material de la semana (una historia amable, una temporada, el gusto simple de un día de mar). Cálido y juguetón — el humor vive DENTRO de la escritura, nunca como chiste suelto. Puedes integrar UN dato curioso real y ampliamente documentado si cabe con naturalidad (nunca inventes cifras). Sin anécdotas inventadas de Mark.
- photo_caption: una línea irónica/observacional para la foto de la semana (se provee su descripción) — nada de ventas.
- pps: OPCIONAL una línea juguetona para una P.P.D. — aquí sí puede vivir un juego de palabras solo. Cadena vacía si nada funciona.
- video_blurb: una frase honesta e invitadora sobre el video.
- affiliate_blurb: una frase sincera de por qué el producto se gana su lugar en la maleta.
- agency_ps: una posdata breve y personal ofreciendo ayuda para reservar.

Responde SOLO con JSON: { "subject", "letter_title", "letter", "quick_hits":[{"text","story_id"}], "booking_headline", "booking_body", "sunny_side", "photo_caption", "pps", "video_blurb", "affiliate_blurb", "agency_ps" }.`;

export async function draftNewsletter(lang: Lang = "en"): Promise<NewsletterDraft> {
  const apiKey = process.env["OPENAI_API_KEY"] || "";
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const [stories, video, affiliate, commentary, photo] = await Promise.all([
    gatherApprovedStories(lang),
    gatherFeaturedVideo(lang),
    gatherFeaturedAffiliate(),
    gatherLatestCommentary(lang),
    fetchCruisePhoto(),
  ]);
  // A quiet news week is not a blocker: the letter, commentary, video, and gear
  // sections still make a full issue — quick hits simply drop out. Padding the
  // email with stale stories is worse than a shorter email (Mark, 2026-08-29).

  const userContent = JSON.stringify(
    {
      today: new Date().toDateString(),
      stories: stories.map((s) => ({ id: s.id, title: s.title, summary: s.summary, impact: s.impact })),
      commentary_post: commentary ? { title: commentary.title, body: commentary.body } : null,
      featured_video: video ? { title: video.title } : null,
      affiliate_product: affiliate ? { title: affiliate.title, description: affiliate.description } : null,
      this_weeks_photo: photo ? { description: photo.alt } : null,
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
    letter_title?: string;
    letter?: string;
    quick_hits?: Array<{ text?: string; story_id?: string } | string>;
    booking_headline?: string;
    booking_body?: string;
    sunny_side?: string;
    photo_caption?: string;
    pps?: string;
    video_blurb?: string;
    affiliate_blurb?: string;
    agency_ps?: string;
  };

  // Each hit links to the story's pre-rendered page on the site (Mark: a
  // related headline should hyperlink to the story). Unknown ids → no link.
  const esNewsPrefix = lang === "es" ? "/es/news/" : "/news/";
  const storyById = new Map(stories.map((s) => [s.id, s]));
  const quickHits = (Array.isArray(parsed.quick_hits) ? parsed.quick_hits : [])
    .map((h) => {
      if (typeof h === "string") return { text: h.trim() };
      const text = String(h.text ?? "").trim();
      const id = String(h.story_id ?? "").trim();
      const hit: { text: string; url?: string } = { text };
      if (id && storyById.has(id)) hit.url = `${SITE}${esNewsPrefix}${storySlug({ id })}.html`;
      return hit;
    })
    .filter((h) => h.text)
    .slice(0, 4);

  const draft: NewsletterDraft = {
    subject: (parsed.subject ?? (lang === "es" ? "Still Afloat Semanal" : "Still Afloat Weekly")).trim(),
    intro: "",
    letterTitle: (parsed.letter_title ?? "").trim(),
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
  const sunnySide = (parsed.sunny_side ?? "").trim();
  if (sunnySide) draft.sunnySide = sunnySide;
  const pps = (parsed.pps ?? "").trim();
  if (pps) draft.pps = pps;
  if (photo) {
    draft.photo = photo;
    const caption = (parsed.photo_caption ?? "").trim();
    if (caption) draft.photoCaption = caption;
  }

  logger.info(
    {
      quickHits: draft.quickHits?.length ?? 0,
      hasLetter: !!draft.letter,
      hasBooking: !!draft.booking,
      hasVideo: !!draft.video,
      hasAffiliate: !!draft.affiliate,
      hasCommentary: !!draft.commentary,
      hasSunnySide: !!draft.sunnySide,
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

  // ── Site style tokens (mirrors stillafloatcruising.com) ──
  const FONT_BODY = "'Baloo 2','Trebuchet MS',Verdana,sans-serif";
  const FONT_HEAD = "'Bree Serif',Georgia,serif";
  const pill = (text: string, fg: string, bg: string): string =>
    `<span style="display:inline-block;background:${bg};color:${fg};border-radius:999px;padding:4px 14px;font-family:${FONT_BODY};font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.10em;">${text}</span>`;
  const BEACH_BG = `${SITE}/assets/images/Tropical%20beach%20with%20palm%20trees%20and%20ship.png`;
  const TROPICAL_BG = `${SITE}/assets/images/news-tropical-bg.png`;
  const CRAB = `${SITE}/assets/images/crab-mascot.png`;

  // ── Band 1 — hero: Mark's letter as a frosted panel on the beach photo,
  //    headlined in HIS register (site's hero → frosted-panel pattern) ──
  const letterText = (draft.letter ?? draft.intro ?? "").trim();
  const letterPara = (s: string): string => `<p style="margin:0 0 10px;color:#1e3a5f;font-family:${FONT_BODY};font-size:16px;line-height:1.75;">${s}</p>`;
  const letterBlock = letterText
    ? `
    <div style="background:#9cc8de url('${BEACH_BG}') center/cover no-repeat;padding:24px 20px;">
      <div style="background:rgba(255,253,248,.93);border-radius:16px;padding:22px 26px;">
        <p style="margin:0 0 12px;">${pill(t.fromMark, "#5dff9a", "rgba(7,24,63,.88)")}</p>
        ${draft.letterTitle ? `<h2 style="margin:0 0 12px;font-family:${FONT_HEAD};font-size:23px;color:#0c2035;line-height:1.3;font-weight:400;">${draft.letterTitle}</h2>` : ""}
        ${letterPara(t.hi(firstName))}
        ${letterText.split(/\n+/).map(letterPara).join("")}
        <p style="margin:0 0 4px;color:#1e3a5f;font-family:${FONT_HEAD};font-size:17px;">${t.signoff}</p>
        ${draft.commentary ? `<p style="margin:0;font-family:${FONT_BODY};font-size:13px;color:#64748b;font-style:italic;">(<a href="${draft.commentary.url}" style="color:#0077b6;">${t.fullTake}</a>)</p>` : ""}
      </div>
    </div>`
    : "";

  // ── Band 2 — deep-water navy (site's midsection): booking tip + cruise
  //    report share one band, green/gold accents on navy ──
  const bookingUrl = utm(`${baseUrl}${esPrefix}/work-with-mark.html#contact`, "booking");
  const bookingPart = draft.booking
    ? `
      <p style="margin:0 0 10px;">${pill(t.worthBooking, "#07183f", "#ffd21f")}</p>
      <h3 style="margin:0 0 8px;font-family:${FONT_HEAD};font-size:21px;color:#ffffff;line-height:1.35;font-weight:400;">${draft.booking.headline}</h3>
      <p style="margin:0 0 16px;color:#cfe3ee;font-family:${FONT_BODY};font-size:15px;line-height:1.7;">${draft.booking.body}</p>
      <a href="${bookingUrl}" style="display:inline-block;background:#5dff9a;color:#07183f;padding:12px 24px;border-radius:999px;text-decoration:none;font-family:${FONT_BODY};font-size:14px;font-weight:800;">${t.bookingCta}</a>`
    : "";
  const hits = (draft.quickHits ?? []).filter((h) => h && h.text);
  const hitsPart = hits.length
    ? `
      <div style="border-top:1px solid rgba(255,255,255,.18);margin:24px 0 0;padding:22px 0 0;">
        <p style="margin:0 0 8px;">${pill(t.quickHitsLabel, "#0077b6", "#ddeeff")}</p>
        <h3 style="margin:0 0 12px;font-family:${FONT_HEAD};font-size:19px;color:#ffffff;font-weight:400;">${t.quickHitsTitle}</h3>
        ${hits.map((h) => `<p style="margin:0 0 10px;color:#cfe3ee;font-family:${FONT_BODY};font-size:14px;line-height:1.65;">•&nbsp; ${h.url ? `<a href="${utm(h.url, "story")}" style="color:#8fd8ff;text-decoration:underline;">${h.text}</a>` : h.text}</p>`).join("")}
      </div>`
    : "";
  const navyBand = bookingPart || hitsPart
    ? `
    <div style="background:#0a2a5e;background:linear-gradient(180deg,#0d3a74 0%,#04112e 100%);padding:26px 26px 28px;">
      ${bookingPart}
      ${hitsPart}
    </div>`
    : "";

  // ── Band 4 — light band: video + gear + P.S., calm close ──
  const videoPart = draft.video
    ? `
    <div style="background:#ffffff;border:1px solid #e8e2d4;border-radius:16px;overflow:hidden;margin:0 0 16px;">
      <a href="${draft.video.url}" style="text-decoration:none;">
        ${draft.video.thumbnail ? `<img src="${draft.video.thumbnail}" alt="" style="display:block;width:100%;max-width:600px;"/>` : ""}
        <div style="padding:14px 22px 16px;">
          <p style="margin:0 0 8px;">${pill(t.watch, "#ffffff", "#0077b6")}</p>
          <h3 style="margin:0 0 6px;font-family:${FONT_HEAD};font-size:17px;color:#0c2035;font-weight:400;">${draft.video.title}</h3>
          ${draft.video.blurb ? `<p style="margin:0;color:#374151;font-family:${FONT_BODY};font-size:14px;line-height:1.6;">${draft.video.blurb}</p>` : ""}
        </div>
      </a>
    </div>`
    : "";

  const affiliatePart = draft.affiliate
    ? `
    <div style="background:#ffffff;border:1px solid #e8e2d4;border-radius:16px;padding:16px 22px;margin:0 0 16px;">
      <p style="margin:0 0 8px;">${pill(t.gear, "#0e7490", "#d9f2f7")}</p>
      <h3 style="margin:0 0 6px;font-family:${FONT_HEAD};font-size:17px;color:#0c2035;font-weight:400;">${draft.affiliate.title}</h3>
      ${draft.affiliate.blurb ? `<p style="margin:0 0 12px;color:#374151;font-family:${FONT_BODY};font-size:14px;line-height:1.6;">${draft.affiliate.blurb}</p>` : ""}
      <a href="${draft.affiliate.link}" style="display:inline-block;background:#0e7490;color:#fff;padding:9px 20px;border-radius:999px;text-decoration:none;font-family:${FONT_BODY};font-size:13px;font-weight:700;">${t.gearCta}</a>
      <p style="margin:8px 0 0;color:#9ca3af;font-family:${FONT_BODY};font-size:11px;">${t.affNote}</p>
    </div>`
    : "";

  // ── Band 3 — The Sunny Side: bright band, the week's photo, warm writing.
  //    No pill here (Mark: the pill made no sense) — the crab and the title
  //    carry the playfulness. ──
  const laughBlock = draft.sunnySide || draft.photo
    ? `
    <div style="background:#bfe4f7 url('${TROPICAL_BG}') center/cover no-repeat;padding:24px 20px;">
      <div style="background:rgba(255,255,255,.94);border-radius:16px;overflow:hidden;">
        ${draft.photo ? `<img src="${draft.photo.url}" alt="${escapeAttr(draft.photo.alt)}" style="display:block;width:100%;max-width:600px;"/>` : ""}
        <div style="padding:16px 26px 20px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 6px;"><tr>
            <td style="vertical-align:middle;"><h3 style="margin:0;font-family:${FONT_HEAD};font-size:21px;color:#0c2035;font-weight:400;">☀️ ${t.sunnyTitle}</h3></td>
            <td style="vertical-align:middle;text-align:right;"><img src="${CRAB}" alt="" width="40" style="display:inline-block;width:40px;height:auto;"/></td>
          </tr></table>
          ${draft.photoCaption ? `<p style="margin:0 0 12px;color:#64748b;font-family:${FONT_BODY};font-size:13px;line-height:1.6;font-style:italic;">${draft.photoCaption}</p>` : ""}
          ${draft.sunnySide ? `<p style="margin:0;color:#374151;font-family:${FONT_BODY};font-size:15px;line-height:1.75;">${draft.sunnySide}</p>` : ""}
          ${draft.photo && draft.photo.photographer ? `<p style="margin:12px 0 0;color:#b8ad93;font-family:${FONT_BODY};font-size:11px;">${t.photoBy}: <a href="${draft.photo.photographerUrl || "https://www.pexels.com"}" style="color:#b8ad93;">${draft.photo.photographer}</a> / Pexels</p>` : ""}
        </div>
      </div>
    </div>`
    : "";

  const agencyUrl = utm(`${baseUrl}${esPrefix}/work-with-mark.html#contact`, "agency");

  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Bree+Serif&family=Baloo+2:wght@400;600;700;800&display=swap" rel="stylesheet">
</head>
<body style="font-family:${FONT_BODY};background:#04112e;padding:0;margin:0;">
  <div style="max-width:600px;margin:0 auto;background:#04112e;">
    <img src="${SITE}/assets/images/Youtube%20banner%20cropped.png" alt="Still Afloat — ${t.tagline2}" style="display:block;width:100%;height:auto;"/>
    <div style="height:5px;background:linear-gradient(90deg,#0077b6,#5bc8f5,#ffd21f,#0077b6);"></div>
    ${letterBlock}
    ${navyBand}
    ${laughBlock}
    <div style="background:#fffdf8;padding:22px 20px 8px;">
      ${videoPart}
      ${affiliatePart}
      ${draft.agencyPs || draft.pps ? `<div style="padding:2px 4px 16px;">
        ${draft.agencyPs ? `<p style="margin:0;color:#475569;font-family:${FONT_BODY};font-size:14px;line-height:1.7;"><strong>${t.ps}</strong> ${draft.agencyPs} <a href="${agencyUrl}" style="color:#0077b6;">${t.psCta}</a></p>` : ""}
        ${draft.pps ? `<p style="margin:${draft.agencyPs ? "10px" : "0"} 0 0;color:#64748b;font-family:${FONT_BODY};font-size:13px;line-height:1.6;font-style:italic;"><strong>${t.pps}</strong> ${draft.pps}</p>` : ""}
      </div>` : ""}
    </div>
    <div style="background:#07183f;padding:20px 32px;text-align:center;">
      <p style="margin:0;color:#9fb3c8;font-family:${FONT_BODY};font-size:12px;line-height:1.8;">
        Still Afloat · <em style="color:#5dff9a;">${t.footTag}</em><br>
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

// How many confirmed subscribers an edition has — the weekly scheduler drafts
// an edition only when someone will actually receive it (ES self-activates on
// its first confirmed subscriber; Mark 2026-08-29: ES is first-class).
export async function confirmedSubscriberCount(lang: Lang): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from("subscribers")
    .select("email", { count: "exact", head: true })
    .eq("status", "confirmed")
    .eq("lang", lang);
  if (error) throw new Error("Failed to count subscribers");
  return count ?? 0;
}

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
