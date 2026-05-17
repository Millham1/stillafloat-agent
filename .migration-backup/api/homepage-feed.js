const { PATHS, readJson } = require('../src/persistence');

module.exports = async function handler(req, res) {
  try {
    const homepage = readJson(PATHS.homepage, {
      generatedAt: null,
      stories: []
    });

    return res.status(200).json({
      success: true,
      source: 'stillafloat-agent',
      generatedAt: homepage.generatedAt || null,
      count: (homepage.stories || []).length,
      stories: homepage.stories || []
    });
  } catch (error) {
    console.error('Homepage feed failure:', error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};