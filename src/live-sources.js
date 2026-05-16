async function fetchJson(url, headers = {}) {
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function fetchGNewsStories() {
  const apiKey = process.env.GNEWS_API_KEY;
  if (!apiKey) return [];

  const url = `https://gnews.io/api/v4/search?q=cruise%20OR%20airline%20OR%20airport&lang=en&max=25&apikey=${apiKey}`;
  const payload = await fetchJson(url);

  return (payload?.articles || []).map(article => ({
    id: article.url,
    title: article.title,
    summary: article.description,
    link: article.url,
    source: article.source?.name,
    publishedAt: article.publishedAt
  }));
}

async function fetchWeatherSignals() {
  return [];
}

async function buildCandidateFeed() {
  const [gnews, weather] = await Promise.all([
    fetchGNewsStories(),
    fetchWeatherSignals()
  ]);

  return [...gnews, ...weather];
}

module.exports = {
  buildCandidateFeed
};