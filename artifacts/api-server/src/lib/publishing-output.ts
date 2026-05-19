function sanitizeText(value: unknown): string {
  if (!value) return "";
  return String(value)
    .replace(/<script.*?>.*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function normalizeLinks(links: unknown[]): string[] {
  return links
    .filter((link) => typeof link === "string" && link.startsWith("http"))
    .slice(0, 10) as string[];
}

function normalizeSources(sources: unknown[]): string[] {
  return sources
    .filter(Boolean)
    .map((source) => sanitizeText(source))
    .slice(0, 10);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildPublishingStory(story: Record<string, any>, featured = false) {
  const base = {
    id: sanitizeText(story.id),
    title: sanitizeText(story.title),
    category: sanitizeText(story.category),
    impactLevel: sanitizeText(story.impactLevel),
    travelerImpact: sanitizeText(story.travelerImpact),
    summary: sanitizeText(story.summary || story.synopsis),
    editorialReasoning: sanitizeText(story.reasoning || story.editorialReasoning),
    link: typeof story.link === "string" ? story.link : "",
    originalLink: typeof story.link === "string" ? story.link : "",
    sourceLinks: normalizeLinks(story.sourceLinks || []),
    image: typeof story.image === "string" ? story.image : "",
    sources: normalizeSources(story.sources || story.sourceAttribution || []),
    sourceAttribution: normalizeSources(story.sourceAttribution || story.sources || []),
    approvedAt: story.approvedAt || new Date().toISOString(),
    featured: Boolean(featured || story.featured || story.pinned),
  };

  // Preserve Spanish overlay fields so applyEsOverlay() can use them after approval
  const es: Record<string, string> = {};
  if (story.title_es) es.title_es = sanitizeText(story.title_es);
  if (story.summary_es) es.summary_es = sanitizeText(story.summary_es);
  if (story.travelerImpact_es) es.travelerImpact_es = sanitizeText(story.travelerImpact_es);
  if (story.editorialReasoning_es) es.editorialReasoning_es = sanitizeText(story.editorialReasoning_es);

  return { ...base, ...es };
}

export function buildHomepageOutput({
  approvedStories = [],
  homepageTop5 = [],
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  approvedStories: Record<string, any>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  homepageTop5: Record<string, any>[];
}) {
  const homepageIds = new Set(homepageTop5.map((story) => story.id));
  const selected = [
    ...approvedStories.filter((story) => story.featured || story.pinned),
    ...approvedStories.filter((story) => homepageIds.has(story.id)),
    ...approvedStories.filter((story) => story.homepageCandidate),
  ];

  const seen = new Set<string>();
  const stories = [];
  for (const story of selected) {
    if (!story?.id || seen.has(story.id)) continue;
    seen.add(story.id);
    stories.push(buildPublishingStory(story, true));
  }

  return {
    generatedAt: new Date().toISOString(),
    maxStories: 5,
    stories: stories.slice(0, 5),
  };
}

export function buildNewsIndexOutput({
  approvedStories = [],
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  approvedStories: Record<string, any>[];
}) {
  return {
    generatedAt: new Date().toISOString(),
    count: approvedStories.length,
    stories: approvedStories
      .filter((story) => story?.id)
      .map((story) => buildPublishingStory(story)),
  };
}

export function buildStoryDetailsOutput({
  approvedStories = [],
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  approvedStories: Record<string, any>[];
}) {
  return {
    generatedAt: new Date().toISOString(),
    stories: approvedStories
      .filter((story) => story?.id)
      .map((story) => ({
        ...buildPublishingStory(story),
        slug: sanitizeText(story.id),
      })),
  };
}

export function buildPublishingBundle({
  approvedStories = [],
  homepageTop5 = [],
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  approvedStories: Record<string, any>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  homepageTop5: Record<string, any>[];
}) {
  return {
    homepage: buildHomepageOutput({ approvedStories, homepageTop5 }),
    newsIndex: buildNewsIndexOutput({ approvedStories }),
    storyDetails: buildStoryDetailsOutput({ approvedStories }),
  };
}
