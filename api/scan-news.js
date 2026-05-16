const { buildCandidateFeed } = require('../src/live-sources');
const { runEditorialAgent } = require('../src/run-agent');
const { renderEditorialDigest } = require('../src/render-digest');
const { sendEditorialDigest } = require('../src/email-delivery');
const { PATHS, writeJson, readJson } = require('../src/persistence');

module.exports = async function handler(req, res) {
  try {
    const stories = await buildCandidateFeed();

    const approvedExisting = readJson(PATHS.approved, { stories: [] });
    const candidatesExisting = readJson(PATHS.candidates, { rejectedStories: [] });

    const curated = await runEditorialAgent({
      stories,
      openai: process.env.OPENAI_API_KEY,
      editorialMemory: {
        approvedStories: approvedExisting.stories || [],
        rejectedStories: candidatesExisting.rejectedStories || []
      }
    });

    writeJson(PATHS.candidates, {
      generatedAt: new Date().toISOString(),
      stories: curated.stories || [],
      homepageTop5: curated.homepageTop5 || [],
      groupedDevelopments: curated.groupedDevelopments || [],
      rejectedStories: curated.rejectedStories || []
    });

    const html = renderEditorialDigest({
      stories: curated.stories || []
    });

    const emailResult = await sendEditorialDigest({
      subject: 'Still Afloat AI Editorial Digest',
      html
    });

    return res.status(200).json({
      success: true,
      scannedStories: stories.length,
      curatedStories: (curated.stories || []).length,
      emailResult
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};