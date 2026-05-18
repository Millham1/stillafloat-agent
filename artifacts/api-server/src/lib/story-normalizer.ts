export function slugify(value = ""): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 90);
}

export function isValidHttpUrl(value = ""): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function clean(value = ""): string {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeStory(story: Record<string, any> = {}, index = 0) {
  const title = clean(story.title || story.headline || `Untitled story ${index + 1}`);
  const link = isValidHttpUrl(story.link || story.url || story.originalLink)
    ? String(story.link || story.url || story.originalLink)
    : "";

  const idSeed =
    story.id && !String(story.id).startsWith("http")
      ? story.id
      : `${title}-${link}`;

  const tierRaw = Number(story.tier);
  const tier = tierRaw >= 1 && tierRaw <= 4 ? tierRaw : null;

  return {
    id: slugify(idSeed) || `story-${index + 1}`,
    title,
    tier,
    category: clean(story.category || "Travel Intelligence"),
    impactLevel: clean(story.impactLevel || story.impact || "Medium"),
    travelerImpact: clean(story.travelerImpact || story.whyItMatters || ""),
    summary: clean(story.summary || story.description || ""),
    reasoning: clean(story.reasoning || ""),
    homepageCandidate: Boolean(story.homepageCandidate || story.featured),
    featured: Boolean(story.featured || story.homepageCandidate),
    sourceAttribution: Array.isArray(story.sourceAttribution)
      ? story.sourceAttribution
      : Array.isArray(story.sources)
        ? story.sources
        : story.source
          ? [story.source]
          : [],
    sources: Array.isArray(story.sources)
      ? story.sources
      : story.source
        ? [story.source]
        : Array.isArray(story.sourceAttribution)
          ? story.sourceAttribution
          : [],
    sourceLinks: Array.isArray(story.sourceLinks)
      ? story.sourceLinks.filter(
          (item: unknown) =>
            item && isValidHttpUrl((item as Record<string, string>).url || (item as Record<string, string>).link)
        )
      : link
        ? [{ source: story.source || "Source", url: link }]
        : [],
    link,
    image:
      isValidHttpUrl(story.image || story.imageUrl)
        ? String(story.image || story.imageUrl)
        : "",
    publishedAt: story.publishedAt || story.createdAt || new Date().toISOString(),
    status: story.status || "candidate",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dedupeStories(stories: Record<string, any>[]) {
  const seen = new Set<string>();
  const unique = [];
  for (const story of stories) {
    const key = story.id || `${story.title}-${story.link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(story);
  }
  return unique;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeStories(stories: Record<string, any>[] = []) {
  return dedupeStories(stories.map(normalizeStory)).filter(
    (story) => story.title && story.summary
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function validatePublishingStory(story: Record<string, any> = {}) {
  const errors: string[] = [];
  if (!story.id) errors.push("missing id");
  if (!story.title) errors.push("missing title");
  if (!story.summary) errors.push("missing summary");
  if (!story.link && !(story.sourceLinks || []).length) errors.push("missing source link");
  return errors;
}
