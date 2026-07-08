import { logger } from "./logger";
import { PATHS, readJson, writeJson } from "./persistence";
import { notifyTelegram, reviewUrl } from "./telegram";

// ─────────────────────────────────────────────────────────────────────────────
// COMMENTARY AGENT — the original-vision loop, finally built.
//
// Weekly (or on demand): pick the featured news story of the week, draft a
// brand-voice commentary, and — the key step — ASK MARK FOR HIS TAKE. The
// agent's draft is analysis-only; it never invents Mark's experiences
// (scripts-no-fabrication rule). The review page shows the draft plus 2–3
// pointed questions; Mark types (or dictates) his take, the agent weaves it
// in verbatim-respecting, and only Mark's explicit Publish pushes it to the
// site's commentary section (via the existing /api/commentary CMS, which
// auto-translates to es-419).
//
// Draft state lives in platform_state "commentary-draft". Downstream (Mac-
// side skills): an approved commentary is the source script for a YouTube
// Short — the published post's videoUrl field embeds it once uploaded.
// ─────────────────────────────────────────────────────────────────────────────

const DRAFT_KEY = "commentary-draft";

export interface CommentaryStorySeed {
  id: string;
  title: string;
  summary: string;
  link: string;
  impact: string;
  category: string;
}

export interface CommentaryDraft {
  story: CommentaryStorySeed;
  suggestedTitle: string;
  draftHtml: string;
  questions: string[];
  markContext: string;
  tags: string[];
  generatedAt: string;
  wovenAt?: string;
  status: "pending" | "published" | "discarded";
}

export async function loadCommentaryDraft(): Promise<CommentaryDraft | null> {
  const d = await readJson<CommentaryDraft | Record<string, never>>(DRAFT_KEY, {});
  return d && (d as CommentaryDraft).story ? (d as CommentaryDraft) : null;
}

export async function saveCommentaryDraft(draft: CommentaryDraft): Promise<void> {
  await writeJson(DRAFT_KEY, draft);
}

// ── featured story of the week ───────────────────────────────────────────────
// Prefer explicitly featured stories, then high/critical impact, then newest.
export async function pickFeaturedStory(): Promise<CommentaryStorySeed | null> {
  const data = await readJson<{ stories?: Array<Record<string, unknown>> }>(PATHS.approved, {
    stories: [],
  });
  const stories = data.stories ?? [];
  if (stories.length === 0) return null;

  const score = (s: Record<string, unknown>): number => {
    let n = 0;
    if (s["featured"] || s["pinned"]) n += 4;
    const impact = String(s["impactLevel"] ?? "").toLowerCase();
    if (impact.includes("critical")) n += 3;
    else if (impact.includes("high")) n += 2;
    const t = new Date(String(s["approvedAt"] ?? "")).getTime();
    if (!Number.isNaN(t) && Date.now() - t < 7 * 24 * 3600_000) n += 1;
    return n;
  };

  const best = [...stories].sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    return String(b["approvedAt"] ?? "").localeCompare(String(a["approvedAt"] ?? ""));
  })[0]!;

  return {
    id: String(best["id"] ?? ""),
    title: String(best["title"] ?? ""),
    summary: String(best["summary"] ?? best["synopsis"] ?? ""),
    link: String(best["link"] ?? best["originalLink"] ?? ""),
    impact: String(best["travelerImpact"] ?? best["impactLevel"] ?? ""),
    category: String(best["category"] ?? "Cruise News"),
  };
}

// ── LLM plumbing ─────────────────────────────────────────────────────────────
async function chatJson(system: string, user: string): Promise<Record<string, unknown>> {
  const apiKey = process.env["OPENAI_API_KEY"] || "";
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`OpenAI HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = (await response.json()) as any;
  return JSON.parse(String(payload?.choices?.[0]?.message?.content ?? "{}")) as Record<
    string,
    unknown
  >;
}

const VOICE = `You write for Still Afloat Cruising in Mark's voice: "the experienced friend who
made the mistakes and tells the truth." 20+ years cruising, guide-not-guru, calm and grounded,
lightly funny — "sounds like Mark talking to someone at a bar," never a campaign. Humor is
seasoning; information is the meal. Value, never hype. No banned hype words (ultimate, luxurious,
epic, amazing).`;

const DRAFT_PROMPT = `${VOICE}

You are drafting this week's COMMENTARY for the website: a short op-ed (250–400 words, simple
HTML: <p> paragraphs only) reacting to the featured cruise news story of the week. Explain what
happened, what it actually means for everyday cruisers, and end with one practical takeaway.

HARD RULE — NO FABRICATION: you do NOT know Mark's personal experiences. Do not invent anecdotes,
sailings, or opinions attributed to him. Write sturdy analysis from the story's facts only. Mark's
personal take gets woven in later, in his own words.

Also produce 2–3 SHORT, pointed questions that would draw out Mark's personal take on this story
(e.g. has he seen this on a sailing, what would he tell a client booking next month, does this
change any advice he gives).

Respond ONLY with JSON:
{ "title": "...", "body_html": "<p>...</p>", "questions": ["...", "..."], "tags": ["...", "..."] }`;

const WEAVE_PROMPT = `${VOICE}

You have a draft commentary and MARK'S OWN TAKE (his typed/dictated notes). Rewrite the
commentary weaving his take in as the heart of the piece — his experiences and opinions in
first person, staying faithful to HIS words and facts.

HARD RULES:
- Use ONLY the experiences, opinions and facts Mark actually wrote. Never extend, embellish or
  invent details he didn't give. Light grammar cleanup is fine; new claims are not.
- Keep 250–450 words, simple HTML <p> paragraphs, one practical takeaway at the end.

Respond ONLY with JSON: { "title": "...", "body_html": "<p>...</p>" }`;

// ── draft + weave ────────────────────────────────────────────────────────────
export async function draftWeeklyCommentary(options?: {
  notify?: boolean;
}): Promise<CommentaryDraft> {
  const story = await pickFeaturedStory();
  if (!story) throw new Error("No approved stories to draft a commentary from");

  const out = await chatJson(
    DRAFT_PROMPT,
    `Featured story of the week:\n${JSON.stringify(story, null, 2)}`,
  );

  const draft: CommentaryDraft = {
    story,
    suggestedTitle: String(out["title"] ?? story.title),
    draftHtml: String(out["body_html"] ?? ""),
    questions: Array.isArray(out["questions"]) ? out["questions"].map(String).slice(0, 3) : [],
    markContext: "",
    tags: Array.isArray(out["tags"]) ? out["tags"].map(String).slice(0, 5) : [],
    generatedAt: new Date().toISOString(),
    status: "pending",
  };
  await saveCommentaryDraft(draft);
  logger.info({ story: story.title }, "Commentary draft generated");

  if (options?.notify !== false) {
    void notifyTelegram({
      heading: "🗣️ <b>Commentary draft ready — your take needed</b>",
      lines: [draft.suggestedTitle, ...draft.questions.map((q) => `• ${q}`)],
      url: reviewUrl("/api/commentary/review"),
      buttonLabel: "Add your take →",
    });
  }
  return draft;
}

export async function weaveCommentary(markContext: string): Promise<CommentaryDraft> {
  const draft = await loadCommentaryDraft();
  if (!draft || draft.status !== "pending") throw new Error("No pending commentary draft");

  const out = await chatJson(
    WEAVE_PROMPT,
    JSON.stringify(
      {
        story: draft.story,
        current_draft_html: draft.draftHtml,
        marks_take: markContext,
      },
      null,
      2,
    ),
  );

  draft.suggestedTitle = String(out["title"] ?? draft.suggestedTitle);
  draft.draftHtml = String(out["body_html"] ?? draft.draftHtml);
  draft.markContext = markContext;
  draft.wovenAt = new Date().toISOString();
  await saveCommentaryDraft(draft);
  logger.info("Commentary draft rewoven with Mark's take");
  return draft;
}
