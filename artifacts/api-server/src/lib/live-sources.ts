import { logger } from "./logger";

async function fetchJson(url: string, headers: Record<string, string> = {}) {
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    logger.error({ err: error, url }, "fetchJson error");
    return null;
  }
}

async function fetchGNewsStories() {
  const apiKey = process.env["GNEWS_API_KEY"];
  if (!apiKey) return [];

  const url = `https://gnews.io/api/v4/search?q=cruise%20OR%20airline%20OR%20airport&lang=en&max=25&apikey=${apiKey}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = await fetchJson(url) as any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (payload?.articles || []).map((article: any) => ({
    id: article.url,
    title: article.title,
    summary: article.description,
    link: article.url,
    source: article.source?.name,
    publishedAt: article.publishedAt,
  }));
}

export async function buildCandidateFeed() {
  const gnews = await fetchGNewsStories();
  return gnews;
}
