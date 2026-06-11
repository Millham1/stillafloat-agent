function slugify(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 90);
}

function isValidHttpUrl(value = '') {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function clean(value = '') {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeStory(story = {}, index = 0) {
  const title = clean(story.title || story.headline || `Untitled story ${index + 1}`);
  const link = isValidHttpUrl(story.link || story.url || story.originalLink)
    ? String(story.link || story.url || story.originalLink)
    : '';

  const idSeed = story.id && !String(story.id).startsWith('http')
    ? story.id
    : `${title}-${link}`;

  return {
    id: slugify(idSeed) || `story-${index + 1}`,
    title,
    category: clean(story.category || 'Travel Intelligence'),
    impactLevel: clean(story.impactLevel || story.impact || 'Medium'),
    travelerImpact: clean(story.travelerImpact || story.whyItMatters || ''),
    summary: clean(story.summary || story.description || ''),
    reasoning: clean(story.reasoning || ''),
    homepageCandidate: Boolean(story.homepageCandidate || story.featured),
    featured: Boolean(story.featured || story.homepageCandidate),
    sourceAttribution: Array.isArray(story.sourceAttribution)
      ? story.sourceAttribution
      : Array.isArray(story.sources)
        ? story.sources
        : story.source
          ? [story.source]
          : [],
    sources: Array.isArray(story.sources)
      ? story.sources
      : story.source
        ? [story.source]
        : Array.isArray(story.sourceAttribution)
          ? story.sourceAttribution
          : [],
    sourceLinks: Array.isArray(story.sourceLinks)
      ? story.sourceLinks.filter(item => item && isValidHttpUrl(item.url || item.link))
      : link
        ? [{ source: story.source || 'Source', url: link }]
        : [],
    link,
    image: isValidHttpUrl(story.image || story.imageUrl) ? String(story.image || story.imageUrl) : '',
    publishedAt: story.publishedAt || story.createdAt || new Date().toISOString(),
    trustLevel: clean(story.trustLevel || ''),
    lane: clean(story.lane || ''),
    brand: story.brand || null,
    status: story.status || 'candidate'
  };
}

function dedupeStories(stories = []) {
  const seen = new Set();
  const unique = [];

  for (const story of stories) {
    const key = story.id || `${story.title}-${story.link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(story);
  }

  return unique;
}

function normalizeStories(stories = []) {
  return dedupeStories(stories.map(normalizeStory)).filter(story => story.title && story.summary);
}

function validatePublishingStory(story = {}) {
  const errors = [];
  if (!story.id) errors.push('missing id');
  if (!story.title) errors.push('missing title');
  if (!story.summary) errors.push('missing summary');
  if (!story.link && !(story.sourceLinks || []).length) errors.push('missing source link');
  return errors;
}

module.exports = {
  slugify,
  clean,
  isValidHttpUrl,
  normalizeStory,
  normalizeStories,
  validatePublishingStory
};
