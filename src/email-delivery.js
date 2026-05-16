async function sendEditorialDigest({ html, subject }) {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    const to = process.env.APPROVAL_EMAIL;

    if (!apiKey || !to) {
      return {
        success: false,
        provider: 'resend',
        errorType: 'configuration',
        message: 'Missing RESEND_API_KEY or APPROVAL_EMAIL'
      };
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

    const payload = await response.json();

    if (!response.ok) {
      console.error('Resend delivery failure:', {
        status: response.status,
        payload
      });

      return {
        success: false,
        provider: 'resend',
        errorType: 'delivery_failure',
        status: response.status,
        payload
      };
    }

    return {
      success: true,
      provider: 'resend',
      payload
    };
  } catch (error) {
    console.error('Editorial digest delivery exception:', error);

    return {
      success: false,
      provider: 'resend',
      errorType: 'runtime_exception',
      message: error.message
    };
  }
}

module.exports = {
  sendEditorialDigest
};