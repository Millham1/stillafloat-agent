module.exports = async function handler(req, res) {
  try {
    const siteUrl = process.env.SITE_URL || 'https://stillafloat-agent.vercel.app';

    return res.status(200).json({
      success: true,
      service: 'stillafloat-agent',
      generatedAt: new Date().toISOString(),
      endpoints: {
        health: `${siteUrl}/api/health`,
        systemStatus: `${siteUrl}/api/system-status`,
        homepageFeed: `${siteUrl}/api/homepage-feed`,
        newsFeed: `${siteUrl}/api/news-feed`,
        storyDetails: `${siteUrl}/api/story-details`,
        alertsFeed: `${siteUrl}/api/alerts-feed`,
        weatherAlerts: `${siteUrl}/api/weather-alerts`,
        scanNews: `${siteUrl}/api/scan-news`,
        editorialActions: `${siteUrl}/api/agent-action`
      },
      capabilities: {
        aiEditorial: true,
        operationalAlerts: true,
        publishingFeeds: true,
        approvalWorkflow: true,
        weatherMonitoring: Boolean(process.env.OPENWEATHER_API_KEY),
        emailDelivery: Boolean(process.env.RESEND_API_KEY)
      }
    });
  } catch (error) {
    console.error('Platform manifest failure:', error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};