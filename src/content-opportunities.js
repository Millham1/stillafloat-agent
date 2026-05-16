function buildYouTubeTopics(stories = []) {
  return stories.slice(0, 10).map(story => ({
    storyId: story.id,
    title: `Still Afloat Topic: ${story.title}`,
    hook: story.travelerImpact || story.summary,
    format: 'Cruise news explainer'
  }));
}

function buildSocialSuggestions(stories = []) {
  return stories.slice(0, 8).map(story => ({
    storyId: story.id,
    platform: 'Facebook / YouTube Community',
    text: `${story.title}\n\n${story.travelerImpact || story.summary}`
  }));
}

function buildContentOpportunities({ approvedStories = [] }) {
  return {
    generatedAt: new Date().toISOString(),
    youtubeTopics: buildYouTubeTopics(approvedStories),
    socialSuggestions: buildSocialSuggestions(approvedStories)
  };
}

module.exports = {
  buildContentOpportunities
};