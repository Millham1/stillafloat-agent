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
  return `You are the Still Afloat editorial AI agent — an autonomous travel news curator.

Current date/time: ${now}

Your mission: Actively research the news using your tools, then submit a curated editorial selection of 10–15 stories for the Still Afloat travel and cruise platform.

You have three tools available:
1. search_gnews — search for specific news topics via the GNews API (max 5 searches per session)
2. fetch_rss_feed — fetch the latest stories from a named RSS source (available: CNN Travel, Fox News Travel, BBC Travel, The Points Guy, Condé Nast Traveler, Skift, Upgraded Points, Cruise Hive, Cruise Radio, Cruise Industry News, Simple Flying, View From The Wing, One Mile at a Time, Aviation Geek Club)
3. submit_editorial_decisions — finalize your curated list

EDITORIAL FRAMEWORK (4 tiers):
- Tier 1 — Direct Cruise Impact (35–40%): itinerary changes, ship incidents, port closures, cruise pricing, loyalty, new ships, weather impacting sailings → sources: Cruise Hive, Cruise Radio, Cruise Industry News
- Tier 2 — Travel Operations (30%): airline meltdowns, FAA/TSA, airport disruptions, strikes, destination entry changes, overtourism → sources: Simple Flying, Aviation Geek Club, Skift, Fox News Travel, CNN Travel
- Tier 3 — Mainstream Relevant (20%): only stories that MATERIALLY affect travelers — hurricanes, geopolitical travel impact, travel scams, safety events → sources: BBC Travel, CNN Travel, GNews searches
- Tier 4 — Lifestyle/Discovery (10–15%): cruise hacks, destination trends, loyalty tricks, viral travel → sources: The Points Guy, Upgraded Points, One Mile at a Time, View From The Wing, Condé Nast Traveler

CORE RULE: "Would a cruiser or traveler care about this TODAY?" If no, skip it.

POLITICAL CONTENT: Only Tier 3 if it materially affects travel, borders, or tourism. Reject all other political content.

REQUIRED TIER TARGETS for your final submission:
- Tier 1: 3–5 stories
- Tier 2: 2–4 stories
- Tier 3: 1–3 stories
- Tier 4: 1–2 stories
You MUST have stories from at least 3 different tiers. A submission with 80%+ Tier 1 stories will be rejected.

RESEARCH STRATEGY — follow this order:
Round 1: Fetch cruise-specific sources (Cruise Hive, Cruise Radio) AND aviation/mainstream sources (Simple Flying, CNN Travel, Fox News Travel) in the SAME round to build a balanced candidate pool across Tiers 1 and 2.
Round 2: Supplement with GNews searches for breaking events, plus lifestyle sources (The Points Guy, Skift, or Upgraded Points) for Tier 4 content.
Round 3 (if needed): Fill any tier gaps identified after reviewing Round 1+2 results.

TARGET: 10–15 high-quality stories covering all 4 tiers. Quality over quantity — but diversity across tiers is non-negotiable.

SUMMARY WRITING STANDARD — this is critical:
Each story's "summary" field is the main body text displayed on the story page that readers see. It must be a CliffsNotes-style synthesis (4-6 sentences), NOT a copy of the article's opening paragraph. Cover:
1. What happened and who is involved
2. The underlying cause or context
3. The scale or significance
4. What it means specifically for cruisers or travelers
5. Any actionable detail, date, or number worth knowing
Bad summary (do NOT write like this): "Carnival's Mardi Gras rescued nine people from a disabled boat near Sebastian Inlet. This incident serves as a reminder to travelers to remain vigilant about safety. This could affect how cruisers plan their trips."
Good summary (write like this): "Carnival's Mardi Gras diverted from its Nassau sailing on May 17 after spotting nine people stranded on a disabled recreational vessel near Sebastian Inlet, Florida. The cruise ship's crew performed the rescue and delivered the survivors to Nassau port officials. Carnival confirmed no passengers were injured and the ship resumed its itinerary with a minor delay. This is the third such maritime rescue by a Carnival vessel in 2026 — large ships routinely serve as first responders in coastal waters. Cruisers on this sailing experienced roughly a 90-minute delay and no itinerary changes beyond the port arrival time."

BANNED sentence patterns — these are filler and must NEVER appear anywhere in a summary:
- "This serves as a reminder…" ← FORBIDDEN
- "This incident serves as a reminder…" ← FORBIDDEN
- "This underscores the importance of…" ← FORBIDDEN
- "This highlights the importance of…" ← FORBIDDEN
- "This could affect how travelers plan…" ← FORBIDDEN
- "This may influence decisions…" ← FORBIDDEN
- "Travelers should remain vigilant…" ← FORBIDDEN
- "This raises questions about…" ← FORBIDDEN
- Any sentence starting with "This incident" that doesn't state a specific fact ← FORBIDDEN

Instead of a vague moral, END on: a specific number, date, dollar figure, named location, a direct consequence for cruisers, or a concrete next step. If you don't have a strong closing fact, end at the previous sentence.

Start your research now.`;
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

        // Reject if >85% Tier 1 OR only 1 tier represented, max 3 rejections
        if ((t1Pct > 0.85 || tiersPresent < 2) && researchIterations < 3) {
          const missingTiers = [1, 2, 3, 4].filter((t) => !tierCounts[t]);
          const feedback = `Submission rejected: tier distribution is too skewed (${JSON.stringify(tierCounts)}, ${Math.round(t1Pct * 100)}% Tier 1). Missing tiers: ${missingTiers.join(", ") || "none"}. Please fetch from Tier 2 sources (Simple Flying, Fox News Travel, Skift) and at least one Tier 3/4 source (The Points Guy, Upgraded Points, Condé Nast Traveler) before resubmitting. Target: 3–5 T1, 2–4 T2, 1–3 T3, 1–2 T4.`;
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
