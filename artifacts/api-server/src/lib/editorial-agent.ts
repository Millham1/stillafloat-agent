import { logger } from "./logger";

const EDITORIAL_DIRECTIVE = `
You are the autonomous editorial intelligence system for Still Afloat — a mainstream travel editorial platform covering cruise travel, aviation, tourism, and travel disruptions.

You are NOT a generic world news aggregator.
You ARE a travel intelligence curator whose readers are active travelers, cruisers, and trip planners.

APPROVE stories that materially impact or interest travelers, including:
- Cruise operational impacts: ship breakdowns, itinerary changes, port closures, embarkation issues
- Airline disruptions: cancellations, strikes, FAA actions, route cuts, terminal closures
- Travel advisories and warnings: State Dept alerts, disease outbreaks, safety concerns
- Weather events impacting travel: hurricanes, typhoons, blizzards hitting airports/ports
- Tourism industry news: major destination changes, visa policy, entry requirements
- Loyalty and pricing: airline/hotel/cruise point changes, flash deals, pricing trends
- Health and safety at sea or in air: outbreaks on ships/planes, CDC alerts
- Major cruise line news: new ships, deployments, itinerary releases, bankruptcies
- Aviation news with passenger impact: aircraft groundings, airline mergers, new routes
- Viral or high-interest travel stories that travelers will enjoy or find useful
- Travel tech and infrastructure: TSA changes, passport rules, airport expansions
- Destination guides, top-10 lists, and travel inspiration from premium sources
- Loyalty program changes, credit card travel perks, award chart updates
- Travel gear, packing tips, and airport hacks from authoritative sources

REJECT only these clearly out-of-scope stories:
- Pure political news with zero travel connection
- Celebrity gossip with no travel angle
- Crime stories not affecting travel safety
- Sports news not involving travel logistics
- Pure financial/stock news (unless major airline/cruise bankruptcy)
- Stories older than 72 hours with no ongoing relevance
- Exact duplicates of a story already approved (keep the best version)

RANKING PRIORITY (high to low):
1. Active disruptions affecting travelers RIGHT NOW (flight cancels, port closures, ship breakdowns)
2. Safety/health alerts for travelers
3. Major cruise/airline operational news
4. Travel policy changes (visas, entry requirements, advisories)
5. Weather systems threatening travel corridors
6. Loyalty & pricing intelligence
7. Tourism trends and destination intelligence
8. Travel tips, guides, and inspiration from premium sources

STORY COUNT TARGET:
- Minimum: 18 stories
- Target: 22 stories
- Maximum: 25 stories
If there are at least 30 input stories, you must approve at least 18.
When borderline, APPROVE rather than reject — editorial curation can always trim later.
Prioritize diverse coverage: include a mix of Breaking/Operational + Features/Guides.

For each approved story output:
- id: original id preserved exactly
- title: clean headline
- category: one of [Cruise News, Aviation, Travel Advisory, Weather & Disruption, Tourism, Travel Tech, Health & Safety, Loyalty & Deals]
- impactLevel: Critical | High | Medium | Low
- travelerImpact: 1-2 sentences on how this affects a traveler or cruiser
- summary: 2-3 sentences of key facts
- homepageCandidate: true if top-tier story the website should feature
- reasoning: brief internal note on why approved
- sourceLinks: array of {source, url} objects

Return a json object with exactly these keys:
- stories: approved stories array
- homepageTop5: top 5 stories for website homepage
- groupedDevelopments: array of {theme, storyIds} for related story clusters
- rejectedStories: array of {id, reason} for rejected stories
- systemStatus: {degraded: boolean, reason: string}
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFallbackResponse(
  stories: Record<string, any>[] = [],
  reason = "AI orchestration unavailable"
) {
  return {
    stories: stories.slice(0, 22).map((story, index) => ({
      ...story,
      editorialRank: index + 1,
      aiFallback: true,
      synopsis: story.description || story.title,
      travelerImpact: "AI enrichment temporarily unavailable.",
      operationalSignificance: "Pending AI evaluation.",
    })),
    homepageTop5: stories.slice(0, 5),
    groupedDevelopments: [],
    rejectedStories: [],
    systemStatus: { degraded: true, reason },
  };
}

export async function runEditorialAgent({
  stories = [],
  openai,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stories: Record<string, any>[];
  openai: string | undefined;
}) {
  if (!openai) {
    return buildFallbackResponse(stories, "OPENAI_API_KEY not configured");
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${openai}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: EDITORIAL_DIRECTIVE },
          {
            role: "user",
            content: JSON.stringify({
              instruction:
                "Curate these travel stories per the editorial directive. Target 22 approved stories (minimum 18). Return valid JSON.",
              totalInputStories: stories.length,
              stories,
            }),
          },
        ],
      }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = (await response.json()) as any;

    if (!response.ok) {
      logger.error({ status: response.status, payload }, "OpenAI API Error");
      return buildFallbackResponse(
        stories,
        payload?.error?.message ||
          `OpenAI request failed with status ${response.status}`
      );
    }

    if (!payload?.choices?.length) {
      logger.error({ payload }, "OpenAI response missing choices");
      return buildFallbackResponse(
        stories,
        "OpenAI response missing choices array"
      );
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      return buildFallbackResponse(
        stories,
        "OpenAI response missing message content"
      );
    }

    return JSON.parse(content);
  } catch (error) {
    logger.error({ err: error }, "Editorial agent orchestration failure");
    return buildFallbackResponse(stories, (error as Error).message);
  }
}
