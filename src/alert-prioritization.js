function classifyUrgency(story = {}) {
  const text = `${story.title || ''} ${story.summary || ''}`.toLowerCase();

  if (/(hurricane warning|port closure|faa outage|ground stop|ship disabled|embarkation cancelled)/.test(text)) return 'critical';
  if (/(delay|storm|reroute|travel advisory|weather impact|airport disruption)/.test(text)) return 'high';
  if (/(pricing|loyalty|policy|new itinerary)/.test(text)) return 'medium';

  return 'low';
}

function buildOperationalAlerts(stories = []) {
  return stories
    .map(story => ({
      id: story.id,
      title: story.title,
      urgency: classifyUrgency(story),
      travelerImpact: story.travelerImpact,
      summary: story.summary,
      sources: story.sources || []
    }))
    .filter(alert => alert.urgency !== 'low');
}

module.exports = {
  buildOperationalAlerts,
  classifyUrgency
};