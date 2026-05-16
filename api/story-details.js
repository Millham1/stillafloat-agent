const { PATHS, readJson } = require('../src/persistence');

module.exports = async function handler(req, res) {
  try {
    const storyDetails = readJson(PATHS.storyDetails, {
      generatedAt: null,
      stories: []
    });

    const storyId = String(req.query.id || '').trim();

    if (storyId) {
      const story = (storyDetails.stories || []).find(item => item.id === storyId);

      if (!story) {
        return res.status(404).json({
          success: false,
          error: 'Story not found'
        });
      }

      return res.status(200).json({
        success: true,
        story
      });
    }

    return res.status(200).json({
      success: true,
      source: 'stillafloat-agent',
      generatedAt: storyDetails.generatedAt || null,
      count: (storyDetails.stories || []).length,
      stories: storyDetails.stories || []
    });
  } catch (error) {
    console.error('Story details failure:', error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};