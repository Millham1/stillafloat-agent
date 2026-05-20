import { logger } from "./logger";
import Parser from "rss-parser";

const rssParser = new Parser({
  timeout: 8000,
  customFields: {
    item: [["media:content", "mediaContent"], ["media:thumbnail", "mediaThumbnail"]],
  },
});

async function fetchJson(url: string, headers: Record<string, string> = {}) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    logger.warn({ err: error, url }, "fetchJson error");
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function articleFromRss(item: any, sourceName: string): Record<string, unknown> {
  const image =
    item.mediaContent?.["$"]?.url ||
    item.mediaThumbnail?.["$"]?.url ||
    item.enclosure?.url ||
    "";
  return {
    id: item.link || item.guid || item.title,
    title: item.title || "",
    summary: item.contentSnippet || item.content || item.description || "",
    link: item.link || item.guid || "",
    source: sourceName,
    publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
    image: image.startsWith("http") ? image : "",
  };
}

// All feeds confirmed reachable (200/301/302 — rss-parser follows redirects)
const RSS_SOURCES_EN = [
  // Mainstream news — travel sections
  { url: "http://rss.cnn.com/rss/edition_travel.rss", name: "CNN Travel" },
  { url: "https://feeds.foxnews.com/foxnews/travel", name: "Fox News Travel" },
  { url: "http://feeds.bbci.co.uk/news/travel/rss.xml", name: "BBC Travel" },

  // Premium travel media
  { url: "https://thepointsguy.com/feed/", name: "The Points Guy" },
  { url: "https://www.cntraveler.com/feed/rss", name: "Condé Nast Traveler" },
  { url: "https://skift.com/feed/", name: "Skift" },
  { url: "https://upgradedpoints.com/feed/", name: "Upgraded Points" },

  // Cruise-specific
  { url: "https://www.cruisehive.com/feed", name: "Cruise Hive" },
  { url: "https://cruiseradio.net/feed/", name: "Cruise Radio" },
  { url: "https://www.cruiseindustrynews.com/cruise-news/feed", name: "Cruise Industry News" },

  // Travel deals & points (cruise-relevant)
  { url: "https://onemileatatime.com/feed/", name: "One Mile at a Time" },
];

// Spanish-language (es-419) travel & cruise RSS sources
const RSS_SOURCES_ES = [
  // Latin American & Spanish travel news
  { url: "https://www.lavanguardia.com/rss/ocio/viajes.xml", name: "La Vanguardia Viajes" },
  { url: "https://viajes.nationalgeographic.com.es/rss", name: "Nat Geo Viajes" },
  { url: "https://www.clarin.com/rss/viajes/", name: "Clarín Viajes" },
  { url: "https://www.milenio.com/rss/turismo", name: "Milenio Turismo" },
  { url: "https://www.eluniversal.com.mx/rss/turismo.xml", name: "El Universal Turismo" },
];

// Keep the legacy export alias pointing at English sources
const RSS_SOURCES = RSS_SOURCES_EN;

// GNews query buckets — 8 queries × 10 articles = up to 80 raw GNews items
const GNEWS_QUERIES_EN = [
  "cruise ship OR cruise line port itinerary passengers",
  "cruise line carnival royal caribbean norwegian celebrity MSC",
  "cruise ship liveaboard lifestyle story personal",
  "travel advisory warning visa entry ban cruise port",
  "hurricane typhoon storm cruise ship port closure itinerary",
  "hotel resort vacation deal cruise booking price",
  "tourism destination beach island cruise traveler",
  "cruise news this week passengers onboard",
];

// Spanish-language GNews query buckets (GNews lang=es)
const GNEWS_QUERIES_ES = [
  "crucero caribe itinerario pasajeros cambio",
  "aerolínea cancelación vuelo viajero demora",
  "aviso viaje destino turístico Latinoamérica",
  "crucero Royal Caribbean Carnival MSC Norwegian",
  "turismo destino playa isla pasaporte",
  "puerto crucero Caribe México América Central",
  "viaje vacaciones consejo equipaje oferta",
  "estilo de vida crucero historia viajero",
];

// Legacy alias
const GNEWS_QUERIES = GNEWS_QUERIES_EN;

async function fetchGNewsQuery(
  query: string,
  apiKey: string,
  lang: "en" | "es" = "en"
): Promise<Record<string, unknown>[]> {
  const encoded = encodeURIComponent(query);
  const url = `https://gnews.io/api/v4/search?q=${encoded}&lang=${lang}&max=10&apikey=${apiKey}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = (await fetchJson(url)) as any;
  if (!payload?.articles) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return payload.articles.map((article: any) => ({
    id: article.url,
    title: article.title,
    summary: article.description || "",
    link: article.url,
    source: article.source?.name || "GNews",
    publishedAt: article.publishedAt,
    image: article.image || "",
  }));
}

async function fetchRssFeed(
  sourceUrl: string,
  sourceName: string
): Promise<Record<string, unknown>[]> {
  try {
    const feed = await rssParser.parseURL(sourceUrl);
    return (feed.items || [])
      .slice(0, 15)
      .map((item) => articleFromRss(item, sourceName));
  } catch (error) {
    logger.warn({ err: error, source: sourceName }, "RSS feed fetch failed");
    return [];
  }
}

function dedupeByUrl(
  stories: Record<string, unknown>[]
): Record<string, unknown>[] {
  const seen = new Set<string>();
  return stories.filter((s) => {
    const key = String(s.link || s.id || "")
      .toLowerCase()
      .trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeByTitle(
  stories: Record<string, unknown>[]
): Record<string, unknown>[] {
  const kept: Record<string, unknown>[] = [];
  for (const story of stories) {
    const titleWords = new Set(
      String(story.title || "")
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 4)
    );
    const isDupe = kept.some((k) => {
      const kWords = new Set(
        String(k.title || "")
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 4)
      );
      const intersection = [...titleWords].filter((w) => kWords.has(w)).length;
      const union = new Set([...titleWords, ...kWords]).size;
      return union > 0 && intersection / union > 0.65;
    });
    if (!isDupe) kept.push(story);
  }
  return kept;
}

// Filter to stories published within the last 72 hours
function filterRecent(
  stories: Record<string, unknown>[]
): Record<string, unknown>[] {
  const cutoff = Date.now() - 72 * 60 * 60 * 1000;
  return stories.filter((s) => {
    const pub = new Date(String(s.publishedAt || "")).getTime();
    return isNaN(pub) || pub >= cutoff;
  });
}

export async function buildCandidateFeed(
  lang: "en" | "es" = "en"
): Promise<Record<string, unknown>[]> {
  const apiKey = process.env["GNEWS_API_KEY"];

  const rssSources  = lang === "es" ? [...RSS_SOURCES_EN, ...RSS_SOURCES_ES] : RSS_SOURCES_EN;
  const gnewsQueries = lang === "es" ? GNEWS_QUERIES_ES : GNEWS_QUERIES_EN;

  // Fetch all sources in parallel
  const [gnewsResults, rssResults] = await Promise.all([
    apiKey
      ? Promise.all(gnewsQueries.map((q) => fetchGNewsQuery(q, apiKey, lang)))
      : Promise.resolve([]),
    Promise.all(rssSources.map((s) => fetchRssFeed(s.url, s.name))),
  ]);

  const allGNews = (gnewsResults as Record<string, unknown>[][]).flat();
  const allRss = rssResults.flat();

  logger.info(
    { gnewsCount: allGNews.length, rssCount: allRss.length },
    "Raw story ingestion complete"
  );

  // Merge, deduplicate, filter recent, return top 60 for AI ranking
  const merged = [...allGNews, ...allRss];
  const deduped = dedupeByTitle(dedupeByUrl(merged));
  const recent = filterRecent(deduped);

  // Sort: GNews stories with full metadata first, then RSS
  const scored = recent
    .filter((s) => s.title && String(s.title).length > 15)
    .sort((a, b) => {
      const aScore =
        (a.summary && String(a.summary).length > 40 ? 2 : 0) +
        (a.image ? 1 : 0) +
        (a.link ? 1 : 0);
      const bScore =
        (b.summary && String(b.summary).length > 40 ? 2 : 0) +
        (b.image ? 1 : 0) +
        (b.link ? 1 : 0);
      return bScore - aScore;
    });

  logger.info({ candidateCount: scored.length }, "Candidate feed built");
  return scored.slice(0, 60);
}
