import { logger } from "./logger";

// ─────────────────────────────────────────────────────────────────────────────
// Still Afloat social content engine.
//
// Turns one published video into a platform-native post batch following the
// two-track strategy:
//   Track A — Reach (Spanish): comedy-forward Shorts seeded via the Latino
//             network + algorithm. Goal = subscribers/awareness.
//   Track B — Value & convert (English): value-led posts for Mark's affluent
//             base on personal FB + newsletter + long-form. Goal = newsletter →
//             affiliate → travel-agency.
//
// Brand voice: "Cruise smarter, laugh more" / "Navega más inteligente. Ríe más."
// The LLM writes the copy; links + UTM tags are attached server-side so URLs are
// never hallucinated.
// ─────────────────────────────────────────────────────────────────────────────

export type Track = "A" | "B";
export type Platform = "facebook" | "instagram" | "youtube";
export type Lang = "en" | "es";
export type CtaType = "subscribe" | "newsletter" | "affiliate" | "agency";

export interface SocialVideo {
  id: string;
  title: string;
  lang: Lang;
  format?: "short" | "long";
}

interface Slot {
  platform: Platform;
  surface: string;
  ctaType: CtaType;
  linkInBio: boolean; // Instagram captions can't carry clickable links
}

export interface SocialPost extends Slot {
  track: Track;
  lang: Lang;
  caption: string;
  hashtags: string[];
  link: string;
  videoId: string;
  videoUrl: string;
}

export interface SocialBatch {
  videoId: string;
  title: string;
  track: Track;
  lang: Lang;
  generatedAt: string;
  posts: SocialPost[];
}

const SITE = "https://stillafloatcruising.com";

function ctaDestination(cta: CtaType, lang: Lang): string {
  switch (cta) {
    case "subscribe":
    case "newsletter":
      return lang === "es" ? `${SITE}/es/` : `${SITE}/`;
    case "affiliate":
      return `${SITE}/affiliate.html`;
    case "agency":
      return `${SITE}/#contact`;
    default:
      return `${SITE}/`;
  }
}

function slugify(s: string): string {
  // ASCII-only campaign slug; non-ascii (accents, emoji) collapse to dashes.
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
}

export function buildUtm(
  base: string,
  p: { source: string; medium: string; campaign: string; content: string },
): string {
  // Preserve any existing hash (e.g. #contact) while adding query params.
  const hashIdx = base.indexOf("#");
  const hash = hashIdx >= 0 ? base.slice(hashIdx) : "";
  const noHash = hashIdx >= 0 ? base.slice(0, hashIdx) : base;
  const sep = noHash.includes("?") ? "&" : "?";
  const qs = new URLSearchParams({
    utm_source: p.source,
    utm_medium: p.medium,
    utm_campaign: p.campaign,
    utm_content: p.content,
  }).toString();
  return `${noHash}${sep}${qs}${hash}`;
}

// The fixed post plan per track. The LLM fills caption/hashtags for each slot.
function planSlots(track: Track): Slot[] {
  if (track === "A") {
    return [
      { platform: "youtube", surface: "YouTube Short", ctaType: "subscribe", linkInBio: false },
      { platform: "instagram", surface: "Instagram Reel", ctaType: "subscribe", linkInBio: true },
      { platform: "facebook", surface: "Facebook Page", ctaType: "subscribe", linkInBio: false },
    ];
  }
  // Track B
  return [
    { platform: "facebook", surface: "Personal Facebook", ctaType: "newsletter", linkInBio: false },
    { platform: "facebook", surface: "Personal Facebook", ctaType: "agency", linkInBio: false },
    { platform: "instagram", surface: "Instagram", ctaType: "affiliate", linkInBio: true },
  ];
}

function mediumFor(platform: Platform, surface: string): string {
  if (platform === "instagram") return surface.toLowerCase().includes("reel") ? "reel" : "ig";
  if (platform === "youtube") return "short";
  return "fb";
}

const SYSTEM_PROMPT = `You are the social media copywriter for "Still Afloat," a cruise & travel brand.

Brand premise / north star: "Cruise smarter, laugh more." Humor is core to the brand, not a garnish — content is light-hearted and relatable, NOT cautionary "learn from my mistakes" warnings. The host has 40 years of cruising experience (credibility) and a warm, funny, real voice.

Two audiences / tracks:
- Track A (Spanish, "Navega más inteligente. Ríe más."): the Latino audience, reached via Shorts + a warm Facebook network. Goal = grow subscribers. Comedy-forward, punchy, scroll-stopping. Write in natural Latin American Spanish (es-419). Keep cruise line / ship / port names in their original language.
- Track B (English): the host's own base — middle-aged, affluent cruisers who respond to VALUE and credibility, not gags. Lead with a useful, smart insight ("cruise smarter"), seasoned with light humor. These are the buyers (premium gear + travel-agency clients).

Caption rules:
- Each caption: 1–3 short sentences, native to its platform, with tasteful emoji.
- A strong 1-line hook first (especially for Shorts/Reels).
- End with a natural call-to-action that matches the provided cta_type:
  - subscribe → invite to follow/subscribe for more
  - newsletter → invite to join the free weekly cruise email
  - affiliate → mention the gear is worth it (the link is provided separately)
  - agency → soft, personal ("I book cruises professionally now — planning one? reply/DM")
- For Instagram (link_in_bio = true), do NOT put a URL in the caption — say "link in bio" (or "enlace en la bio" for Spanish).
- For Facebook/YouTube, do NOT write the URL yourself; the system appends it. Just write the CTA sentence.
- hashtags: 3–6 relevant, lowercase, no spaces (Spanish hashtags for Track A). Empty array for Personal Facebook posts.

Respond ONLY with a JSON object: { "posts": [ { "idx": <int>, "caption": "<string>", "hashtags": ["..."] } ] } with one element per requested slot, idx matching the input.`;

interface LlmPost {
  idx: number;
  caption: string;
  hashtags?: string[];
}

export async function generateSocialBatch(
  video: SocialVideo,
  track: Track,
): Promise<SocialBatch> {
  const apiKey = process.env["OPENAI_API_KEY"] || process.env["REPLIT_OPENAI_API_KEY"] || "";
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const lang: Lang = track === "A" ? "es" : "en";
  const slots = planSlots(track);
  const campaign = `${track === "A" ? "reach" : "value"}-${slugify(video.title)}`;
  const videoUrl = `https://youtu.be/${video.id}`;

  const slotPrompt = slots.map((s, i) => ({
    idx: i,
    surface: s.surface,
    platform: s.platform,
    cta_type: s.ctaType,
    link_in_bio: s.linkInBio,
  }));

  const userContent =
    `Video: "${video.title}" (${video.format ?? "video"}, language ${video.lang}).\n` +
    `Track ${track} (${lang === "es" ? "Spanish reach" : "English value/convert"}).\n` +
    `Write one post per slot below. Return JSON {"posts":[{idx,caption,hashtags}]}.\n\n` +
    JSON.stringify(slotPrompt, null, 2);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.85,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = (await response.json()) as any;
  const content: string = payload?.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("Empty response from OpenAI");

  const parsed = JSON.parse(content) as { posts?: LlmPost[] };
  const llmPosts = Array.isArray(parsed.posts) ? parsed.posts : [];

  const posts: SocialPost[] = slots.map((slot, i) => {
    const gen = llmPosts.find((p) => p.idx === i);
    const dest = ctaDestination(slot.ctaType, lang);
    const link = buildUtm(dest, {
      source: slot.platform,
      medium: mediumFor(slot.platform, slot.surface),
      campaign,
      content: slot.ctaType,
    });
    const hashtags = gen && Array.isArray(gen.hashtags) ? gen.hashtags.slice(0, 6) : [];
    return {
      ...slot,
      track,
      lang,
      caption: gen?.caption?.trim() ?? "",
      hashtags,
      link,
      videoId: video.id,
      videoUrl,
    };
  });

  logger.info({ videoId: video.id, track, count: posts.length }, "Generated social batch");

  return {
    videoId: video.id,
    title: video.title,
    track,
    lang,
    generatedAt: new Date().toISOString(),
    posts,
  };
}
