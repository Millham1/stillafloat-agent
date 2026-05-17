const { PATHS, readJson } = require('../src/persistence');

module.exports = async function handler(req, res) {
  try {
    const candidates = readJson(PATHS.candidates, {
      generatedAt: null,
      stories: []
    });

    const queue = (candidates.stories || []).map(story => ({
      id: story.id,
      title: story.title,
      category: story.category,
      impactLevel: story.impactLevel,
      travelerImpact: story.travelerImpact,
      summary: story.summary || story.synopsis,
      reasoning: story.reasoning,
      image: story.image,
      link: story.link,
      sourceLinks: story.sourceLinks || [],
      featured: Boolean(story.featured || story.pinned),
      homepageCandidate: Boolean(story.homepageCandidate)
    }));

    return res.status(200).json({
      success: true,
      generatedAt: candidates.generatedAt || null,
      degradedMode: Boolean(candidates.systemStatus?.degraded),
      count: queue.length,
      stories: queue
    });
  } catch (error) {
    console.error('Editorial queue failure:', error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};