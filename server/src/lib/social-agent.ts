import crypto from "node:crypto";
import { logger } from "./logger";
import { readJson, writeJson } from "./persistence";

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
  gloss?: string; // faithful English gloss of a Spanish caption (for review)
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

GROUND HOOKS IN THE ACTUAL VIDEO: when a transcript is provided, base every hook on what the video genuinely contains — pull the real, specific moments/tips from it. If the TITLE overstates what the video delivers (e.g., titled "Full Tour & Review" but it's really just a room walkthrough), describe the ACTUAL content — never promise more than the video shows. The transcript is the source of truth, the title is not.

CORE RULE — VALUE, NEVER HYPE:
- Every post must tie to REALISTIC, concrete value: a specific tip, an honest take, a real tradeoff, a genuine moment. The host's 40 years of credibility (and a travel agency) depend on it.
- NEVER use hype, empty superlatives, or clickbait fluff. Banned vibes: "escape to luxury," "you won't believe," "ultimate," "amazing," "life-changing," "must-see," vague excitement. Be specific instead (numbers, the actual perk, the real catch).
- "Shock" (a surprising/funny/scroll-stopping hook) is a SHORTS tool only, and even then it must be grounded in something real — never fabricated drama. Track B never uses shock or hype.

Two audiences / tracks:
- Track A (Spanish, "Navega más inteligente. Ríe más."): the Latino audience, reached via Shorts + a warm Facebook network. Goal = grow subscribers. The Short's hook can be surprising/funny/shocking to stop the scroll — but real, not hype. Write in natural Latin American Spanish (es-419). Keep cruise line / ship / port names in their original language.
- Track B (English): the host's own base — middle-aged, affluent cruisers who respond to VALUE and credibility, not gags and not hype. Lead with a specific, useful, honest insight ("cruise smarter") — e.g. "the 3 Haven perks worth the upcharge, and the one that isn't" — seasoned lightly with humor. These are the buyers (premium gear + travel-agency clients); talk to them like a trusted expert, never a marketer.

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

When the caption is in Spanish, ALSO include "en_gloss": a faithful, natural English translation of that caption (so a non-Spanish speaker can review exactly what it says). For English captions, omit en_gloss.

Respond ONLY with a JSON object: { "posts": [ { "idx": <int>, "caption": "<string>", "hashtags": ["..."], "en_gloss": "<English translation, only if caption is Spanish>" } ] } with one element per requested slot, idx matching the input.`;

interface LlmPost {
  idx: number;
  caption: string;
  hashtags?: string[];
  en_gloss?: string;
}

// Best-effort fetch of a video's transcript (captions) so hooks are grounded in
// the actual content, not just the title. Returns "" on any failure (then hooks
// fall back to the title). A caller may also pass a transcript directly.
export async function fetchTranscript(videoId: string): Promise<string> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return "";
    const html = await res.text();
    const m = html.match(/"captionTracks":(\[.*?\}\])/);
    if (!m || !m[1]) return "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tracks = JSON.parse(m[1]) as Array<{ baseUrl?: string; languageCode?: string }>;
    const track = tracks.find((t) => /^en/i.test(t.languageCode ?? "")) ?? tracks[0];
    if (!track?.baseUrl) return "";
    const capRes = await fetch(track.baseUrl, { signal: AbortSignal.timeout(15_000) });
    if (!capRes.ok) return "";
    const xml = await capRes.text();
    const text = xml
      .replace(/<[^>]+>/g, " ")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 4000);
  } catch {
    return "";
  }
}

export async function generateSocialBatch(
  video: SocialVideo,
  track: Track,
  providedTranscript?: string,
): Promise<SocialBatch> {
  const apiKey = process.env["OPENAI_API_KEY"] || process.env["REPLIT_OPENAI_API_KEY"] || "";
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const transcript = (providedTranscript ?? "").trim() || (await fetchTranscript(video.id));
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
    (transcript
      ? `\nVIDEO TRANSCRIPT (the source of truth for what the video actually contains — base the hooks on this, not the title):\n"""${transcript}"""\n`
      : `\n(No transcript available — write conservative hooks from the title and do not promise specifics the video may not contain.)\n`) +
    `\nWrite one post per slot below. Return JSON {"posts":[{idx,caption,hashtags}]}.\n\n` +
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
    const glossText = lang === "es" ? (gen?.en_gloss?.trim() ?? "") : "";
    return {
      ...slot,
      track,
      lang,
      caption: gen?.caption?.trim() ?? "",
      ...(glossText ? { gloss: glossText } : {}),
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

// ─────────────────────────────────────────────────────────────────────────────
// Review queue — generated batches wait here for Mark's approval before posting.
// NOTHING is published from here; approval only flips status. Posting (Make/IG)
// is wired separately and gated.
// ─────────────────────────────────────────────────────────────────────────────

export type BatchStatus = "pending" | "approved" | "rejected" | "posted";

export interface QueuedBatch extends SocialBatch {
  id: string;
  status: BatchStatus;
  createdAt: string;
  decidedAt?: string;
}

interface SocialQueue {
  batches: QueuedBatch[];
}

const QUEUE_KEY = "social-queue";
const CHANNEL_ID = "UC1sZkmM4CezcS5DPIPlrCtA";

export async function loadQueue(): Promise<SocialQueue> {
  return readJson<SocialQueue>(QUEUE_KEY, { batches: [] });
}

export async function enqueueBatch(batch: SocialBatch): Promise<QueuedBatch> {
  const queue = await loadQueue();
  const queued: QueuedBatch = {
    ...batch,
    id: crypto.randomUUID(),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  queue.batches.unshift(queued);
  await writeJson(QUEUE_KEY, queue);
  return queued;
}

export async function setBatchStatus(
  id: string,
  status: BatchStatus,
): Promise<QueuedBatch | null> {
  const queue = await loadQueue();
  const batch = queue.batches.find((b) => b.id === id);
  if (!batch) return null;
  batch.status = status;
  batch.decidedAt = new Date().toISOString();
  await writeJson(QUEUE_KEY, queue);
  return batch;
}

// Pull recent uploads from the public channel RSS (no API key needed).
export async function fetchChannelVideos(limit = 15): Promise<SocialVideo[]> {
  const res = await fetch(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`Channel feed HTTP ${res.status}`);
  const xml = await res.text();

  const videos: SocialVideo[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) && videos.length < limit) {
    const entry = m[1] ?? "";
    const id = /<yt:videoId>(.*?)<\/yt:videoId>/.exec(entry)?.[1] ?? "";
    const titleRaw = /<title>(.*?)<\/title>/.exec(entry)?.[1] ?? "";
    if (!id || !titleRaw) continue;
    const title = titleRaw
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    // EN/ES routing: Spanish punctuation/accents → es, else en.
    const lang: Lang = /[¡¿áéíóúüñ]/i.test(title) ? "es" : "en";
    const format: "short" | "long" = /#short/i.test(title) ? "short" : "long";
    videos.push({ id, title, lang, format });
  }
  return videos;
}

// Generate + enqueue batches for recent uploads that aren't already queued
// (de-duped by videoId+track). Returns the newly created batches.
export async function scanAndQueue(maxNew = 4): Promise<QueuedBatch[]> {
  const [videos, queue] = await Promise.all([fetchChannelVideos(12), loadQueue()]);
  const existing = new Set(queue.batches.map((b) => `${b.videoId}:${b.track}`));
  const created: QueuedBatch[] = [];

  for (const video of videos) {
    if (created.length >= maxNew) break;
    const track: Track = video.lang === "es" ? "A" : "B";
    if (existing.has(`${video.id}:${track}`)) continue;
    try {
      const batch = await generateSocialBatch(video, track);
      const queued = await enqueueBatch(batch);
      created.push(queued);
    } catch (err) {
      logger.warn({ err, videoId: video.id }, "scanAndQueue: generation failed, skipping");
    }
  }
  return created;
}
