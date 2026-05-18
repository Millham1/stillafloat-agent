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
                travelerImpact: { type: "string", description: "1-2 sentences: what does this mean for a traveler?" },
                summary: { type: "string", description: "2-3 sentence factual summary, mobile-friendly" },
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
      desc: truncate(item.contentSnippet || item.summary || "", 160),
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
- Tier 1 — Direct Cruise Impact (35–40%): itinerary changes, ship incidents, port closures, cruise pricing, loyalty, new ships, weather impacting sailings
- Tier 2 — Travel Operations (30%): airline meltdowns, FAA/TSA, airport disruptions, strikes, destination entry changes, overtourism
- Tier 3 — Mainstream Relevant (20%): only stories that MATERIALLY affect travelers — hurricanes, geopolitical travel impact, travel scams, safety events
- Tier 4 — Lifestyle/Discovery (10–15%): cruise hacks, destination trends, loyalty tricks, viral travel

CORE RULE: "Would a cruiser or traveler care about this TODAY?" If no, skip it.

POLITICAL CONTENT: Only Tier 3 if it materially affects travel, borders, or tourism. Reject all other political content.

RESEARCH STRATEGY:
1. Start with the most impactful sources for today — cruise-specific feeds for Tier 1, aviation/mainstream for Tier 2
2. Run targeted GNews searches for any specific breaking news you suspect (major weather events, airline disruptions, cruise incidents)
3. Supplement with lifestyle/loyalty sources for Tier 4 diversity
4. When you have 20–40 stories reviewed, submit your best 10–15

TARGET: 10–15 high-quality stories. Do not pad with weak stories. Quality over quantity.

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

      // ── submit_editorial_decisions → we're done ──────────────────────────
      if (name === "submit_editorial_decisions") {
        logger.info(
          { storyCount: (args.stories as unknown[])?.length },
          "Agent submitted editorial decisions"
        );
        return {
          stories: args.stories || [],
          homepageTop5: args.homepageTop5 || [],
          groupedDevelopments: args.groupedDevelopments || [],
          systemStatus: { degraded: false, reason: "" },
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
