function renderEditorialDigest({ stories = [] }) {
  return `
    <html>
      <body style="font-family:Arial,sans-serif;background:#f4f7fb;padding:20px;color:#111827;">
        <div style="max-width:900px;margin:0 auto;background:white;padding:24px;border-radius:18px;box-shadow:0 8px 24px rgba(0,0,0,0.08);">
          <h1 style="margin-top:0;color:#0f172a;">Still Afloat Editorial Intelligence Digest</h1>
          <p style="color:#475569;font-size:15px;line-height:1.6;">
            Review the candidate stories below for editorial approval. Approved stories can later flow into the public Still Afloat publishing feed.
          </p>

          ${stories.map((story, index) => `
            <section style="border:1px solid #d7e3ef;border-radius:14px;padding:18px;margin:18px 0;background:#ffffff;">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
                <h2 style="margin:0;font-size:22px;color:#0f172a;">${index + 1}. ${story.title}</h2>
                <span style="background:#e0f2fe;color:#075985;padding:6px 10px;border-radius:999px;font-size:12px;font-weight:bold;white-space:nowrap;">
                  ${story.category || 'Travel Intelligence'}
                </span>
              </div>

              <p style="margin-top:14px;font-size:15px;line-height:1.7;color:#334155;">
                ${story.summary || ''}
              </p>

              ${story.url ? `
                <p style="margin-top:12px;">
                  <a href="${story.url}" style="color:#2563eb;text-decoration:none;font-weight:bold;">
                    Read Full Source Story
                  </a>
                </p>
              ` : ''}

              <div style="margin-top:18px;display:flex;gap:12px;flex-wrap:wrap;">
                <a href="#" style="background:#0f766e;color:white;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:bold;">
                  Approve Story
                </a>

                <a href="#" style="background:#991b1b;color:white;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:bold;">
                  Reject Story
                </a>
              </div>
            </section>
          `).join('')}

          <footer style="margin-top:28px;padding-top:18px;border-top:1px solid #e2e8f0;color:#64748b;font-size:13px;">
            Still Afloat AI Editorial Operations • Automated Cruise & Travel Intelligence Monitoring
          </footer>
        </div>
      </body>
    </html>
  `;
}

module.exports = {
  renderEditorialDigest
};