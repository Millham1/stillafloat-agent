const { PATHS, readJson } = require('../src/persistence');

module.exports = async function handler(req, res) {
  try {
    const newsIndex = readJson(PATHS.newsIndex, {
      generatedAt: null,
      stories: []
    });

    return res.status(200).json({
      success: true,
      source: 'stillafloat-agent',
      generatedAt: newsIndex.generatedAt || null,
      count: (newsIndex.stories || []).length,
      stories: newsIndex.stories || []
    });
  } catch (error) {
    console.error('News feed failure:', error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};