module.exports = async function handler(req, res) {
  try {
    return res.status(200).json({
      success: true,
      service: 'stillafloat-agent',
      status: 'healthy',
      timestamp: new Date().toISOString(),
      environment: process.env.VERCEL_ENV || 'unknown',
      uptime: process.uptime(),
      capabilities: {
        aiEditorial: Boolean(process.env.OPENAI_API_KEY),
        emailDelivery: Boolean(process.env.RESEND_API_KEY),
        newsIngestion: Boolean(process.env.GNEWS_API_KEY),
        weatherMonitoring: Boolean(process.env.OPENWEATHER_API_KEY)
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      status: 'unhealthy',
      error: error.message
    });
  }
};