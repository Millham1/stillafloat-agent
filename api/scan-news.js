const { buildCandidateFeed } = require('../src/live-sources');
const { runEditorialAgent } = require('../src/run-agent');
const { renderEditorialDigest } = require('../src/render-digest');
const { sendEditorialDigest } = require('../src/email-delivery');
const { PATHS, writeJson, readJson } = require('../src/persistence');
const { normalizeStories } = require('../src/story-normalizer');

module.exports = async function handler(req, res) {
  const telemetry = {
    startedAt: new Date().toISOString(),
    ingestionCompleted: false,
    normalizationCompleted: false,
    aiCompleted: false,
    persistenceCompleted: false,
    emailCompleted: false,
    degradedMode: false,
    errors: []
  };

  try {
    const rawStories = await buildCandidateFeed();

    telemetry.ingestionCompleted = true;
    telemetry.rawStoryCount = rawStories.length;

    const normalizedStories = normalizeStories(rawStories);

    telemetry.normalizationCompleted = true;
    telemetry.normalizedStoryCount = normalizedStories.length;

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

    telemetry.aiCompleted = true;
    telemetry.degradedMode = Boolean(curated?.systemStatus?.degraded);

    const curatedStories = normalizeStories(curated.stories || []);

    writeJson(PATHS.candidates, {
      generatedAt: new Date().toISOString(),
      systemStatus: curated.systemStatus || null,
      stories: curatedStories,
      homepageTop5: normalizeStories(curated.homepageTop5 || []).slice(0, 5),
      groupedDevelopments: curated.groupedDevelopments || [],
      rejectedStories: normalizeStories(curated.rejectedStories || []),
      telemetry
    });

    telemetry.persistenceCompleted = true;

    const html = renderEditorialDigest({
      stories: curatedStories
    });

    const emailResult = await sendEditorialDigest({
      subject: telemetry.degradedMode
        ? 'Still Afloat AI Digest (Degraded Mode)'
        : 'Still Afloat AI Editorial Digest',
      html
    });

    telemetry.emailCompleted = Boolean(emailResult?.success);

    return res.status(200).json({
      success: true,
      scannedStories: normalizedStories.length,
      curatedStories: curatedStories.length,
      degradedMode: telemetry.degradedMode,
      telemetry,
      emailResult
    });
  } catch (error) {
    console.error('Scan pipeline failure:', error);

    telemetry.errors.push({
      message: error.message,
      timestamp: new Date().toISOString()
    });

    return res.status(500).json({
      success: false,
      error: error.message,
      telemetry
    });
  }
};