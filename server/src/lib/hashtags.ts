// hashtags.ts — one canonical shape for social hashtags.
//
// Stored batches have carried BOTH shapes ("#crucero" and "crucero") since the
// social engine shipped — the model was never told whether to include the "#",
// and gpt-4o-mini and Claude each picked a side at random per batch. Every
// render path joined the array verbatim, so an unprefixed tag posted as an
// ordinary word and counted for nothing. Found 2026-09-09 during the 30-day
// Spanish-only Instagram Reels test, where reach is the number being judged.
//
// Rules: trim, strip every leading "#" (a stray "##" collapses to one), drop
// internal whitespace (a hashtag ends at the first space on every platform),
// lowercase, drop empties, dedupe, then prepend exactly one "#". Pure — safe
// to call on write (the batch builder) AND on read (review page, Share Kit,
// publisher) so the ~60 already-queued prod batches are fixed without a data
// migration.

export function normalizeHashtags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const body = item
      .trim()
      .replace(/^#+/, "")
      .replace(/\s+/g, "")
      .toLowerCase();
    if (!body || seen.has(body)) continue;
    seen.add(body);
    out.push(`#${body}`);
  }
  return out;
}

/** The hashtags as one space-separated line ("" when there are none). */
export function hashtagLine(raw: unknown): string {
  return normalizeHashtags(raw).join(" ");
}

/**
 * Caption + hashtags + optional link, the way the post is meant to land on the
 * platform. Instagram and Facebook both read hashtags out of the caption body;
 * there is no separate field, so a caption sent without them has no hashtags.
 */
export function composeCaption(caption: string, hashtags: unknown, link?: string): string {
  return [caption.trim(), hashtagLine(hashtags), link?.trim() ?? ""].filter(Boolean).join("\n\n");
}
