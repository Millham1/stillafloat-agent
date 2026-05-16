function countBy(items = [], selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item) || 'Unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function topEntries(map = {}) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

function buildEditorialAnalytics({ approvedStories = [], rejectedStories = [] }) {
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      approvedStories: approvedStories.length,
      rejectedStories: rejectedStories.length
    },
    topCategories: topEntries(countBy(approvedStories, story => story.category)),
    topSources: topEntries(countBy(approvedStories, story => (story.sources || [])[0]))
  };
}

module.exports = {
  buildEditorialAnalytics
};