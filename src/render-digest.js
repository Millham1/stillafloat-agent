function renderEditorialDigest({ stories = [] }) {
  return `
    <html>
      <body>
        ${stories.map((story, index) => `
          <div>
            <h2>${index + 1}. ${story.title}</h2>
            <p>${story.summary || ''}</p>
          </div>
        `).join('')}
      </body>
    </html>
  `;
}

module.exports = {
  renderEditorialDigest
};