import { logger } from "./logger";
import { PATHS, readJson, writeJson } from "./persistence";
import { notifyMark, reviewUrl } from "./notify";

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
  authoredBy?: "mark" | "agent";
  // Autonomous mode only: the argument the agent chose before writing. Surfaced on the
  // review card so Mark judges the POSITION, not just the prose.
  agentTake?: {
    peg_story_title: string;
    question: string;
    position: string;
    whos_wrong: string;
    what_should_change: string;
    sharpest_line: string;
  };
  // Autonomous mode only: what the verify pass caught and repaired before storing.
  factCheck?: { quote: string; problem: string }[];
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

// Editorial prose is the one place gpt-4o-mini genuinely cannot do the job. Handed a
// stance (Mark's take) it writes fine; asked to FORM one it retreats to summarising the
// cluster a paragraph at a time — which is exactly what "it's just regurgitating news"
// was. Opinion work runs on Claude; OpenAI stays as the crash-proof fallback so a bad
// key never kills the weekly run.
const COMMENTARY_MODEL = process.env["COMMENTARY_MODEL"] || "claude-sonnet-5";

// JSON SCHEMAS — the model fills these via a forced tool call, so the API guarantees
// well-formed JSON. Parsing prose-JSON out of the text block failed on 2 of 3 real runs
// (raw newlines and unescaped quotes inside body_html); this removes that failure mode.
const QUESTIONS_SCHEMA = {
  type: "object",
  properties: { questions: { type: "array", items: { type: "string" } } },
  required: ["questions"],
} as const;

const TAKE_SCHEMA = {
  type: "object",
  properties: {
    peg_story_title: { type: "string" },
    question: { type: "string" },
    position: { type: "string" },
    whos_wrong: { type: "string" },
    what_should_change: { type: "string" },
    sharpest_line: { type: "string" },
    supporting_facts: { type: "array", items: { type: "string" } },
  },
  required: ["peg_story_title", "question", "position", "whos_wrong", "what_should_change"],
} as const;

const FACTCHECK_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { quote: { type: "string" }, problem: { type: "string" } },
        required: ["quote", "problem"],
      },
    },
    corrected_title: { type: "string" },
    corrected_body_html: { type: "string" },
  },
  required: ["findings", "corrected_title", "corrected_body_html"],
} as const;

const COMMENTARY_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    body_html: { type: "string", description: "4-6 <p> paragraphs, 300-500 words total" },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["title", "body_html", "tags"],
} as const;

async function claudeJson(
  system: string,
  user: string,
  schema: Record<string, unknown>,
  maxTokens = 2000,
): Promise<Record<string, unknown>> {
  const apiKey = process.env["ANTHROPIC_API_KEY"] || "";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: COMMENTARY_MODEL,
      max_tokens: maxTokens,
      // No `temperature` — deprecated on the Claude 5 models and a hard 400 if sent.
      system,
      tools: [{ name: "emit", description: "Return the finished result.", input_schema: schema }],
      tool_choice: { type: "tool", name: "emit" },
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = (await response.json()) as {
    content?: { type: string; name?: string; input?: Record<string, unknown> }[];
    stop_reason?: string;
    error?: { message?: string };
  };
  if (!response.ok || payload.stop_reason === "refusal") {
    throw new Error(
      `Anthropic HTTP ${response.status} ${payload.error?.message ?? payload.stop_reason ?? ""}`,
    );
  }
  const block = (payload.content ?? []).find((b) => b.type === "tool_use" && b.name === "emit");
  if (!block?.input) throw new Error("Anthropic returned no structured result");
  return block.input;
}

// All voice/opinion calls go through here: Claude first, OpenAI if Claude is unavailable.
async function opinionJson(
  system: string,
  user: string,
  schema: Record<string, unknown>,
  maxTokens = 2000,
): Promise<Record<string, unknown>> {
  try {
    return await claudeJson(system, user, schema, maxTokens);
  } catch (error) {
    logger.warn(
      { err: (error as Error).message },
      "Commentary: Claude unavailable, falling back to OpenAI",
    );
    return chatJson(system, user);
  }
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
- Mark often hands you his SHARPEST material — a vivid line, a joke, a hard position (e.g. a
  Darwin quip, "people with no skin in the game get hurt", "share their names, ban them
  everywhere"). Those are the piece's best moments: keep their essence and punch them up.
  Sanding them off into polite generalities is failure.
- Stay ON the topic of his take from first line to last. Do not pad with adjacent feel-good
  news unless it directly serves his argument.
- Facts (names, numbers, fines, bans, places) come ONLY from the provided stories and research,
  and must match the source EXACTLY (five passengers is five, not six). Cite them naturally in
  the prose ("a $52,000 lesson in Nassau"), no footnotes.
- Always land what this means for OTHER cruisers — the reader planning their next sailing.
- 300–500 words, simple HTML <p> paragraphs only. End with one practical takeaway or call to
  action (following the site/newsletter is fair game).

Respond ONLY with JSON:
{ "title": "...", "body_html": "<p>...</p>", "tags": ["...", "..."] }`;

// Autonomous mode, step A — DECIDE THE ARGUMENT before a word of prose exists.
// This step is the whole fix: take-mode works because Mark hands the piece a spine.
// Without one the writer summarises. So the agent forms the spine first, then writes
// from it through the same "stance is the spine" discipline the take path uses.
const TAKE_PROMPT = `${VOICE}

You are the editor deciding what Still Afloat ARGUES this week. You are not writing the piece
yet, and you are not summarising the news. You are picking a fight worth having.

From this week's story cluster:
1. Pick ONE story as the peg — the one with a real argument inside it. The rest exist only as
   evidence. A story that does not serve the argument gets dropped, not covered.
2. Find the question that story raises — one reasonable people disagree about.
3. ANSWER IT. Pick a side. "It depends", "both sides have a point" and "there are no easy
   answers" are failures. If nobody could reasonably disagree with your position, it is not one.
4. Name who is getting it wrong: the passengers, a named line, the industry, the ports, the
   coverage, or the readers themselves. Someone should be uncomfortable reading this.
5. Say what should concretely change.

Constraints:
- Consumer-first is WHERE Still Afloat stands — the reader's money, safety and trip come first.
  It is not a substitute for having a position on this specific story.
- No invented experience: you may not claim Mark was aboard, had a client, or saw it himself.
  You are choosing an argument, not a memory.
- The position must be defensible from the supplied facts alone.
- Do not rest the argument on what another industry supposedly does — no airlines, casinos,
  hotels or stadiums, and no "the way X already handles Y". You have no source for those and
  earlier attempts stated them flatly and were wrong. Argue from the cruise facts you were
  given. A mechanism you propose in your own voice is fine; crediting it to somebody else's
  industry is not.

Respond ONLY with JSON:
{
  "peg_story_title": "the one story the piece hangs on",
  "question": "the arguable question it raises, one line",
  "position": "the answer, stated flatly in 1-2 sentences — the thesis of the piece",
  "whos_wrong": "who is getting it wrong, and why",
  "what_should_change": "the concrete change being argued for",
  "sharpest_line": "one vivid in-voice line that could survive into the finished piece",
  "supporting_facts": ["only facts from the cluster/research that serve THIS argument"]
}`;

// Autonomous mode, step B — WRITE the decided argument. The position arrives as the
// spine, occupying the same slot Mark's take does in SYNTHESIZE_PROMPT.
const AUTONOMOUS_PROMPT = `${VOICE}

Mark delegated this week's COMMENTARY. The editorial position has already been decided and is
handed to you below. That position is the SPINE of the piece, exactly as Mark's own take would
be. Argue it. Do not reopen it, and do not report the news around it.

THIS IS AN OPINION COLUMN, NOT A NEWS ROUNDUP. Precisely what to avoid:
- Do NOT give each story its own paragraph, and do NOT walk the cluster in sequence.
- Do NOT write a paragraph whose job is to summarise what happened. Facts appear only inside
  sentences that are making the argument.
- Do NOT write "advocates argue... on the other hand, critics say..." and leave it there. You
  already have the answer. If you raise the other side, it is to knock it down.
- Do NOT open with throat-clearing about cruising, vacations, or "recent events".
- Do NOT close on a limp moral like "think before you act" or "be respectful out there".

Do:
- Open on the position, or on one hard concrete detail. Never on background. The first sentence
  should make a reader who disagrees want to argue back.
- Keep the peg story as the centre of gravity. Other stories may appear as a clause of evidence
  ("the sixteen banned at PortMiami"), never as their own recap.
- Say plainly who is getting it wrong and what should change.
- Keep the sharpest line's punch. Sanding it into a polite generality is failure.
- Land what this means for the reader planning their next sailing.

FACTS — HARD RULES. Every one of these has been broken by a previous draft. The argument is
where the heat belongs; the facts stay exactly as the source left them.
1. Names, numbers, fines, bans, dates, ships and places come ONLY from the provided stories and
   research, and must match the source EXACTLY. Cite them naturally in the prose, no footnotes.
2. NEVER upgrade a fact. If the source says luggage was thrown and officers stepped in, you may
   not write that luggage was thrown AT officers. Do not add a target, motive, injury or
   severity the source did not state.
3. CHARGED IS NOT DID. If the source says "faced charges including X", "reportedly", or
   "alleged", keep that framing. Never restate an accusation as a completed act.
4. Never contradict something the source states plainly. If it says no arrests were made, there
   was no arrest and no police report.
5. INVENT NO NUMBERS. Not a count of cruise companies, not how long a ban lasts, not a
   timeframe, not a price. If a number is not in the source, it does not go in the piece.
6. Name no company, ship or person that is not in the source — not in a claim, and not in a
   hypothetical or a throwaway example either. Do not reach for another cruise line's name just
   because it makes the sentence land better. If you need a generic stand-in, write "another
   line" or "a competitor".
7. Claim nothing about a person's history — no prior incidents, no "repeat offenders", no
   suggestion they are known to the system — unless the source says so.
8. DO NOT REACH FOR OTHER INDUSTRIES. Do not tell the reader what airlines, casinos, hotels,
   stadiums, banks or anyone else does about bans, blacklists, no-fly lists or shared
   databases — not as a claim, not hedged, not in passing. You have no source for any of it and
   earlier drafts stated it flatly and were wrong. Make the argument on the cruise facts you
   were given. If you want to propose a mechanism, propose it in your own voice ("the lines
   could keep a shared, appealable list") without crediting it to another industry.

ABSOLUTE RULE — no invented experience. You write as Still Afloat this week, not as Mark: no
first-person anecdotes, no "I was on that ship", no invented clients. Use "we" or plain
declarative. This limits your MEMORY, not your NERVE — the opinions stay sharp.

TITLE: state the argument, do not label the topic. "What Every Passenger Should Know" is the
kind of title this piece must never carry.

LENGTH: 400-550 words across 4 to 6 separate <p> paragraphs. One or two paragraphs is a
failure — the argument needs room to open, bring its evidence, turn on the counter-argument,
and land. Simple <p> tags only, no other HTML. End with one practical takeaway or call to
action (following the site/newsletter is fair game).

Final checks before answering, in order:
1. Does any sentence state a fact — a number, a name, a completed act, another industry's
   practice, a person's history — that is not in the supplied sources? Cut it.
2. Would the piece read the same with the opposite position pasted in? Rewrite it.
3. Could any paragraph run unchanged as a news brief? Rewrite it.
4. Is the body under 400 words or over 550? Fix it.

Respond ONLY with JSON, body_html holding every paragraph:
{ "title": "...", "body_html": "<p>...</p><p>...</p><p>...</p><p>...</p>", "tags": ["...", "..."] }`;

// Autonomous mode, step C — VERIFY. Prompt rules alone could not hold this: across
// repeated real runs the writer kept inventing fresh concrete colour to make sentences
// land ("six thousand other passengers", "last spring", "in a single afternoon"). Rules
// closed each lane and it found another. So the draft now gets checked against the
// sources by a second pass before it can be stored — the same verify-then-trust shape
// the news relevance verifier uses. Autopilot publishes without Mark reading it, so this
// gate is the thing standing between a rhetorical flourish and a correction on the site.
const FACTCHECK_PROMPT = `${VOICE}

You are the fact-checker, not the editor. You get a finished commentary and the ONLY sources it
was allowed to use. Find every factual claim in the piece that those sources do not support, and
repair it — without weakening the argument.

FIRST, THE LINE YOU MUST NOT CROSS. This is an opinion column and the opinions are supposed to
be sharp. A FACT is a checkable statement about the world: what happened, to whom, when, where,
how many, what it cost, what some other industry does. That is your jurisdiction. The following
are NOT factual claims and you must leave them completely alone, however strongly worded:
- The writer's position, verdict or thesis.
- Accusations of motive or bad faith ("that gap is deliberate", "the ban is theater", "they
  haven't bothered because it costs them money"). Arguing about why someone acts is opinion.
- Predictions, proposals, and value judgements ("the lines should build a shared list", "this is
  the bare minimum", "that's not accountability").
- Rhetorical characterisation of sourced facts ("a $52,000 lesson", "a customer transfer").
Flagging one of these is a failure. Neutering the argument is worse than the error you were
trying to fix. If in doubt about whether something is fact or contention, leave it.

Flag and fix:
- Any number, name, date, place, ship, company or timeframe not in the sources. This includes
  invented colour like "six thousand other passengers", "last spring", "in a single afternoon",
  "sixteen separate companies" — vivid detail is exactly where invention hides.
- Any accusation restated as a completed act. "Faced charges including X" must not become "did X".
- Anything contradicting the sources (e.g. implying arrests when the source says none were made).
- Any claim about how another industry handles bans, blacklists or shared databases — airlines,
  casinos, hotels, banks, "any business that already does this". None of it is sourced. Remove it
  or restate it as the writer's own proposal with no other industry credited.
- Any claim about a person's history, prior incidents or gender that the source does not state.
  A name does not tell you someone's gender — use their name or "one passenger", never "she"
  or "the guy".
- Any statement about what the industry already coordinates on, unless a source says so.

How to repair:
- Rewrite ONLY the offending sentences. Keep the argument, the stance, the structure, the voice
  and the paragraph count exactly as they are. You are not re-editing the piece.
- Prefer tightening to deleting: an unsupported specific usually has a supported version
  ("thousands of guests" instead of "six thousand"). If there is no supported version, cut the
  claim and let the sentence stand on the argument.
- Never add a new fact of your own.
- The title gets the same treatment; return it unchanged if it is fine.

If the piece is already clean, return findings: [] and hand back the title and body unchanged.

Respond ONLY with JSON:
{ "findings": [{ "quote": "...", "problem": "..." }], "corrected_title": "...",
  "corrected_body_html": "<p>...</p>" }`;

// ── pipeline steps ───────────────────────────────────────────────────────────
// Step 1 — stage the ask: pick the cluster, generate questions, nudge Mark.
export async function stageWeeklyCommentary(options?: {
  notify?: boolean;
}): Promise<CommentaryDraft> {
  const { cluster, research } = await pickStoryCluster();
  if (cluster.length === 0) throw new Error("No stories available to stage a commentary");

  const out = await opinionJson(
    QUESTIONS_PROMPT,
    `This week's featured story cluster:\n${JSON.stringify(cluster, null, 2)}`,
    QUESTIONS_SCHEMA as unknown as Record<string, unknown>,
    1000,
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
    void notifyMark({
      title: "🗣️ This week's commentary — your opinion needed",
      body: [cluster[0]!.title, ...draft.questions.map((q) => `• ${q}`)].join("\n"),
      url: reviewUrl("/api/commentary/review"),
      tag: "commentary-review",
    });
  }
  return draft;
}

// Step 2 — synthesize: Mark's take + cluster + research → the commentary.
// Callable repeatedly (revise take → re-synthesize).
/**
 * The one-peg-story rule, as a pure function so it is testable and cannot drift.
 *
 * Handing the writer a LIST of stories is what produced "it's just repeating news
 * stories": no single proposition spans four unrelated items, so the model
 * summarises each in turn. Exactly one story is the subject; the rest may only
 * appear as supporting evidence.
 */
export function autonomousWriterPayload(
  draft: Pick<CommentaryDraft, "stories" | "research">,
  agentTake: NonNullable<CommentaryDraft["agentTake"]>,
): Record<string, unknown> {
  const peg =
    draft.stories.find((x) => x.title === agentTake.peg_story_title) ?? draft.stories[0];
  return {
    editorial_position: agentTake,
    peg_story: peg,
    other_stories_as_evidence_only: draft.stories.filter((x) => x.title !== peg?.title),
    backing_research: draft.research,
  };
}

/**
 * Whether a fact-check repair may replace the draft. A truncated or gutted
 * response must never silently overwrite a good piece.
 */
export function acceptRepair(original: string, corrected: string): boolean {
  return corrected.includes("<p>") && corrected.length > original.length * 0.6;
}

export async function synthesizeCommentary(markTake: string | null): Promise<CommentaryDraft> {
  const draft = await loadCommentaryDraft();
  if (!draft || (draft.status !== "awaiting_take" && draft.status !== "drafted")) {
    throw new Error("No staged commentary awaiting a take");
  }

  // null take = Mark delegated ("write the commentary without my input", 8/16):
  // the agent authors the stance itself — brand-voice opinion, zero invented
  // personal experience (that guard lives in AUTONOMOUS_PROMPT).
  const autonomous = !markTake || !markTake.trim();

  // Autonomous step A: decide the argument. Without this the writer has no spine and
  // falls back to summarising the cluster one story per paragraph.
  let agentTake: CommentaryDraft["agentTake"];
  if (autonomous) {
    const decided = await opinionJson(
      TAKE_PROMPT,
      JSON.stringify(
        { featured_stories: draft.stories, backing_research: draft.research },
        null,
        2,
      ),
      TAKE_SCHEMA as unknown as Record<string, unknown>,
      1200,
    );
    agentTake = {
      peg_story_title: String(decided["peg_story_title"] ?? draft.stories[0]!.title),
      question: String(decided["question"] ?? ""),
      position: String(decided["position"] ?? ""),
      whos_wrong: String(decided["whos_wrong"] ?? ""),
      what_should_change: String(decided["what_should_change"] ?? ""),
      sharpest_line: String(decided["sharpest_line"] ?? ""),
    };
    if (!agentTake.position.trim()) {
      throw new Error("Autonomous commentary: no position was decided — refusing to write");
    }
    logger.info({ position: agentTake.position }, "Commentary: agent decided its position");
  }

  // Autonomous step B: write it. The decided position occupies the same slot Mark's
  // take does — the spine of the piece.
  const out = await opinionJson(
    autonomous ? AUTONOMOUS_PROMPT : SYNTHESIZE_PROMPT,
    JSON.stringify(
      autonomous
        ? autonomousWriterPayload(draft, agentTake!)
        : {
            featured_stories: draft.stories,
            backing_research: draft.research,
            marks_opinion: markTake,
          },
      null,
      2,
    ),
    COMMENTARY_SCHEMA as unknown as Record<string, unknown>,
    2500,
  );

  let title = String(out["title"] ?? draft.stories[0]!.title);
  let bodyHtml = String(out["body_html"] ?? "");
  let findings: { quote: string; problem: string }[] = [];

  // Autonomous step C: verify against the sources before this can be stored or published.
  // Mark's take is exempt — his own experience is legitimately unsourced.
  if (autonomous && bodyHtml.trim()) {
    try {
      const checked = await opinionJson(
        FACTCHECK_PROMPT,
        JSON.stringify(
          {
            the_only_permitted_sources: [...draft.stories, ...draft.research],
            commentary_title: title,
            commentary_body_html: bodyHtml,
          },
          null,
          2,
        ),
        FACTCHECK_SCHEMA as unknown as Record<string, unknown>,
        3000,
      );
      const corrected = String(checked["corrected_body_html"] ?? "");
      const rawFindings = Array.isArray(checked["findings"]) ? checked["findings"] : [];
      findings = rawFindings
        .map((f) => f as { quote?: unknown; problem?: unknown })
        .map((f) => ({ quote: String(f.quote ?? ""), problem: String(f.problem ?? "") }))
        .filter((f) => f.quote);
      // Only accept the repair if it came back a real piece — a truncated or gutted
      // response must never silently replace a good draft.
      if (acceptRepair(bodyHtml, corrected)) {
        bodyHtml = corrected;
        title = String(checked["corrected_title"] ?? title) || title;
      } else if (findings.length > 0) {
        logger.warn(
          { findings: findings.length },
          "Commentary fact-check found problems but returned an unusable repair — keeping original",
        );
      }
      logger.info({ repaired: findings.length }, "Commentary fact-check complete");
    } catch (error) {
      // A failed check must not silently pass an unverified piece through to autopilot.
      throw new Error(`Commentary fact-check failed: ${(error as Error).message}`);
    }
  }

  draft.markTake = autonomous ? "" : (markTake as string);
  if (autonomous) {
    draft.agentTake = agentTake;
    draft.factCheck = findings;
  } else {
    delete draft.agentTake;
    delete draft.factCheck;
  }
  draft.authoredBy = autonomous ? "agent" : "mark";
  draft.suggestedTitle = title;
  draft.draftHtml = bodyHtml;
  draft.tags = Array.isArray(out["tags"]) ? out["tags"].map(String).slice(0, 5) : [];
  draft.status = "drafted";
  draft.draftedAt = new Date().toISOString();
  await saveCommentaryDraft(draft);
  logger.info({ title: draft.suggestedTitle, authoredBy: draft.authoredBy },
    "Commentary synthesized");
  return draft;
}
