// news-archive-search.ts — pure filtering for the dashboard's story-archive
// browser (routes/news-archive.ts). Kept free of I/O so it can be unit-tested
// with the repo's node:test runner.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ArchiveStoryRecord = Record<string, any>;

// EN + ES text fields the free-text search looks through.
const SEARCH_FIELDS = [
  "title", "title_es",
  "summary", "summary_es",
  "travelerImpact", "travelerImpact_es",
  "reasoning", "editorialReasoning", "editorialReasoning_es",
  "category",
] as const;

function haystack(story: ArchiveStoryRecord): string {
  const parts: string[] = [];
  for (const field of SEARCH_FIELDS) {
    const v = story[field];
    if (typeof v === "string" && v) parts.push(v);
  }
  for (const s of story["sources"] || []) if (typeof s === "string") parts.push(s);
  return parts.join(" \n ").toLowerCase();
}

/** Split a raw query into lowercase terms. */
export function queryTerms(q: string): string[] {
  const trimmed = q.trim().toLowerCase();
  return trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
}

/** Every term must match somewhere in the story's EN/ES text (AND semantics). */
export function matchesQuery(story: ArchiveStoryRecord, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const text = haystack(story);
  return terms.every((term) => text.includes(term));
}

export function storyTime(story: ArchiveStoryRecord): number | null {
  const t = Date.parse(String(story["approvedAt"] || story["publishedAt"] || ""));
  return Number.isNaN(t) ? null : t;
}

/** Date range on approvedAt. Stories with no parseable date only match an
 *  open (unbounded) range. `to` is an EXCLUSIVE upper bound in ms. */
export function inRange(
  story: ArchiveStoryRecord,
  from: number | null,
  to: number | null,
): boolean {
  if (from === null && to === null) return true;
  const t = storyTime(story);
  if (t === null) return false;
  if (from !== null && t < from) return false;
  if (to !== null && t >= to) return false;
  return true;
}

export function parseFrom(raw: string): number | null {
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

export function parseTo(raw: string): number | null {
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  // Bare date → exclusive upper bound at the NEXT midnight so the day counts.
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? t + 24 * 60 * 60 * 1000 : t;
}
