const { buildCandidateFeed } = require('../src/live-sources');
const { runEditorialAgent } = require('../src/run-agent');
const { clusterStories, flattenRepresentativeStories } = require('../src/semantic-clustering');
const { renderEditorialDigest } = require('../src/render-digest');
const { sendEditorialDigest } = require('../src/email-delivery');
const { PATHS, writeJson, readJson } = require('../src/persistence');
const { normalizeStories } = require('../src/story-normalizer');

function normalizeTitle(value = '') {
  return String(value || '').trim().toLowerCase();
}

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

    // Load durable history.
    const approvedExisting = await readJson(PATHS.approved, { stories: [] });
    const archiveExisting = await readJson(PATHS.archive, { stories: [] });
    const rejectedExisting = await readJson(PATHS.rejected, { stories: [] });

    // CROSS-RUN DEDUP: drop candidates already published in a prior run, by id or title.
    const publishedIds = new Set();
    const publishedTitles = new Set();
    for (const story of [...(approvedExisting.stories || []), ...(archiveExisting.stories || [])]) {
      if (story.id) publishedIds.add(story.id);
      if (story.title) publishedTitles.add(normalizeTitle(story.title));
    }

    const freshStories = normalizedStories.filter(
      story => !publishedIds.has(story.id) && !publishedTitles.has(normalizeTitle(story.title))
    );

    telemetry.freshStoryCount = freshStories.length;

    // WITHIN-RUN DEDUP: collapse near-duplicates into representatives before the AI sees them.
    const clusters = clusterStories(freshStories);
    const dedupedStories = flattenRepresentativeStories(clusters);

    telemetry.clusterCount = clusters.length;
    telemetry.dedupedStoryCount = dedupedStories.length;

    const curated = await runEditorialAgent({
      stories: dedupedStories,
      openai: process.env.OPENAI_API_KEY,
      editorialMemory: {
        approvedStories: approvedExisting.stories || [],
        rejectedStories: rejectedExisting.stories || []
      }
    });

    telemetry.aiCompleted = true;
    telemetry.degradedMode = Boolean(curated?.systemStatus?.degraded);

    const curatedStories = normalizeStories(curated.stories || []);

    await writeJson(PATHS.candidates, {
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
      freshStories: freshStories.length,
      dedupedStories: dedupedStories.length,
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
