import { logger } from "./logger";
import Parser from "rss-parser";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_gnews",
      description:
        "Search for current travel and cruise news using a query string. Returns up to 10 recent articles. Use targeted, specific queries to find breaking stories. Maximum 5 searches per session.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'A specific news search query, e.g. "cruise ship itinerary change Caribbean" or "airline cancellations US airports"',
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_rss_feed",
      description:
        "Fetch the latest stories from a named RSS news source. Choose sources relevant to what you are looking for.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            enum: [
              "CNN Travel",
              "Fox News Travel",
              "BBC Travel",
              "The Points Guy",
              "Condé Nast Traveler",
              "Skift",
              "Upgraded Points",
              "Cruise Hive",
              "Cruise Radio",
              "Cruise Industry News",
              "Simple Flying",
              "View From The Wing",
              "One Mile at a Time",
              "Aviation Geek Club",
            ],
            description: "The name of the RSS feed source to fetch",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_editorial_decisions",
      description:
        "Submit your final curated list of stories for publication. Call this when you have reviewed enough sources and are confident in your 10–15 story selection. You MUST call this to complete the editorial run.",
      parameters: {
        type: "object",
        properties: {
          stories: {
            type: "array",
            description: "10–15 curated stories for the editorial queue",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Unique identifier — use the article URL or a short slug" },
                title: { type: "string", description: "Clean, factual headline" },
                tier: { type: "integer", minimum: 1, maximum: 4, description: "Editorial tier: 1=Direct Cruise Impact, 2=Travel Operations, 3=Mainstream Relevant, 4=Lifestyle" },
                category: {
                  type: "string",
                  enum: ["Cruise News", "Aviation", "Travel Advisory", "Weather & Disruption", "Tourism", "Travel Tech", "Health & Safety", "Loyalty & Deals"],
                },
                impactLevel: { type: "string", enum: ["Critical", "High", "Medium", "Low"] },
                travelerImpact: { type: "string", description: "1 crisp sentence: the single most important thing a traveler needs to act on or know right now." },
                summary: {
                  type: "string",
                  description: "CliffsNotes-style synopsis (4-6 sentences). Do NOT copy-paste the article lead. Instead synthesize: (1) What happened and who is involved. (2) The underlying cause or context. (3) The scale or significance. (4) What it means specifically for cruisers or travelers. (5) Any action, date, or detail worth knowing. Write as if briefing a busy editor who hasn't read the article — factual, specific, no filler phrases like 'in a significant development'.",
                },
                homepageCandidate: { type: "boolean" },
                reasoning: { type: "string", description: "One sentence: why this story was selected and which tier" },
                link: { type: "string", description: "Original article URL" },
                source: { type: "string", description: "Source publication name" },
                image: { type: "string", description: "Image URL if available, empty string if not" },
              },
              required: ["id", "title", "tier", "category", "impactLevel", "travelerImpact", "summary", "homepageCandidate", "reasoning", "link", "source"],
            },
          },
          homepageTop5: {
            type: "array",
            description: "IDs of the top 5 stories for the website homepage (Tier 1 and 2 priority)",
            items: { type: "string" },
          },
          groupedDevelopments: {
            type: "array",
            description: "Groups of story IDs that cover the same developing event",
            items: {
              type: "object",
              properties: {
                theme: { type: "string" },
                storyIds: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
        required: ["stories", "homepageTop5"],
      },
    },
  },
];

// ─── RSS feeds registry ──────────────────────────────────────────────────────

const RSS_REGISTRY: Record<string, string> = {
  "CNN Travel": "http://rss.cnn.com/rss/edition_travel.rss",
  "Fox News Travel": "https://feeds.foxnews.com/foxnews/travel",
  "BBC Travel": "http://feeds.bbci.co.uk/news/travel/rss.xml",
  "The Points Guy": "https://thepointsguy.com/feed/",
  "Condé Nast Traveler": "https://www.cntraveler.com/feed/rss",
  "Skift": "https://skift.com/feed/",
  "Upgraded Points": "https://upgradedpoints.com/feed/",
  "Cruise Hive": "https://www.cruisehive.com/feed",
  "Cruise Radio": "https://cruiseradio.net/feed/",
  "Cruise Industry News": "https://www.cruiseindustrynews.com/cruise-news/feed",
  "Simple Flying": "https://simpleflying.com/feed/",
  "View From The Wing": "https://viewfromthewing.com/feed/",
  "One Mile at a Time": "https://onemileatatime.com/feed/",
  "Aviation Geek Club": "https://theaviationgeekclub.com/feed/",
};

const rssParser = new Parser({ timeout: 8000 });

// ─── Tool executors ──────────────────────────────────────────────────────────

function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max) + "…";
}

async function toolSearchGnews(
  query: string,
  apiKey: string
): Promise<Record<string, unknown>[]> {
  try {
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&max=8&apikey=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = await res.json() as any;
    return (payload.articles || []).map((a: any) => ({
      title: truncate(a.title, 120),
      desc: truncate(a.description, 160),
      url: a.url,
      src: a.source?.name || "GNews",
      date: a.publishedAt,
    }));
  } catch (err) {
    logger.warn({ err, query }, "GNews search failed");
    return [];
  }
}

async function toolFetchRss(
  name: string
): Promise<Record<string, unknown>[]> {
  const url = RSS_REGISTRY[name];
  if (!url) return [];
  try {
    const feed = await rssParser.parseURL(url);
    return (feed.items || []).slice(0, 10).map((item) => ({
      title: truncate(item.title, 120),
      desc: truncate(item.contentSnippet || item.summary || "", 400),
      url: item.link || item.guid || "",
      src: name,
      date: item.isoDate || item.pubDate || "",
    }));
  } catch (err) {
    logger.warn({ err, name }, "RSS fetch failed in agent tool");
    return [];
  }
}

// ─── Agent system prompt ─────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const now = new Date().toUTCString();
  return `You are the Still Afloat editorial AI agent — autonomous travel news curator for a cruise lifestyle brand.

Current date/time: ${now}

Your mission: Research today's news, then submit 10–15 stories a cruise enthusiast would genuinely want to read. Brand fit and quality matter more than volume.

You have three tools:
1. fetch_rss_feed — fetch stories from a named RSS source
2. search_gnews — targeted news search (max 5 searches total)
3. submit_editorial_decisions — finalize and submit your list

════════════════════════════════════
MANDATORY RESEARCH PLAN — in this order, no skipping:
════════════════════════════════════

ROUND 1 — fetch all 4:
  fetch_rss_feed("Cruise Hive")
  fetch_rss_feed("Cruise Radio")
  fetch_rss_feed("Simple Flying")
  fetch_rss_feed("The Points Guy")

ROUND 2 — fetch all 3:
  fetch_rss_feed("Upgraded Points")
  fetch_rss_feed("Skift")
  search_gnews("cruise ship news this week")

ROUND 3 — only if you are missing Tier 3 or Tier 4 after reviewing Rounds 1+2:
  fetch_rss_feed("Conde Nast Traveler") or fetch_rss_feed("One Mile at a Time")
  search_gnews with a targeted query for your missing tier

After Rounds 1 and 2 are complete, call submit_editorial_decisions.

════════════════════════════════════
EDITORIAL TIERS:
════════════════════════════════════

Tier 1 — Direct Cruise Impact (3–5 stories, never more than 5):
  Itinerary changes, ship incidents, port closures/bans, cruise pricing/deals, loyalty changes, new ships, onboard incidents
  Sources: Cruise Hive, Cruise Radio, Cruise Industry News

Tier 2 — Travel Operations (2–4 stories):
  Airline disruptions, FAA/TSA policy, airport incidents, travel entry/visa changes, overtourism policies affecting cruise ports
  Sources: Simple Flying, Aviation Geek Club, Skift, Fox News Travel, CNN Travel

Tier 3 — Mainstream Relevant (1–2 stories):
  ONLY include if a cruise ship, cruise port, or cruise itinerary is specifically named:
    - A named hurricane or storm that cancels or reroutes a specific sailing
    - A disease outbreak confirmed ONBOARD a named cruise ship
    - A travel advisory that closes a specific cruise port of call
  DO NOT include: general disease news, city heatwaves, regional weather, health statistics, land-based outbreaks

Tier 4 — Lifestyle and Discovery (1–2 stories — REQUIRED):
  Cruise tips, cabin guides, loyalty hacks, destination features, packing advice, deal-finding strategies
  Sources: The Points Guy, Upgraded Points, One Mile at a Time, View From The Wing, Conde Nast Traveler
  NOTE: You MUST include at least 1 Tier 4 story. If you have none, fetch from The Points Guy before submitting.

════════════════════════════════════
HARD REJECTION RULES — skip these entirely:
════════════════════════════════════

Skip any story where:
- It is a weather story (heatwave, storm, flood) that does NOT name a specific cruise ship or port closure
- It is a disease/health story NOT set aboard a named cruise ship
- Multiple stories you have already selected cover the same topic, same ship, same airline, or same event — keep only the single best one
- It has no connection to cruising or leisure travel planning
- It is local/regional news with no traveler relevance

DEDUPLICATION: Before submitting, scan your selected list. Remove duplicate topics:
  - If 2+ stories are about the same disease, keep the one directly involving a cruise ship; drop the rest
  - If 2+ stories are about the same cruise line incident, keep the best-sourced one
  - If 2+ stories are about the same airline, keep only one
  Maximum 2 stories from any single source publication.

════════════════════════════════════
SUBMISSION REQUIREMENTS — will be rejected if not met:
════════════════════════════════════

Your submission MUST have ALL of the following:
  - At least 1 story from each of Tier 1, Tier 2, Tier 3, and Tier 4
  - No more than 5 Tier 1 stories total
  - At least 1 Tier 4 lifestyle story
  - Every story has a non-empty "link" set to the exact "url" from the tool result

════════════════════════════════════
SUMMARY WRITING — 4–6 sentences per story:
════════════════════════════════════

Cover: (1) what happened and who, (2) why/context, (3) scale/numbers, (4) impact on cruisers specifically, (5) actionable detail — date, dollar amount, port name, or booking consequence.

End on a concrete fact, not a vague observation.

NEVER write: "serves as a reminder", "underscores the importance", "highlights the importance", "could affect how travelers plan", "travelers should remain vigilant", "raises questions about".

Begin with Round 1 now.`;
}

// ─── Fallback ────────────────────────────────────────────────────────────────

function buildFallbackResponse(
  reason = "Agent loop did not produce editorial decisions"
) {
  return {
    stories: [],
    homepageTop5: [],
    groupedDevelopments: [],
    systemStatus: { degraded: true, reason },
  };
}

// ─── Summary post-processor ───────────────────────────────────────────────────
// Strips filler/moralizing sentences that GPT-4o-mini inserts despite instructions.

const BANNED_SENTENCE_PATTERNS = [
  /\bserves as a reminder\b/i,
  /\bserve as a reminder\b/i,
  /\bunderscores the importance\b/i,
  /\bhighlights the importance\b/i,
  /\bcould affect how (travelers|cruisers|passengers)\b/i,
  /\bmay (affect|influence|impact) (how )?(travelers|cruisers|passengers|travel(ers)?)\b/i,
  /\btravelers? should remain vigilant\b/i,
  /\braises questions about\b/i,
  /\bremind(s|ed)? (travelers|cruisers|passengers)\b/i,
  /^This incident [a-z]+ (the|a) (need|importance|role|potential)\b/i,
];

function cleanSummary(text: string): string {
  if (!text) return text;
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const cleaned = sentences.filter(
    (s) => !BANNED_SENTENCE_PATTERNS.some((re) => re.test(s))
  );
  return (cleaned.length > 0 ? cleaned : sentences).join(" ");
}

function cleanStories(stories: Record<string, unknown>[]): Record<string, unknown>[] {
  return stories.map((s) => ({
    ...s,
    summary: typeof s.summary === "string" ? cleanSummary(s.summary) : s.summary,
  }));
}

// ─── Main agent runner ───────────────────────────────────────────────────────

export async function runEditorialAgent({
  openai: apiKey,
}: {
  openai: string | undefined;
  stories?: Record<string, unknown>[];
}) {
  if (!apiKey) {
    return buildFallbackResponse("OPENAI_API_KEY not configured");
  }

  const gnewsKey = process.env["GNEWS_API_KEY"];
  const MAX_ITERATIONS = 8;
  let gnewsCallCount = 0;
  const MAX_GNEWS_CALLS = 5;
  let researchIterations = 0;

  const messages: OpenAIMessage[] = [
    { role: "system", content: buildSystemPrompt() },
  ];

  logger.info("Editorial agent starting autonomous research loop");

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    logger.info({ iteration }, "Agent iteration");

    // After 2 research rounds, inject a user nudge and force submission
    const forceSubmit = researchIterations >= 2;
    if (forceSubmit && messages[messages.length - 1]?.role !== "user") {
      const toolMessages = messages.filter((m) => m.role === "tool").length;
      messages.push({
        role: "user",
        content: `You have completed your research (${toolMessages} tool responses gathered). Now call submit_editorial_decisions with your best 10–15 stories. Apply the 4-tier framework strictly — quality over quantity.`,
      });
    }

    let response: Response;
    let payload: Record<string, unknown>;

    try {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.15,
          tools: TOOLS,
          tool_choice: forceSubmit
            ? { type: "function", function: { name: "submit_editorial_decisions" } }
            : "auto",
          messages,
        }),
        signal: AbortSignal.timeout(90000),
      });

      payload = await response.json() as Record<string, unknown>;
    } catch (err) {
      logger.error({ err, iteration }, "OpenAI call failed");
      return buildFallbackResponse(`OpenAI request failed: ${(err as Error).message}`);
    }

    if (!response.ok) {
      logger.error({ payload }, "OpenAI API error");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return buildFallbackResponse((payload as any)?.error?.message || `OpenAI error ${response.status}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const choice = (payload as any)?.choices?.[0];
    if (!choice) {
      return buildFallbackResponse("OpenAI response missing choices");
    }

    const { finish_reason, message } = choice;
    messages.push(message);

    // Always check for tool_calls FIRST — when tool_choice is forced, OpenAI
    // returns finish_reason="stop" even though tool_calls is populated.
    if (!message.tool_calls?.length) {
      // Genuine stop with no tool calls
      logger.warn({ iteration, finish_reason }, "Agent stopped without tool calls");
      break;
    }

    // Process each tool call in this iteration
    for (const toolCall of message.tool_calls as ToolCall[]) {
      const name = toolCall.function.name;
      let args: Record<string, unknown>;

      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ error: "Failed to parse arguments" }),
        });
        continue;
      }

      // ── submit_editorial_decisions → validate diversity then accept ──────
      if (name === "submit_editorial_decisions") {
        const submitted = (args.stories as Record<string, unknown>[]) || [];
        const tierCounts: Record<number, number> = {};
        for (const s of submitted) {
          const t = Number(s.tier);
          if (t >= 1 && t <= 4) tierCounts[t] = (tierCounts[t] || 0) + 1;
        }
        const total = submitted.length;
        const t1Count = tierCounts[1] || 0;
        const tiersPresent = Object.keys(tierCounts).length;
        const t1Pct = total > 0 ? t1Count / total : 0;

        logger.info({ total, tierCounts, t1Pct: Math.round(t1Pct * 100) }, "Agent submitted editorial decisions");

        // Reject if >60% Tier 1, or fewer than 3 tiers, or no Tier 4 — max 3 rejections
        const hasT4 = Boolean(tierCounts[4]);
        if ((t1Pct > 0.6 || tiersPresent < 3 || !hasT4) && researchIterations < 3) {
          const missingTiers = [1, 2, 3, 4].filter((t) => !tierCounts[t]);
          const feedback = `Submission rejected: tier distribution is unacceptable (${JSON.stringify(tierCounts)}, ${Math.round(t1Pct * 100)}% Tier 1). Missing tiers: ${missingTiers.join(", ") || "none"}. You MUST have at least 1 story from each of Tiers 1, 2, 3, and 4, and no more than 60% Tier 1. Fetch "The Points Guy" or "Upgraded Points" for Tier 4, and search GNews for a specific Tier 3 cruise-port event. Resubmit with the correct mix.`;
          logger.warn({ tierCounts, t1Pct, researchIterations }, "Tier diversity check failed — requesting more research");
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ status: "rejected", feedback }),
          });
          researchIterations++;
          continue;
        }

        return {
          stories: cleanStories((args.stories as Record<string, unknown>[]) || []),
          homepageTop5: args.homepageTop5 || [],
          groupedDevelopments: args.groupedDevelopments || [],
          systemStatus: {
            degraded: false,
            reason: "",
            tierCounts,
          },
        };
      }

      // ── search_gnews ─────────────────────────────────────────────────────
      if (name === "search_gnews") {
        const query = String(args.query || "");
        logger.info({ query, gnewsCallCount }, "Agent searching GNews");

        let result: Record<string, unknown>[];
        if (!gnewsKey) {
          result = [];
          logger.warn("GNews API key not configured — search returned empty");
        } else if (gnewsCallCount >= MAX_GNEWS_CALLS) {
          result = [];
          logger.warn({ gnewsCallCount }, "GNews call limit reached");
        } else {
          result = await toolSearchGnews(query, gnewsKey);
          gnewsCallCount++;
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ query, results: result, count: result.length }),
        });
        continue;
      }

      // ── fetch_rss_feed ───────────────────────────────────────────────────
      if (name === "fetch_rss_feed") {
        const feedName = String(args.name || "");
        logger.info({ feedName }, "Agent fetching RSS feed");
        const result = await toolFetchRss(feedName);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ feed: feedName, articles: result, count: result.length }),
        });
        continue;
      }

      // Unknown tool
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({ error: `Unknown tool: ${name}` }),
      });
    }

    researchIterations++;
  }

  logger.warn({ iterations: MAX_ITERATIONS }, "Agent loop exhausted without submitting");
  return buildFallbackResponse("Agent loop exhausted without submitting editorial decisions");
}
