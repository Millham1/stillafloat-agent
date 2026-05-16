function sanitizeText(value) {
  if (!value) return '';

  return String(value)
    .replace(/<script.*?>.*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function normalizeLinks(links = []) {
  return links
    .filter(link => typeof link === 'string' && link.startsWith('http'))
    .slice(0, 10);
}

function normalizeSources(sources = []) {
  return sources
    .filter(Boolean)
    .map(source => sanitizeText(source))
    .slice(0, 10);
}

function buildPublishingStory(story = {}, featured = false) {
  return {
    id: sanitizeText(story.id),
    title: sanitizeText(story.title),
    category: sanitizeText(story.category),
    impactLevel: sanitizeText(story.impactLevel),
    travelerImpact: sanitizeText(story.travelerImpact),
    summary: sanitizeText(story.summary || story.synopsis),
    editorialReasoning: sanitizeText(story.reasoning),
    link: typeof story.link === 'string' ? story.link : '',
    originalLink: typeof story.link === 'string' ? story.link : '',
    sourceLinks: normalizeLinks(story.sourceLinks || []),
    image: typeof story.image === 'string' ? story.image : '',
    sources: normalizeSources(story.sources || story.sourceAttribution || []),
    sourceAttribution: normalizeSources(story.sourceAttribution || story.sources || []),
    approvedAt: story.approvedAt || new Date().toISOString(),
    featured: Boolean(featured || story.featured || story.pinned)
  };
}

function buildHomepageOutput({ approvedStories = [], homepageTop5 = [] }) {
  const homepageIds = new Set(homepageTop5.map(story => story.id));

  const selected = [
    ...approvedStories.filter(story => story.featured || story.pinned),
    ...approvedStories.filter(story => homepageIds.has(story.id)),
    ...approvedStories.filter(story => story.homepageCandidate)
  ];

  const seen = new Set();
  const stories = [];

  for (const story of selected) {
    if (!story?.id || seen.has(story.id)) continue;

    seen.add(story.id);

    stories.push(buildPublishingStory(story, true));
  }

  return {
    generatedAt: new Date().toISOString(),
    maxStories: 5,
    stories: stories.slice(0, 5)
  };
}

function buildNewsIndexOutput({ approvedStories = [] }) {
  return {
    generatedAt: new Date().toISOString(),
    count: approvedStories.length,
    stories: approvedStories
      .filter(story => story?.id)
      .map(story => buildPublishingStory(story))
  };
}

function buildStoryDetailsOutput({ approvedStories = [] }) {
  return {
    generatedAt: new Date().toISOString(),
    stories: approvedStories
      .filter(story => story?.id)
      .map(story => ({
        ...buildPublishingStory(story),
        slug: sanitizeText(story.id)
      }))
  };
}

function buildPublishingBundle({ approvedStories = [], homepageTop5 = [] }) {
  return {
    homepage: buildHomepageOutput({ approvedStories, homepageTop5 }),
    newsIndex: buildNewsIndexOutput({ approvedStories }),
    storyDetails: buildStoryDetailsOutput({ approvedStories })
  };
}

module.exports = {
  buildHomepageOutput,
  buildNewsIndexOutput,
  buildStoryDetailsOutput,
  buildPublishingBundle
};