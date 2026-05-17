const { PATHS, readJson } = require('../src/persistence');

function buildAlerts(stories = []) {
  return stories
    .filter(story => {
      const impact = String(story.impactLevel || '').toLowerCase();
      return (
        story.featured ||
        story.pinned ||
        impact.includes('high') ||
        impact.includes('critical')
      );
    })
    .slice(0, 10)
    .map(story => ({
      id: story.id,
      title: story.title,
      category: story.category,
      impactLevel: story.impactLevel,
      travelerImpact: story.travelerImpact,
      summary: story.summary,
      link: story.link,
      approvedAt: story.approvedAt,
      featured: Boolean(story.featured || story.pinned)
    }));
}

module.exports = async function handler(req, res) {
  try {
    const newsIndex = readJson(PATHS.newsIndex, {
      generatedAt: null,
      stories: []
    });

    const alerts = buildAlerts(newsIndex.stories || []);

    return res.status(200).json({
      success: true,
      source: 'stillafloat-agent',
      generatedAt: newsIndex.generatedAt || null,
      count: alerts.length,
      alerts
    });
  } catch (error) {
    console.error('Alerts feed failure:', error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};