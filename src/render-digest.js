function renderEditorialDigest({ stories = [] }) {
  return `
    <html>
      <body style="font-family:Arial,sans-serif;background:#f4f7fb;padding:20px;">
        <div style="max-width:900px;margin:0 auto;background:white;padding:24px;border-radius:18px;">
          <h1>Still Afloat Editorial Intelligence Digest</h1>
          ${stories.map((story, index) => `
            <section style="border:1px solid #d7e3ef;border-radius:14px;padding:16px;margin:14px 0;">
              <h2>${index + 1}. ${story.title}</h2>
              <p><strong>Category:</strong> ${story.category || 'Travel Intelligence'}</p>
              <p>${story.summary || ''}</p>
            </section>
          `).join('')}
        </div>
      </body>
    </html>
  `;
}

module.exports = {
  renderEditorialDigest
};