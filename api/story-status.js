const { PATHS, writeJson, readJson } = require('../src/persistence');

module.exports = async function handler(req, res) {
  try {
    const index = Number(req.query.index || 0);
    const mode = String(req.query.mode || 'hold');

    const candidates = await readJson(PATHS.candidates, {
      stories: [],
      rejectedStories: []
    });

    const approved = await readJson(PATHS.approved, { stories: [] });

    const story = candidates.stories[index];

    if (!story) {
      return res.status(404).json({ success: false, error: 'Story not found' });
    }

    if (mode === 'approve') {
      approved.stories = approved.stories || [];

      approved.stories.unshift({
        ...story,
        editorialStatus: 'approved',
        approvedAt: new Date().toISOString()
      });

      candidates.stories.splice(index, 1);

      await writeJson(PATHS.approved, approved);
      await writeJson(PATHS.candidates, candidates);
    }

    if (mode === 'feature') {
      approved.stories = approved.stories || [];

      approved.stories.unshift({
        ...story,
        pinned: true,
        homepagePriority: 1,
        editorialStatus: 'featured',
        featuredAt: new Date().toISOString()
      });

      candidates.stories.splice(index, 1);

      await writeJson(PATHS.approved, approved);
      await writeJson(PATHS.candidates, candidates);
    }

    if (mode === 'hold') {
      candidates.rejectedStories = candidates.rejectedStories || [];

      candidates.rejectedStories.unshift({
        ...story,
        editorialStatus: 'held',
        heldAt: new Date().toISOString()
      });

      candidates.stories.splice(index, 1);

      await writeJson(PATHS.candidates, candidates);
    }

    return res.status(200).json({
      success: true,
      mode,
      title: story.title
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};