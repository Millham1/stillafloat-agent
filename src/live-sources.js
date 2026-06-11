const {
  trustedCruiseSources,
  trustedMainstreamSources,
  trustedOperationalSources
} = require('./source-registry');

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

// Editorial intent: build a DIVERSIFIED candidate pool. A single relevance-ranked
// "cruise OR airline" query lets one hot brand (e.g. one cruise line) monopolize the
// day. Separate lanes guarantee cruise, mainstream-traveler, and operational coverage.
const SEARCH_LANES = [
  { lane: 'cruise', q: 'cruise OR "cruise line" OR cruising OR embarkation OR itinerary' },
  { lane: 'mainstream', q: 'airline cancellation OR airport delay OR flight disruption OR TSA OR "travel advisory" OR passport' },
  { lane: 'operational', q: 'hurricane OR "tropical storm" OR "port closure" OR "coast guard" OR "cruise port"' }
];

const PER_LANE_MAX = 10; // GNews free tier returns up to 10 articles per request
const PER_SOURCE_CAP = 3; // no single outlet dominates the pool
const PER_BRAND_CAP = 4; // no single cruise line dominates the pool

const CRUISE_BRANDS = [
  'carnival', 'royal caribbean', 'norwegian', 'ncl', 'msc', 'princess',
  'celebrity', 'disney cruise', 'virgin voyages', 'holland america', 'costa', 'cunard'
];

function classifyTrust(sourceName = '') {
  const name = String(sourceName || '').toLowerCase();
  if (trustedOperationalSources.some(s => name.includes(s.toLowerCase()))) return 'high-operational';
  if (trustedMainstreamSources.some(s => name.includes(s.toLowerCase()))) return 'high-mainstream';
  if (trustedCruiseSources.some(s => name.includes(s.toLowerCase()))) return 'high-cruise';
  return 'standard';
}

function detectBrand(text = '') {
  const lower = String(text || '').toLowerCase();
  return CRUISE_BRANDS.find(brand => lower.includes(brand)) || null;
}

async function fetchGNewsLane(apiKey, lane, q) {
  const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=en&max=${PER_LANE_MAX}&apikey=${apiKey}`;
  const payload = await fetchJson(url);

  return (payload?.articles || []).map(article => ({
    id: article.url,
    title: article.title,
    summary: article.description,
    link: article.url,
    source: article.source?.name,
    publishedAt: article.publishedAt,
    lane,
    trustLevel: classifyTrust(article.source?.name),
    brand: detectBrand(`${article.title || ''} ${article.description || ''}`)
  }));
}

async function fetchGNewsStories() {
  const apiKey = process.env.GNEWS_API_KEY;
  if (!apiKey) return [];

  const lanes = await Promise.all(
    SEARCH_LANES.map(({ lane, q }) => fetchGNewsLane(apiKey, lane, q))
  );

  return lanes.flat();
}

function dedupeByUrl(stories = []) {
  const seen = new Set();
  return stories.filter(story => {
    if (!story.id || seen.has(story.id)) return false;
    seen.add(story.id);
    return true;
  });
}

// Hard ceilings so no single source or cruise line can flood the candidate feed.
function applyDiversityCaps(stories = []) {
  const perSource = {};
  const perBrand = {};
  const kept = [];

  for (const story of stories) {
    const source = String(story.source || 'unknown').toLowerCase();
    const brand = story.brand;

    if ((perSource[source] || 0) >= PER_SOURCE_CAP) continue;
    if (brand && (perBrand[brand] || 0) >= PER_BRAND_CAP) continue;

    perSource[source] = (perSource[source] || 0) + 1;
    if (brand) perBrand[brand] = (perBrand[brand] || 0) + 1;
    kept.push(story);
  }

  return kept;
}

async function fetchWeatherSignals() {
  return [];
}

async function buildCandidateFeed() {
  const [gnews, weather] = await Promise.all([
    fetchGNewsStories(),
    fetchWeatherSignals()
  ]);

  return applyDiversityCaps(dedupeByUrl([...gnews, ...weather]));
}

module.exports = {
  buildCandidateFeed,
  applyDiversityCaps,
  classifyTrust,
  detectBrand
};
