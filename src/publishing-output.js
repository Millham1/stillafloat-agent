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
    stories.push({
      id: story.id,
      title: story.title,
      category: story.category,
      impactLevel: story.impactLevel,
      travelerImpact: story.travelerImpact,
      summary: story.summary,
      link: story.link,
      sourceLinks: story.sourceLinks || [],
      image: story.image,
      sources: story.sources || story.sourceAttribution || [],
      approvedAt: story.approvedAt,
      featured: true
    });
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
    stories: approvedStories.map(story => ({
      id: story.id,
      title: story.title,
      category: story.category,
      impactLevel: story.impactLevel,
      travelerImpact: story.travelerImpact,
      summary: story.summary,
      link: story.link,
      sourceLinks: story.sourceLinks || [],
      image: story.image,
      sources: story.sources || story.sourceAttribution || [],
      approvedAt: story.approvedAt,
      featured: Boolean(story.featured || story.pinned)
    }))
  };
}

function buildStoryDetailsOutput({ approvedStories = [] }) {
  return {
    generatedAt: new Date().toISOString(),
    stories: approvedStories.map(story => ({
      id: story.id,
      slug: story.id,
      title: story.title,
      category: story.category,
      impactLevel: story.impactLevel,
      travelerImpact: story.travelerImpact,
      summary: story.summary,
      editorialReasoning: story.reasoning,
      sourceAttribution: story.sourceAttribution || story.sources || [],
      sourceLinks: story.sourceLinks || [],
      originalLink: story.link,
      image: story.image,
      approvedAt: story.approvedAt
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