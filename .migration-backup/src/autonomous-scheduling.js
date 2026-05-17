function nextScanWindow(level = 'normal') {
  const now = Date.now();
  const offsets = {
    critical: 15 * 60 * 1000,
    high: 60 * 60 * 1000,
    normal: 6 * 60 * 60 * 1000
  };

  return new Date(now + offsets[level]).toISOString();
}

function buildSchedulingMetadata({ alerts = [] }) {
  const critical = alerts.filter(alert => alert.urgency === 'critical').length;
  const high = alerts.filter(alert => alert.urgency === 'high').length;

  const urgency = critical > 0 ? 'critical' : high > 2 ? 'high' : 'normal';

  return {
    generatedAt: new Date().toISOString(),
    urgency,
    nextRecommendedScan: nextScanWindow(urgency),
    operationalAlertCount: alerts.length,
    recommendations: {
      increaseMonitoringFrequency: high > 2,
      sendEmergencyDigest: critical > 0
    }
  };
}

module.exports = {
  buildSchedulingMetadata
};