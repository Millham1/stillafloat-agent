const { PATHS, readJson } = require('../src/persistence');

module.exports = async function handler(req, res) {
  try {
    const candidates = readJson(PATHS.candidates, { stories: [] });
    const approved = readJson(PATHS.approved, { stories: [] });
    const homepage = readJson(PATHS.homepage, { stories: [] });

    const status = {
      success: true,
      service: 'stillafloat-agent',
      generatedAt: new Date().toISOString(),
      environment: process.env.VERCEL_ENV || 'unknown',
      systems: {
        openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
        resendConfigured: Boolean(process.env.RESEND_API_KEY),
        gnewsConfigured: Boolean(process.env.GNEWS_API_KEY),
        weatherConfigured: Boolean(process.env.OPENWEATHER_API_KEY),
        approvalConfigured: Boolean(process.env.AGENT_APPROVAL_TOKEN)
      },
      publishing: {
        candidateStories: (candidates.stories || []).length,
        approvedStories: (approved.stories || []).length,
        homepageStories: (homepage.stories || []).length
      },
      pipeline: {
        degradedMode: Boolean(candidates.systemStatus?.degraded),
        degradedReason: candidates.systemStatus?.reason || null
      }
    };

    return res.status(200).json(status);
  } catch (error) {
    console.error('System status failure:', error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};