import { logger } from "./logger";
import Parser from "rss-parser";
import { PATHS, readJson, writeJson } from "./persistence";

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
              "Cruise Fever",
              "Simple Flying",
              "View From The Wing",
              "One Mile at a Time",
              "Aviation Geek Club",
              // Spanish-language sources (used when lang=es)
              "La Vanguardia Viajes",
              "Nat Geo Viajes",
              "Clarín Viajes",
              "Milenio Turismo",
              "El Universal Turismo",
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
        "Submit your final curated list of stories for publication. Call this when you have reviewed enough sources and are confident in your 15–20 story selection. You MUST call this to complete the editorial run.",
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
                  description: "CliffsNotes-style deep summary — MINIMUM 4 full sentences, target 5-7 sentences (100-160 words). A 1-2 sentence response is NEVER acceptable. Do NOT copy-paste or lightly rephrase the article headline or lead. Instead write a genuine paragraph that synthesizes: (1) What happened and who is involved — with specifics (ship name, company, dollar amount, port, date). (2) The underlying cause or context — why did this happen? (3) The scale or significance — how big a deal is this? (4) What it means specifically for cruisers or travelers — practical impact. (5) Any action, deadline, or concrete detail worth knowing. Write as if briefing a busy editor who hasn't read the article — factual, specific, human. If you only have a headline and short blurb to work from, use your knowledge of the cruise industry to fill in context and make the summary stand on its own.",
                },
                homepageCandidate: { type: "boolean" },
                reasoning: { type: "string", description: "2-3 sentences in a personal, opinionated editorial voice — written as if Mark is telling a friend why they should read this. Be specific: mention the concrete detail (ship name, dollar figure, quote, ironic twist) that makes it worth clicking. This text appears on the website as 'Why This Matters'. NEVER write: 'This story is relevant for cruisers', 'provides important information', 'it is important to note', or any other generic opening." },
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
  "Cruise Fever": "https://www.cruisefever.net/feed/",
  // Spanish-language sources
  "La Vanguardia Viajes": "https://www.lavanguardia.com/rss/ocio/viajes.xml",
  "Nat Geo Viajes": "https://viajes.nationalgeographic.com.es/rss",
  "Clarín Viajes": "https://www.clarin.com/rss/viajes/",
  "Milenio Turismo": "https://www.milenio.com/rss/turismo",
  "El Universal Turismo": "https://www.eluniversal.com.mx/rss/turismo.xml",
};

const rssParser = new Parser({ timeout: 8000 });

// ─── Tool executors ──────────────────────────────────────────────────────────

function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max) + "…";
}

async function toolSearchGnews(
  query: string,
  apiKey: string,
  lang: "en" | "es" = "en"
): Promise<Record<string, unknown>[]> {
  try {
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=${lang}&max=8&apikey=${apiKey}`;
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
    return (feed.items || []).slice(0, 15).map((item) => ({
      title: truncate(item.title, 120),
      desc: truncate(item.contentSnippet || item.summary || "", 800),
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

function buildSystemPrompt(lang: "en" | "es" = "en", learnedPrefs?: string): string {
  const now = new Date().toUTCString();

  const learnedSection = learnedPrefs ? `
════════════════════════════════════
LEARNED EDITORIAL PREFERENCES (from Mark's approve/reject history):
════════════════════════════════════

${learnedPrefs}

Apply these preferences when selecting and prioritizing stories. They override generic tier guidance where they conflict.
` : "";

  const langInstruction = lang === "es"
    ? `\n════════════════════════════════════\nLANGUAGE REQUIREMENT\n════════════════════════════════════\n\nWrite ALL output fields — title, summary, travelerImpact, and reasoning — in Latin American Spanish (es-419). Use a warm, practical, tropical tone that matches the brand. Port names, ship names, and cruise line names stay in their original language. Do NOT translate proper nouns.\n`
    : "";

  return `You are the Still Afloat editorial AI agent — the voice of a cruise lifestyle brand built for people who love the sea, the sun, and the smell of sunscreen on the Lido deck.

Current date/time: ${now}${langInstruction}${learnedSection}

════════════════════════════════════
WHO STILL AFLOAT IS
════════════════════════════════════

Owner: Mark Millham — retired IT Senior Manager, veteran, former liveaboard sailor, North Carolina.
Brand vibe: Jimmy Buffett × Kenny Chesney × tropical premium resort.
Tagline: "Cruise smarter. Laugh more. Stay Afloat."
Audience: Cruisers aged 45–70, many retired or semi-retired, who have taken 5–30 cruises. They are experienced, enthusiastic, a little salty, and they love a good sea story.

════════════════════════════════════
YOUR ROLE — BROAD FILTER, NOT TIGHT CURATOR
════════════════════════════════════

Your job is to gather a wide pool of 15–18 relevant stories for Mark to review. Mark does the final curation — he will approve, feature, or reject each story himself. Your job is to be an INCLUSIVE filter, not an exclusive one.

INCLUDE a story if it passes ANY of these:
  ✓ Something an experienced cruiser would want to know (news, deals, incidents, changes)
  ✓ Something that makes them smile, feel nostalgic, or dream about cruising
  ✓ Practical tips or destination content worth bookmarking
  ✓ Travel operations that affect getting to/from a cruise
  ✓ Lifestyle or human-interest story from the cruising world

WHAT GREAT TIER 4 LOOKS LIKE (actively seek these):
  ★ "Retired teachers in their 30s live on cruise ships full-time for a little over $10K a year" — aspirational, warm, specific
  ★ "I didn't think cruising was for me until I tried an adults-only voyage" — first-person, inviting, human
  ★ "Starlink changes the cruising lifestyle for better or worse" — practical angle on cruise life
  ★ "How one guest turned his Disney Cruise sea days into a world record" — quirky human interest, shareable

EXCLUDE ONLY these:
  ✗ General weather / disease / disaster news with zero cruise connection
  ✗ Pure finance or stock market news
  ✗ Purely local/city news with no travel or cruise angle
  ✗ Exact duplicate of another story already in your list (same event, same outcome)

When in doubt, INCLUDE IT. Mark will decide. Aim for 15–18 stories total.

${lang === "es" ? `════════════════════════════════════
PLAN DE INVESTIGACIÓN OBLIGATORIO — en este orden, sin saltarse pasos:
════════════════════════════════════

RONDA 1 — obtener las 5 fuentes en español (obligatorio):
  fetch_rss_feed("La Vanguardia Viajes")
  fetch_rss_feed("Nat Geo Viajes")
  fetch_rss_feed("Clarín Viajes")
  fetch_rss_feed("Milenio Turismo")
  fetch_rss_feed("El Universal Turismo")

RONDA 2 — búsquedas GNews en español (obligatorio):
  search_gnews("crucero caribe itinerario pasajeros cambio")
  search_gnews("aerolínea cancelación vuelo viajero Latinoamérica")
  search_gnews("crucero Royal Caribbean Carnival MSC Norwegian")
  search_gnews("turismo destino playa isla crucero")

RONDA 3 — completar hasta alcanzar 12–18 historias:
  search_gnews("puerto crucero Caribe México América Central")
  search_gnews("viaje vacaciones consejo crucero estilo de vida")
  fetch_rss_feed("Cruise Hive")
  fetch_rss_feed("Cruise Radio")

Después de las 3 Rondas, llama a submit_editorial_decisions.` : `════════════════════════════════════
MANDATORY RESEARCH PLAN — in this order, no skipping:
════════════════════════════════════

ROUND 1 — fetch all 6 (no skipping):
  fetch_rss_feed("Cruise Hive")
  fetch_rss_feed("Cruise Radio")
  fetch_rss_feed("Cruise Industry News")
  fetch_rss_feed("Cruise Fever")
  fetch_rss_feed("The Points Guy")
  fetch_rss_feed("Upgraded Points")

ROUND 2 — fetch all 5 + run 2 GNews searches (no skipping):
  fetch_rss_feed("Condé Nast Traveler")
  fetch_rss_feed("Fox News Travel")
  fetch_rss_feed("One Mile at a Time")
  fetch_rss_feed("CNN Travel")
  fetch_rss_feed("Skift")
  search_gnews("cruise ship vacation tips passengers experience")
  search_gnews("cruise ship personal story OR funny OR surprising")

ROUND 3 — choose your own searches based on what's missing:
  Look at what you've gathered so far. What topics are underrepresented?
  Run 3 GNews searches of YOUR choosing to fill the gaps. Good examples:
    - If you have no feel-good stories: search "cruise ship passengers heartwarming story"
    - If you have no destination content: search "Caribbean cruise port hidden gem"
    - If you have no deals: search "cruise line sale discount announcement"
    - If you have no Tier 3 stories yet: search "cruise ship viral moment funny"
  Pick the 3 searches that will most help you reach 15–18 well-rounded stories.

After all 3 Rounds are complete, call submit_editorial_decisions.`}

════════════════════════════════════
EDITORIAL TIERS:
════════════════════════════════════

Tier 1 — Direct Cruise Impact (3–5 stories, never more than 5):
  Itinerary changes, ship incidents, port closures/bans, cruise deals/pricing moves, new ships, onboard incidents worth knowing
  Sources: Cruise Hive, Cruise Radio, Cruise Industry News
  Brand filter: Must be something Mark would text a cruising friend about

Tier 2 — Travel Operations (0–1 stories MAX):
  Only include if it directly affects getting to or from a cruise — a major airport closure on an embarkation day, a visa/entry change for a cruise port, or a TSA/border policy that impacts cruise passengers.
  Pure airline/aviation news with no cruise connection is EXCLUDED entirely.
  Sources: Skift, Fox News Travel, CNN Travel
  Brand filter: Ask yourself — "Would a cruiser who never flies care about this?" If yes, consider it. If it's purely aviation ops, skip it.

Tier 3 — Mainstream & Feel-Good (2–5 stories — actively seek these):
  TWO types qualify here:

  a) CRISIS with a cruise angle: A storm canceling a specific sailing, a disease outbreak confirmed onboard a named ship, a travel advisory closing a specific cruise port. Keep hard exclusions: no general weather, no land-based disease, no city news.

  b) FEEL-GOOD & ASPIRATIONAL from mainstream outlets (CNN Travel, BBC Travel, Fox News Travel, Condé Nast, AP, Reuters): Stories that make a cruiser smile, dream, or feel nostalgic — even if no specific ship is named. Examples:
    ★ "Retirees are ditching assisted living for cruise ships" — CNN Travel
    ★ "The hidden Caribbean island only reachable by cruise ship" — Condé Nast
    ★ "Why Gen X is rediscovering cruising after 20 years" — BBC Travel
    ★ "Cruise passengers rescue a fisherman stranded at sea" — AP
    ★ "This couple has taken 400 cruises and counting" — Fox News Travel
  The test: Would a cruiser share this on Facebook? If yes, include it.

Tier 4 — Lifestyle, Stories & Discovery (2–3 stories — REQUIRED, this is the HEART of the brand):
  This tier is the warm center of Still Afloat. Prioritize in this order:
    1. Human-interest and personal stories about cruise life (liveaboards, dream cruises, viral moments)
    2. Destination features, itinerary inspiration, "why you need to sail here" content
    3. Practical cruise tips, cabin secrets, packing wisdom from experienced cruisers
    4. Loyalty hacks and points strategies with a personal/story angle (not dry list articles)
  Sources: The Points Guy, Upgraded Points, One Mile at a Time, View From The Wing, Condé Nast Traveler, GNews lifestyle search
  NOTE: You MUST include at least 2 Tier 4 stories. If you only have 1, search_gnews("cruising lifestyle") before submitting.
  AVOID: Generic credit card listicles with no cruise/travel story hook

════════════════════════════════════
HARD REJECTION RULES — skip these entirely:
════════════════════════════════════

Skip any story where:
- It is a weather story (heatwave, storm, flood) that does NOT name a specific cruise ship or port closure
- It is a disease/health story NOT set aboard a named cruise ship
- Multiple stories you have already selected cover the same topic, same ship, same airline, or same event — keep only the single best one
- It has no connection to cruising or leisure travel
- It is local/regional news with no traveler relevance
- It reads like a B2B press release or investor briefing with no reader value

DEDUPLICATION: Before submitting, scan your selected list. Remove duplicate topics:
  - If 2+ stories cover the same disease/health topic, keep only the one aboard a named ship
  - If 2+ stories cover the same cruise line incident, keep the best-sourced one
  - If 2+ stories cover the same airline, keep only one
  Prefer variety of sources, but quality wins over source diversity.

════════════════════════════════════
SUBMISSION REQUIREMENTS — will be rejected if not met:
════════════════════════════════════

Your submission MUST have ALL of the following:
  - At least 15 stories total (aim for 16–18 — Mark needs a deep queue to choose from)
  - Tier 1 and Tier 4 both represented
  - No more than 9 Tier 1 stories total (keep some breathing room for other tiers)
  - At least 3 Tier 4 lifestyle/human-interest stories
  - Tier 2 is welcome if you find good ones, but NOT required
  - Every story has a non-empty "link" set to the exact "url" from the tool result

If you have fewer than 15 stories after Round 2, you MUST do Round 3 to find more. Do not submit under 15.

════════════════════════════════════
SUMMARY WRITING — 4–6 sentences per story:
════════════════════════════════════

Write in the voice of a smart, friendly cruise enthusiast briefing another one — not a wire-service journalist. Be specific, be human, find the interesting angle.

For Tier 1/2 stories: Cover (1) what happened and who, (2) why/context, (3) scale, (4) what it means for cruisers specifically, (5) any date, dollar amount, or port name worth knowing.
For Tier 4 stories: Lead with the human or aspirational angle. Make the reader feel something — curiosity, warmth, or FOMO. Then give the practical details.

End on a concrete fact or a moment that sticks, not a vague observation.

NEVER write: "serves as a reminder", "underscores the importance", "highlights the importance", "could affect how travelers plan", "travelers should remain vigilant", "raises questions about", "it remains to be seen".

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
  /\btravelers? should (be aware|stay informed|note that|keep in mind)\b/i,
  /\bthis story (is relevant|provides|highlights|underscores|offers)\b/i,
  /\bthis story is (relevant|important)\b/i,
  /\bit is important to note\b/i,
  /\bprovides important information\b/i,
  /\bmaking it (a )?(relevant|important|key|timely)\b/i,
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

// ─── Feedback loop: learn from Mark's approve/reject decisions ───────────────

export async function learnFromDecisions(apiKey: string): Promise<void> {
  try {
    const [approved, candidates] = await Promise.all([
      readJson<{ stories?: Record<string, unknown>[] }>(PATHS.approved, { stories: [] }),
      readJson<{ stories?: Record<string, unknown>[] }>(PATHS.candidates, { stories: [] }),
    ]);

    const approvedStories = (approved.stories || []).slice(0, 40);
    const rejectedStories = (candidates.stories || [])
      .filter((s) => s.status === "rejected")
      .slice(0, 40);

    if (approvedStories.length + rejectedStories.length < 5) {
      logger.info("Not enough decisions yet to learn from — skipping");
      return;
    }

    const prompt = `You are analyzing editorial decisions for the Still Afloat cruise news site owned by Mark Millham.

APPROVED stories (Mark approved these for publication):
${approvedStories.map((s) => `- [Tier ${s.tier ?? "?"}] [${s.category ?? "?"}] ${s.title} (${s.source ?? "?"})`).join("\n")}

REJECTED stories (Mark rejected these):
${rejectedStories.length > 0
  ? rejectedStories.map((s) => `- [Tier ${s.tier ?? "?"}] [${s.category ?? "?"}] ${s.title} (${s.source ?? "?"})`).join("\n")
  : "(none rejected yet)"}

Based on these decisions, write a concise "learned editorial preferences" note (150–200 words) for future AI scans that:
1. Describes what types of stories Mark consistently approves — be specific about topics, tones, and sources
2. Describes what types he avoids or rejects
3. Gives 2–3 actionable search guidance points (e.g. "Prioritize stories about X", "Avoid Y unless Z")
4. Notes any patterns in tier, category, or framing

Write in second person addressed to the AI agent ("You have learned that Mark prefers..."). Be specific and concrete — generic guidance is useless.`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, "learnFromDecisions: OpenAI call failed");
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = await res.json() as any;
    const content: string = payload?.choices?.[0]?.message?.content || "";
    if (!content) return;

    await writeJson(PATHS.learnedPrefs, {
      generatedAt: new Date().toISOString(),
      preferences: content,
      basedOn: {
        approvedCount: approvedStories.length,
        rejectedCount: rejectedStories.length,
      },
    });

    logger.info(
      { approvedCount: approvedStories.length, rejectedCount: rejectedStories.length },
      "Editorial preferences learned and saved"
    );
  } catch (err) {
    logger.warn({ err }, "learnFromDecisions failed — non-fatal");
  }
}

// ─── Main agent runner ───────────────────────────────────────────────────────

export async function runEditorialAgent({
  openai: apiKey,
  lang = "en",
}: {
  openai: string | undefined;
  stories?: Record<string, unknown>[];
  lang?: "en" | "es";
}) {
  if (!apiKey) {
    return buildFallbackResponse("OPENAI_API_KEY not configured");
  }

  const gnewsKey = process.env["GNEWS_API_KEY"];
  const MAX_ITERATIONS = 18;
  let gnewsCallCount = 0;
  const MAX_GNEWS_CALLS = 8;
  let researchIterations = 0;

  // Load learned preferences from prior approve/reject decisions
  const learnedData = await readJson<{ preferences?: string }>(PATHS.learnedPrefs, {});
  const learnedPrefs = learnedData.preferences || undefined;
  if (learnedPrefs) {
    logger.info("Loaded learned editorial preferences for this scan");
  }

  const messages: OpenAIMessage[] = [
    { role: "system", content: buildSystemPrompt(lang, learnedPrefs) },
  ];

  logger.info("Editorial agent starting autonomous research loop");

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    logger.info({ iteration }, "Agent iteration");

    // After 3 research rounds, inject a user nudge and force submission
    const forceSubmit = researchIterations >= 3;
    if (forceSubmit && messages[messages.length - 1]?.role !== "user") {
      const toolMessages = messages.filter((m) => m.role === "tool").length;
      messages.push({
        role: "user",
        content: `You have completed all 3 research rounds (${toolMessages} tool responses gathered). Now call submit_editorial_decisions. MINIMUM 15 stories — the queue must have depth for Mark to curate from. Include every cruise-relevant story you found across ALL sources you fetched, not just Cruise Hive. Tier 4 lifestyle stories are especially valuable — include any you found. Do not self-filter aggressively; Mark will do the final curation.`,
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
        signal: AbortSignal.timeout(150000),
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

        // Reject if count < 15, >50% Tier 1, missing Tier 1/2/4, or fewer than 2 Tier 4 stories — max 3 rejections
        const t4Count = tierCounts[4] || 0;
        const hasTier1 = Boolean(tierCounts[1]);
        const needsMoreT4 = t4Count < 2;
        const tooFewStories = total < 10;
        const failsDiversity = tooFewStories || t1Pct > 0.6 || !hasTier1 || needsMoreT4;
        if (failsDiversity && researchIterations < 3) {
          const issues: string[] = [];
          if (tooFewStories) issues.push(`only ${total} stories submitted (need at least 10)`);
          if (t1Pct > 0.6) issues.push(`${Math.round(t1Pct * 100)}% Tier 1 (max 60% — add more Tier 3/4 variety)`);
          if (!hasTier1) issues.push("no Tier 1 stories — check Cruise Hive, Cruise Radio, Cruise Industry News");
          if (needsMoreT4) issues.push(`only ${t4Count} Tier 4 story — need at least 2 feel-good/lifestyle/human-interest stories`);
          const feedback = `Submission rejected: ${issues.join("; ")}. Current distribution: ${JSON.stringify(tierCounts)}. TARGET: 15–18 stories — Tier 1 (4–6 cruise ops), Tier 2 (0–1 travel ops only if cruise-adjacent), Tier 3 (2–5 feel-good OR crisis-with-cruise-angle), Tier 4 (2–4 lifestyle/human-interest). Search GNews for feel-good angles like "cruise passengers heartwarming" or "cruise ship funny viral" to fill Tier 3/4. Resubmit with at least 15 stories.`;
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
          result = await toolSearchGnews(query, gnewsKey, lang);
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
