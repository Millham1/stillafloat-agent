import { logger } from "./logger";
import { PATHS, readJson, writeJson } from "./persistence";
import { notifyTelegram, reviewUrl } from "./telegram";

// ─────────────────────────────────────────────────────────────────────────────
// COMMENTARY AGENT — Mark's-opinion-first pipeline (his design, 2026-07-08):
//
//   1. Weekly (Tue) or on demand: pick the featured story of the week PLUS its
//      related cluster (e.g. the Nassau brawls + the Miami terminal fight are
//      one topic), and nudge Mark: "review these, give me your opinion" with
//      2–3 questions to draw the take out. NO prose is drafted yet.
//   2. Mark answers in his own words (typed or dictated).
//   3. The agent SYNTHESIZES: his stance is the spine of the piece; it pulls
//      additional backing coverage from the news archive as research, weaves
//      his take for maximum impact (Mark's explicit instruction: not verbatim
//      — sharpen for engagement and follower growth), and frames what it
//      means for other cruisers.
//   4. Mark reviews the draft (can revise his take and re-synthesize), then
//      explicitly publishes → the existing commentary CMS (ES auto-translate).
//
// Facts discipline: opinions come from Mark's take; facts come ONLY from the
// provided stories/research. The agent never invents experiences for him —
// but experiences he writes himself are fair game to feature.
//
// Downstream (Mac-side): a published commentary is the source script for a
// YouTube Short (b-roll pulled by the video skills); the post's videoUrl
// field embeds it on the site.
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
  stories: CommentaryStorySeed[]; // the featured cluster Mark reacts to
  research: CommentaryStorySeed[]; // extra archive coverage backing the piece
  questions: string[];
  markTake: string;
  suggestedTitle: string;
  draftHtml: string;
  tags: string[];
  status: "awaiting_take" | "drafted" | "published" | "discarded";
  generatedAt: string;
  draftedAt?: string;
}

export async function loadCommentaryDraft(): Promise<CommentaryDraft | null> {
  const d = await readJson<CommentaryDraft | Record<string, never>>(DRAFT_KEY, {});
  return d && Array.isArray((d as CommentaryDraft).stories) ? (d as CommentaryDraft) : null;
}

export async function saveCommentaryDraft(draft: CommentaryDraft): Promise<void> {
  await writeJson(DRAFT_KEY, draft);
}

// ── story selection ──────────────────────────────────────────────────────────
function toSeed(s: Record<string, unknown>): CommentaryStorySeed {
  return {
    id: String(s["id"] ?? ""),
    title: String(s["title"] ?? ""),
    summary: String(s["summary"] ?? s["synopsis"] ?? ""),
    link: String(s["link"] ?? s["originalLink"] ?? ""),
    impact: String(s["travelerImpact"] ?? s["impactLevel"] ?? ""),
    category: String(s["category"] ?? "Cruise News"),
  };
}

const STOPWORDS = new Set(
  "the a an and or for of in on at to with after as is are was were over under new more most from by cruise cruises cruising ship ships line lines passenger passengers guest guests port".split(
    " ",
  ),
);

function keywords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w))
      // naive stem so fight/fights, brawl/brawls, list/lists cluster together
      .map((w) => w.replace(/s$/, "")),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

async function allApprovedStories(): Promise<Array<Record<string, unknown>>> {
  const approved = await readJson<{ stories?: Array<Record<string, unknown>> }>(PATHS.approved, {
    stories: [],
  });
  if ((approved.stories ?? []).length > 0) return approved.stories!;
  // Fallback: the richer story archive (covers dev + thin approval weeks).
  const details = await readJson<{ stories?: Array<Record<string, unknown>> }>(
    PATHS.storyDetails,
    { stories: [] },
  );
  return details.stories ?? [];
}

// Featured story + related coverage = the cluster Mark reacts to; the next
// tier of related stories becomes backing research for the synthesis.
export async function pickStoryCluster(): Promise<{
  cluster: CommentaryStorySeed[];
  research: CommentaryStorySeed[];
}> {
  const stories = await allApprovedStories();
  if (stories.length === 0) return { cluster: [], research: [] };

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

  const sorted = [...stories].sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    return String(b["approvedAt"] ?? "").localeCompare(String(a["approvedAt"] ?? ""));
  });

  // The curated featured set IS the week's topic when the editor marked
  // several stories (e.g. two brawl stories = one commentary). Fall back to
  // keyword clustering around the top story otherwise.
  const featured = sorted.filter((s) => s["featured"] || s["pinned"]).slice(0, 4);
  const cluster = featured.length >= 2 ? featured : [sorted[0]!];

  const clusterIds = new Set(cluster.map((s) => String(s["id"] ?? "")));
  const clusterKw = new Set<string>();
  for (const s of cluster) for (const w of keywords(String(s["title"] ?? ""))) clusterKw.add(w);

  const related = sorted
    .filter((s) => !clusterIds.has(String(s["id"] ?? "")))
    .map((s) => ({ s, n: overlap(clusterKw, keywords(String(s["title"] ?? ""))) }))
    .filter((x) => x.n >= 1)
    .sort((a, b) => b.n - a.n)
    .map((x) => x.s);

  if (cluster.length === 1) cluster.push(...related.splice(0, 3));

  return {
    cluster: cluster.map(toSeed),
    research: related.slice(0, 5).map(toSeed),
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

const QUESTIONS_PROMPT = `${VOICE}

Mark is about to give his opinion on this week's featured cruise story (or story cluster).
Write 2–3 SHORT, pointed questions that will draw out his strongest personal take — his
opinion, what he'd tell clients, whether he's seen it himself. Questions only, no draft.

Respond ONLY with JSON: { "questions": ["...", "..."] }`;

const SYNTHESIZE_PROMPT = `${VOICE}

You have: (1) this week's featured story cluster, (2) additional backing coverage (research),
and (3) MARK'S OPINION in his own rough words. Write the weekly COMMENTARY for the website.

- Mark's stance is the SPINE of the piece. Do NOT quote him verbatim — weave and sharpen his
  take for maximum impact and shareability: a hook opening, a strong voice, a memorable close.
  This piece exists to gain followers. Stay 100% faithful to his actual position and to any
  experience he describes; never soften his stance and never invent experiences he didn't give.
- Facts (names, numbers, fines, bans, places) come ONLY from the provided stories and research.
  Cite them naturally in the prose ("a $52,000 lesson in Nassau"), no footnotes.
- Always land what this means for OTHER cruisers — the reader planning their next sailing.
- 300–500 words, simple HTML <p> paragraphs only. End with one practical takeaway or call to
  action (following the site/newsletter is fair game).

Respond ONLY with JSON:
{ "title": "...", "body_html": "<p>...</p>", "tags": ["...", "..."] }`;

// ── pipeline steps ───────────────────────────────────────────────────────────
// Step 1 — stage the ask: pick the cluster, generate questions, nudge Mark.
export async function stageWeeklyCommentary(options?: {
  notify?: boolean;
}): Promise<CommentaryDraft> {
  const { cluster, research } = await pickStoryCluster();
  if (cluster.length === 0) throw new Error("No stories available to stage a commentary");

  const out = await chatJson(
    QUESTIONS_PROMPT,
    `This week's featured story cluster:\n${JSON.stringify(cluster, null, 2)}`,
  );

  const draft: CommentaryDraft = {
    stories: cluster,
    research,
    questions: Array.isArray(out["questions"]) ? out["questions"].map(String).slice(0, 3) : [],
    markTake: "",
    suggestedTitle: "",
    draftHtml: "",
    tags: [],
    status: "awaiting_take",
    generatedAt: new Date().toISOString(),
  };
  await saveCommentaryDraft(draft);
  logger.info({ lead: cluster[0]!.title, cluster: cluster.length }, "Commentary staged — awaiting Mark's take");

  if (options?.notify !== false) {
    void notifyTelegram({
      heading: "🗣️ <b>This week's commentary — your opinion needed</b>",
      lines: [cluster[0]!.title, ...draft.questions.map((q) => `• ${q}`)],
      url: reviewUrl("/api/commentary/review"),
      buttonLabel: "Give your take →",
    });
  }
  return draft;
}

// Step 2 — synthesize: Mark's take + cluster + research → the commentary.
// Callable repeatedly (revise take → re-synthesize).
export async function synthesizeCommentary(markTake: string): Promise<CommentaryDraft> {
  const draft = await loadCommentaryDraft();
  if (!draft || (draft.status !== "awaiting_take" && draft.status !== "drafted")) {
    throw new Error("No staged commentary awaiting a take");
  }

  const out = await chatJson(
    SYNTHESIZE_PROMPT,
    JSON.stringify(
      {
        featured_stories: draft.stories,
        backing_research: draft.research,
        marks_opinion: markTake,
      },
      null,
      2,
    ),
  );

  draft.markTake = markTake;
  draft.suggestedTitle = String(out["title"] ?? draft.stories[0]!.title);
  draft.draftHtml = String(out["body_html"] ?? "");
  draft.tags = Array.isArray(out["tags"]) ? out["tags"].map(String).slice(0, 5) : [];
  draft.status = "drafted";
  draft.draftedAt = new Date().toISOString();
  await saveCommentaryDraft(draft);
  logger.info({ title: draft.suggestedTitle }, "Commentary synthesized from Mark's take");
  return draft;
}
