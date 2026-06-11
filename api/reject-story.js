const { PATHS, writeJson, readJson } = require('../src/persistence');

const MAX_REJECTED_MEMORY = 200;

module.exports = async function handler(req, res) {
  try {
    const query = req.query || {};
    const body = req.body || {};
    const index = Number(query.index ?? body.index ?? 0);
    const reason = query.reason || body.reason || '';

    const candidates = await readJson(PATHS.candidates, { stories: [] });
    const rejected = await readJson(PATHS.rejected, { stories: [] });

    const story = (candidates.stories || [])[index];

    if (!story) {
      return res.status(404).send('Story not found');
    }

    rejected.stories = rejected.stories || [];
    rejected.stories.unshift({
      ...story,
      editorialStatus: 'rejected',
      rejectionReason: reason || story.reasoning || 'Rejected by editor',
      rejectedAt: new Date().toISOString()
    });

    // Keep the durable reject memory bounded so the learning payload stays small.
    rejected.stories = rejected.stories.slice(0, MAX_REJECTED_MEMORY);

    candidates.stories.splice(index, 1);

    await writeJson(PATHS.rejected, rejected);
    await writeJson(PATHS.candidates, candidates);

    return res.status(200).send(`
      <html>
        <body style="font-family:Arial;padding:40px;background:#f8fafc;">
          <div style="max-width:700px;margin:auto;background:white;padding:30px;border-radius:16px;">
            <h1 style="color:#b91c1c;">Story Rejected</h1>
            <p>The story was removed from the queue and recorded so the agent learns from it.</p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error(error);
    return res.status(500).send(error.message);
  }
};
