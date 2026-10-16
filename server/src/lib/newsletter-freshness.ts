// newsletter-freshness.ts — which approved stories a weekly issue may use, and whether an
// issue may go out at all. Pure (no I/O) so the unit suite can replay the 2026-10-15 failure.
//
// What happened (2026-10-15 13:03Z, both editions): the window was 48 h on the story's
// publishedAt only. Mark had approved the week's stories Tuesday 03:33Z, but the news agent
// had written them Monday 12:02Z — 49 h before the Wednesday draft — so every one of them
// missed the cutoff by about an hour and both drafts were saved with ZERO stories. The Friday
// auto-send then had nothing stopping it from mailing an empty issue to the whole list.
//
// Two rules, both Mark's:
//   • 48 h freshness stays (2026-08-29: "it's useless to send a storm story if the storm has
//     already dissipated"). The moment that counts is the LATER of when the story was written
//     and when Mark approved it — his approval is a judgement that it is news now.
//   • An issue with no stories is not an issue. Nothing sends it; Mark gets told instead.

export interface FreshnessRecord {
  publishedAt?: unknown;
  approvedAt?: unknown;
}

/** The time this story became news for the newsletter: the later of written / approved. NaN when neither parses. */
export function storyMoment(record: FreshnessRecord): number {
  const published = Date.parse(String(record.publishedAt ?? ""));
  const approved = Date.parse(String(record.approvedAt ?? ""));
  const moments = [published, approved].filter((t) => Number.isFinite(t));
  return moments.length ? Math.max(...moments) : Number.NaN;
}

/** Records whose moment falls inside the last `maxAgeHours`. A record with no parseable time is stale, never grandfathered. */
export function selectFreshStories<T extends FreshnessRecord>(records: T[], nowMs: number, maxAgeHours: number): T[] {
  const cutoff = nowMs - maxAgeHours * 3_600_000;
  return records.filter((r) => {
    const t = storyMoment(r);
    return Number.isFinite(t) && t >= cutoff;
  });
}

/** True when the draft carries at least one story. Both send paths refuse otherwise. */
export function issueHasStories(draft: { storyIds?: string[] } | null | undefined): boolean {
  return Array.isArray(draft?.storyIds) && draft.storyIds.length > 0;
}

/** The one sentence every refusal uses (route, Friday job, push to Mark). */
export const EMPTY_ISSUE_MESSAGE =
  "This issue has no stories — approve some in the Editorial Queue and re-draft before it can be sent.";
