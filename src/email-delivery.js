async function sendEditorialDigest({ html, subject }) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.APPROVAL_EMAIL;

  if (!apiKey || !to) {
    throw new Error('Missing RESEND_API_KEY or APPROVAL_EMAIL');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Still Afloat AI <onboarding@resend.dev>',
      to,
      subject,
      html
    })
  });

  return await response.json();
}

module.exports = {
  sendEditorialDigest
};