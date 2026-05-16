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

async function runEditorialAgent({ stories = [], openai }) {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${openai}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        temperature: 0.15,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: directive
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
  runEditorialAgent
};