const { PATHS, readJson, writeJson } = require('../src/persistence');
const { buildPublishingBundle } = require('../src/publishing-output');
const { normalizeStory, validatePublishingStory } = require('../src/story-normalizer');

const VALID_ACTIONS = new Set(['approve', 'reject', 'pin', 'defer']);

function authorize(req) {
  const expected = process.env.AGENT_APPROVAL_TOKEN;
  if (!expected) return true;
  const supplied = String(req.query.token || req.headers['x-agent-token'] || '');
  return supplied === expected;
}

function html(message) {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;padding:30px;"><h1>${message}</h1><p>You can close this window.</p></body></html>`;
}

module.exports = async function handler(req, res) {
  try {
    if (!authorize(req)) {
      return res.status(401).send(html('Unauthorized approval link'));
    }

    const action = String(req.query.action || '').toLowerCase().trim();
    const id = String(req.query.id || '').trim();

    if (!VALID_ACTIONS.has(action)) {
      return res.status(400).send(html('Invalid editorial action'));
    }

    if (!id) {
      return res.status(400).send(html('Missing story id'));
    }

    const candidates = readJson(PATHS.candidates, { stories: [], rejectedStories: [], deferredStories: [] });
    const approved = readJson(PATHS.approved, { stories: [] });
    const archive = readJson(PATHS.archive, { stories: [] });

    const story = (candidates.stories || []).find(item => item.id === id);

    if (!story) {
      const alreadyApproved = (approved.stories || []).some(item => item.id === id);
      if (alreadyApproved) return res.status(200).send(html('Story was already approved'));
      return res.status(404).send(html('Story not found or already processed'));
    }

    const normalizedStory = normalizeStory(story);
    const validationErrors = validatePublishingStory(normalizedStory);

    if (action !== 'reject' && validationErrors.length) {
      return res.status(422).json({
        success: false,
        error: 'Story failed publishing validation',
        validationErrors
      });
    }

    if (action === 'reject') {
      const updatedCandidates = {
        ...candidates,
        stories: (candidates.stories || []).filter(item => item.id !== id),
        rejectedStories: [
          ...(candidates.rejectedStories || []),
          {
            ...normalizedStory,
            status: 'rejected',
            rejectedAt: new Date().toISOString(),
            rejectionReason: 'Manual editorial rejection'
          }
        ]
      };

      writeJson(PATHS.candidates, updatedCandidates);
      return res.status(200).send(html('Story rejected successfully'));
    }

    if (action === 'defer') {
      writeJson(PATHS.candidates, {
        ...candidates,
        stories: (candidates.stories || []).map(item => item.id === id ? { ...item, status: 'deferred', deferredAt: new Date().toISOString() } : item),
        deferredStories: [
          ...(candidates.deferredStories || []),
          { ...normalizedStory, status: 'deferred', deferredAt: new Date().toISOString() }
        ]
      });

      return res.status(200).send(html('Story deferred successfully'));
    }

    const approvedStory = {
      ...normalizedStory,
      status: 'approved',
      approvedAt: new Date().toISOString(),
      featured: action === 'pin' ? true : Boolean(normalizedStory.featured || normalizedStory.homepageCandidate),
      pinned: action === 'pin'
    };

    const approvedStories = [
      approvedStory,
      ...(approved.stories || []).filter(item => item.id !== id)
    ].slice(0, 20);

    const updatedCandidates = {
      ...candidates,
      stories: (candidates.stories || []).filter(item => item.id !== id)
    };

    writeJson(PATHS.approved, {
      generatedAt: new Date().toISOString(),
      stories: approvedStories
    });

    writeJson(PATHS.candidates, updatedCandidates);

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

    return res.status(200).send(html(`Story ${action === 'pin' ? 'pinned and approved' : 'approved'} successfully`));
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};