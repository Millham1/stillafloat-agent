const { PATHS, writeJson, readJson } = require('../src/persistence');

module.exports = async function handler(req, res) {
  try {
    const index = Number(req.query.index || 0);

    const candidates = await readJson(PATHS.candidates, { stories: [] });
    const approved = await readJson(PATHS.approved, { stories: [] });

    const story = candidates.stories[index];

    if (!story) {
      return res.status(404).send('Story not found');
    }

    approved.stories = approved.stories || [];

    approved.stories.unshift({
      ...story,
      editorialStatus: 'approved',
      approvedAt: new Date().toISOString()
    });

    candidates.stories.splice(index, 1);

    await writeJson(PATHS.approved, approved);
    await writeJson(PATHS.candidates, candidates);

    return res.status(200).send(`
      <html>
        <body style="font-family:Arial;padding:40px;background:#f8fafc;">
          <div style="max-width:700px;margin:auto;background:white;padding:30px;border-radius:16px;">
            <h1 style="color:#0f766e;">Story Approved</h1>
            <p>The story has been added to the approved editorial queue.</p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error(error);
    return res.status(500).send(error.message);
  }
};