import { logger } from "./logger";

const EDITORIAL_DIRECTIVE = `
You are the autonomous editorial intelligence system for Still Afloat.

You are NOT a generic news summarizer.
You are a cruise and travel editorial intelligence agent.

Always prioritize:
- cruise operational impacts
- airline disruptions affecting cruisers
- itinerary changes
- embarkation problems
- weather systems impacting ports
- FAA disruptions
- traveler advisories
- loyalty and pricing changes

Reject:
- celebrity gossip
- irrelevant local crime
- airport gossip
- clickbait
- duplicate weather spam
- low-value filler stories

Quality matters more than quantity.

Each approved story must include:
- title
- category
- impactLevel
- travelerImpact
- summary
- homepageCandidate
- reasoning
- sourceAttribution

Return a json object with: stories (array), homepageTop5 (array), groupedDevelopments (array), rejectedStories (array), systemStatus (object with degraded bool and reason string).
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFallbackResponse(stories: Record<string, any>[] = [], reason = "AI orchestration unavailable") {
  return {
    stories: stories.slice(0, 5).map((story, index) => ({
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
        temperature: 0.15,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: EDITORIAL_DIRECTIVE },
          { role: "user", content: JSON.stringify({ stories }) },
        ],
      }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = await response.json() as any;

    if (!response.ok) {
      logger.error({ status: response.status, payload }, "OpenAI API Error");
      return buildFallbackResponse(
        stories,
        payload?.error?.message || `OpenAI request failed with status ${response.status}`
      );
    }

    if (!payload?.choices?.length) {
      logger.error({ payload }, "OpenAI response missing choices");
      return buildFallbackResponse(stories, "OpenAI response missing choices array");
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      return buildFallbackResponse(stories, "OpenAI response missing message content");
    }

    return JSON.parse(content);
  } catch (error) {
    logger.error({ err: error }, "Editorial agent orchestration failure");
    return buildFallbackResponse(stories, (error as Error).message);
  }
}
