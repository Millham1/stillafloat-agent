module.exports = async function handler(req, res) {
  try {
    const monitoredPorts = [
      'Miami',
      'Port Canaveral',
      'Galveston',
      'Tampa',
      'San Juan',
      'Cozumel',
      'Nassau'
    ];

    return res.status(200).json({
      success: true,
      source: 'stillafloat-agent',
      generatedAt: new Date().toISOString(),
      monitoringEnabled: Boolean(process.env.OPENWEATHER_API_KEY),
      monitoredPorts,
      status: 'weather aggregation scaffolding active'
    });
  } catch (error) {
    console.error('Weather alerts failure:', error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};