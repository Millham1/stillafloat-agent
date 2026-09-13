// news-hub-classifier.ts — the agent decides which cruise line a story belongs to.
//
// Mark, 2026-09-11: "Im assuming the agent will be reasoning these decisions
// moving forward." Pattern matching alone needs a hand every time a line adds a
// ship or an island, and it cannot tell a Disney Magic story from a Carnival
// Magic story, or a story ABOUT Royal Caribbean from one that merely mentions
// it. So: the obvious cases stay deterministic, the ambiguous ones are reasoned,
// and every verdict is stored per story id so each story is decided ONCE rather
// than on every rebuild — roughly one model call a day once the back catalogue
// is settled.
import { llmJson, anthropicConfigured, CHEAP_MODEL } from "./llm";
import { logger } from "./logger";
import { NEWS_HUBS, matchesHub, type NewsHub, type HubStory } from "./news-hubs";

/** storyId → the hub slugs that story belongs to ([] = no line, decided). */
export type HubAssignments = Record<string, string[]>;

export interface ClassifiableStory extends HubStory { id?: string }

/**
 * Which stories still need a verdict, and what the patterns already think.
 * A story whose headline names exactly one line is not worth a model call.
 */
export interface Triage {
  /** Decided by the headline alone. */
  settled: Map<string, string[]>;
  /** Genuinely ambiguous — no line named in the headline, or more than one. */
  ambiguous: ClassifiableStory[];
}

function namedInTitle(story: ClassifiableStory): NewsHub[] {
  const title = String(story.title ?? "");
  return NEWS_HUBS.filter((h) => h.match.test(title) && !h.exclude?.test(title));
}

export function triage(stories: readonly ClassifiableStory[], existing: HubAssignments = {}): Triage {
  const settled = new Map<string, string[]>();
  const ambiguous: ClassifiableStory[] = [];
  for (const story of stories) {
    const id = String(story.id ?? "");
    if (!id) continue;
    if (existing[id]) { settled.set(id, existing[id]!); continue; }   // decided before, never re-asked
    const named = namedInTitle(story);
    if (named.length === 1) { settled.set(id, [named[0]!.slug]); continue; }
    // Nothing named, or two lines named: let the agent read it.
    ambiguous.push(story);
  }
  return { settled, ambiguous };
}

export const HUB_VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      description: "One entry per story, in the order given.",
      items: {
        type: "object",
        properties: {
          storyId: { type: "string", description: "The story's id, copied exactly." },
          lines: {
            type: "array",
            description: "Slugs of the cruise lines this story is genuinely ABOUT. Empty when it is about neither, or about a different line.",
            items: { type: "string", enum: NEWS_HUBS.map((h) => h.slug) },
          },
          why: { type: "string", description: "One short sentence." },
        },
        required: ["storyId", "lines", "why"],
      },
    },
  },
  required: ["verdicts"],
} as const;

const SYSTEM = `You sort cruise news onto per-line pages for a cruise advisor's website.
Each page carries the stories a reader searching for that ONE line would expect to find.

Rules:
- A story belongs to a line when that line is its SUBJECT: its ship, its policy, its
  fee, its itinerary, its terminal, its announcement.
- A passing mention does not count. A story about one line that compares it to another
  belongs only to the line it is about.
- An industry story with no single subject line (a port expansion, a weather system, a
  regulator's report) belongs to every line it substantively affects, which may be none
  of the ones offered.
- Ship names repeat across lines. Disney Magic is not Carnival Magic. Adventure of the
  Seas is Royal Caribbean's, not Carnival Adventure. "<name> of the Seas" is always
  Royal Caribbean.
- Sister brands are separate: Princess, Holland America, Cunard, Costa, AIDA and
  Seabourn are not Carnival Cruise Line. Celebrity and Silversea are not Royal Caribbean
  International.
- Private islands NEVER decide the line. A parent company shares its islands across
  its brands and moves itineraries between them: Princess is being redirected off
  Princess Cays onto Half Moon Cay and Carnival's Celebration Key, and Celebrity ships
  call at Royal Caribbean's CocoCay. A Princess sailing that calls at Celebration Key
  is PRINCESS news and belongs to neither page. Ask whose ship it is, not whose island.

Return an empty list rather than a guess. A wrong story on a line's page is worse than
a missing one.`;

function storyBlock(s: ClassifiableStory, i: number): string {
  return `STORY ${i + 1}
  id: ${String(s.id ?? "")}
  headline: ${String(s.title ?? "")}
  cliffnote: ${String(s.summary ?? "").slice(0, 300)}`;
}

export function buildClassifyPrompt(stories: readonly ClassifiableStory[]): string {
  const lines = NEWS_HUBS.map((h) => `  ${h.slug} = ${h.line}`).join("\n");
  return `The pages available are:
${lines}

${stories.map(storyBlock).join("\n\n")}

For each story, return the slugs of the lines it is genuinely about.`;
}

export interface ClassifyResult {
  assignments: HubAssignments;
  reasoned: number;
  llmCalls: number;
  provider: "anthropic" | "patterns" | "error";
}

const BATCH = 15;

/**
 * Decide the ambiguous stories. Falls back to the deterministic patterns for
 * anything the model cannot be asked about, so a missing key or an outage
 * degrades to today's behaviour instead of emptying the hubs.
 */
export async function classifyStories(
  stories: readonly ClassifiableStory[],
  existing: HubAssignments = {},
  opts: { enabled?: boolean; maxBatches?: number } = {},
): Promise<ClassifyResult> {
  const { settled, ambiguous } = triage(stories, existing);
  const assignments: HubAssignments = {};
  for (const [id, slugs] of settled) assignments[id] = slugs;

  const patternFallback = (s: ClassifiableStory): string[] =>
    NEWS_HUBS.filter((h) => matchesHub(s, h)).map((h) => h.slug);

  if (opts.enabled === false || !anthropicConfigured() || !ambiguous.length) {
    for (const s of ambiguous) assignments[String(s.id)] = patternFallback(s);
    return { assignments, reasoned: 0, llmCalls: 0, provider: "patterns" };
  }

  const maxBatches = opts.maxBatches ?? 40;
  let llmCalls = 0, reasoned = 0, failed = false;
  for (let i = 0; i < ambiguous.length && llmCalls < maxBatches; i += BATCH) {
    const batch = ambiguous.slice(i, i + BATCH);
    try {
      llmCalls += 1;
      const out = await llmJson<{ verdicts?: { storyId?: string; lines?: string[] }[] }>({
        system: SYSTEM,
        user: buildClassifyPrompt(batch),
        schema: HUB_VERDICT_SCHEMA as unknown as Record<string, unknown>,
        model: CHEAP_MODEL,          // sorting, not writing
        maxTokens: 1500,
      });
      const byId = new Map(batch.map((s) => [String(s.id ?? ""), s]));
      const answered = new Set<string>();
      for (const v of out.verdicts ?? []) {
        const id = String(v.storyId ?? "");
        if (!byId.has(id)) continue;   // only ids we asked about
        const slugs = (v.lines ?? []).filter((x) => NEWS_HUBS.some((h) => h.slug === x));
        assignments[id] = [...new Set(slugs)];
        answered.add(id);
        reasoned += 1;
      }
      // Anything the model skipped keeps the deterministic answer.
      for (const s of batch) if (!answered.has(String(s.id))) assignments[String(s.id)] = patternFallback(s);
    } catch (err) {
      failed = true;
      logger.warn({ err, batch: batch.length }, "news hubs: classification batch failed — using patterns for it");
      for (const s of batch) assignments[String(s.id)] = patternFallback(s);
    }
  }
  // Anything left unasked (batch ceiling) keeps the deterministic answer; it will
  // be reasoned on the next run, since it is not written as a settled verdict.
  for (const s of ambiguous) if (!(String(s.id) in assignments)) assignments[String(s.id)] = patternFallback(s);
  return { assignments, reasoned, llmCalls, provider: failed ? "error" : reasoned ? "anthropic" : "patterns" };
}

/** The stories on one hub, by stored verdict, newest first. */
export function storiesByAssignment<T extends ClassifiableStory>(
  stories: readonly T[],
  hub: NewsHub,
  assignments: HubAssignments,
): T[] {
  const time = (s: T): number => {
    const t = Date.parse(String(s.approvedAt || s.generatedAt || ""));
    return Number.isNaN(t) ? 0 : t;
  };
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of stories) {
    const id = String(s.id ?? "");
    if (!id || seen.has(id)) continue;
    const slugs = assignments[id];
    // No verdict yet (a story added since the last run and not yet reasoned):
    // fall back to the pattern so the page is never short a story it should have.
    const belongs = slugs ? slugs.includes(hub.slug) : matchesHub(s, hub);
    if (!belongs) continue;
    seen.add(id);
    out.push(s);
  }
  return out.sort((a, b) => time(b) - time(a));
}
