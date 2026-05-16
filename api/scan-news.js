const { buildCandidateFeed } = require('../src/live-sources');
const { runEditorialAgent } = require('../src/run-agent');
const { renderEditorialDigest } = require('../src/render-digest');
const { sendEditorialDigest } = require('../src/email-delivery');
const { PATHS, writeJson, readJson } = require('../src/persistence');
const { normalizeStories } = require('../src/story-normalizer');

module.exports = async function handler(req, res) {
  try {
    const rawStories = await buildCandidateFeed();
    const normalizedStories = normalizeStories(rawStories);

    const approvedExisting = readJson(PATHS.approved, { stories: [] });
    const candidatesExisting = readJson(PATHS.candidates, { rejectedStories: [] });

    const curated = await runEditorialAgent({
      stories: normalizedStories,
      openai: process.env.OPENAI_API_KEY,
      editorialMemory: {
        approvedStories: approvedExisting.stories || [],
        rejectedStories: candidatesExisting.rejectedStories || []
      }
    });

    const curatedStories = normalizeStories(curated.stories || []);

    writeJson(PATHS.candidates, {
      generatedAt: new Date().toISOString(),
      stories: curatedStories,
      homepageTop5: normalizeStories(curated.homepageTop5 || []).slice(0, 5),
      groupedDevelopments: curated.groupedDevelopments || [],
      rejectedStories: normalizeStories(curated.rejectedStories || [])
    });

    const html = renderEditorialDigest({
      stories: curatedStories
    });

    const emailResult = await sendEditorialDigest({
      subject: 'Still Afloat AI Editorial Digest',
      html
    });

    return res.status(200).json({
      success: true,
      scannedStories: normalizedStories.length,
      curatedStories: curatedStories.length,
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