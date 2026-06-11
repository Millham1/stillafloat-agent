const directive = require('./editorial-directive');

function buildFallbackResponse(stories = [], reason = 'AI orchestration unavailable') {
  return {
    stories: stories.slice(0, 5).map((story, index) => ({
      ...story,
      editorialRank: index + 1,
      aiFallback: true,
      synopsis: story.description || story.title,
      travelerImpact: 'AI enrichment temporarily unavailable.',
      operationalSignificance: 'Pending AI evaluation.'
    })),
    homepageTop5: stories.slice(0, 5),
    groupedDevelopments: [],
    rejectedStories: [],
    systemStatus: {
      degraded: true,
      reason
    }
  };
}

// Compact a stored story down to just the signal the model needs to learn from.
function toExample(story = {}) {
  return {
    title: story.title,
    category: story.category,
    source: (story.sources || story.sourceAttribution || [])[0] || story.source || null,
    reason: story.rejectionReason || story.reasoning || null
  };
}

function buildMemoryMessage(editorialMemory = {}) {
  const approved = (editorialMemory.approvedStories || []).slice(0, 25).map(toExample);
  const rejected = (editorialMemory.rejectedStories || []).slice(0, 25).map(toExample);
  const publishedTitles = (editorialMemory.approvedStories || [])
    .slice(0, 120)
    .map(story => story.title)
    .filter(Boolean);

  return `EDITORIAL MEMORY — learn from the editor's past decisions. This is the difference between a fresh start and an agent that improves.

APPROVED before (favor similar topics, sources, and angles):
${JSON.stringify(approved)}

REJECTED before (avoid similar topics, sources, and angles; treat the stated reasons as standing editorial guidance):
${JSON.stringify(rejected)}

ALREADY PUBLISHED in prior runs (do NOT re-surface the same development; if a candidate covers one of these events, reject it as a cross-run duplicate):
${JSON.stringify(publishedTitles)}

SOURCE DIVERSITY IS MANDATORY: never let a single cruise line or outlet dominate the run. If many candidates cover the same brand (e.g. one cruise line), select only the one or two most significant and reject the rest as redundant. Actively surface mainstream and operational/weather stories that affect travelers, not just cruise-trade coverage.

Return a JSON object with exactly this top-level shape:
{ "stories": [ ...selected stories, ranked best-first... ],
  "homepageTop5": [ ...up to 5 of the strongest... ],
  "groupedDevelopments": [ ...optional clusters of related items... ],
  "rejectedStories": [ ...each with a "reasoning" field stating why... ] }`;
}

async function runEditorialAgent({ stories = [], openai, editorialMemory = {} }) {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${openai}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.15,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: directive
          },
          {
            role: 'system',
            content: buildMemoryMessage(editorialMemory)
          },
          {
            role: 'user',
            content: JSON.stringify({ stories })
          }
        ]
      })
    });

    const payload = await response.json();

    if (!response.ok) {
      console.error('OpenAI API Error:', {
        status: response.status,
        payload
      });

      return buildFallbackResponse(
        stories,
        payload?.error?.message || `OpenAI request failed with status ${response.status}`
      );
    }

    if (!payload?.choices?.length) {
      console.error('OpenAI response missing choices:', payload);

      return buildFallbackResponse(
        stories,
        'OpenAI response missing choices array'
      );
    }

    const content = payload.choices?.[0]?.message?.content;

    if (!content) {
      console.error('OpenAI response missing message content:', payload);

      return buildFallbackResponse(
        stories,
        'OpenAI response missing message content'
      );
    }

    return JSON.parse(content);
  } catch (error) {
    console.error('Editorial agent orchestration failure:', error);

    return buildFallbackResponse(stories, error.message);
  }
}

module.exports = {
  runEditorialAgent,
  buildMemoryMessage
};
