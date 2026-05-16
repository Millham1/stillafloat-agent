const { PATHS, readJson, writeJson } = require('../src/persistence');
const { buildPublishingBundle } = require('../src/publishing-output');

module.exports = async function handler(req, res) {
  try {
    const action = String(req.query.action || '').toLowerCase();
    const id = String(req.query.id || '');

    const candidates = readJson(PATHS.candidates, { stories: [] });
    const approved = readJson(PATHS.approved, { stories: [] });
    const archive = readJson(PATHS.archive, { stories: [] });

    const story = (candidates.stories || []).find(item => item.id === id);

    if (!story) {
      return res.status(404).json({ success: false, error: 'Story not found' });
    }

    if (action === 'reject') {
      const updatedCandidates = {
        ...candidates,
        stories: candidates.stories.filter(item => item.id !== id),
        rejectedStories: [
          ...(candidates.rejectedStories || []),
          {
            ...story,
            rejectedAt: new Date().toISOString()
          }
        ]
      };

      writeJson(PATHS.candidates, updatedCandidates);

      return res.status(200).json({ success: true, action: 'rejected' });
    }

    const approvedStory = {
      ...story,
      approvedAt: new Date().toISOString(),
      featured: action === 'pin'
    };

    const approvedStories = [
      approvedStory,
      ...(approved.stories || []).filter(item => item.id !== id)
    ];

    writeJson(PATHS.approved, {
      generatedAt: new Date().toISOString(),
      stories: approvedStories
    });

    writeJson(PATHS.candidates, {
      ...candidates,
      stories: candidates.stories.filter(item => item.id !== id)
    });

    writeJson(PATHS.archive, {
      generatedAt: new Date().toISOString(),
      stories: [
        approvedStory,
        ...(archive.stories || [])
      ].slice(0, 500)
    });

    const publishing = buildPublishingBundle({
      approvedStories,
      homepageTop5: approvedStories.slice(0, 5)
    });

    writeJson(PATHS.homepage, publishing.homepage);
    writeJson(PATHS.newsIndex, publishing.newsIndex);
    writeJson(PATHS.storyDetails, publishing.storyDetails);

    return res.status(200).json({
      success: true,
      action,
      homepageStories: publishing.homepage.stories.length
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};