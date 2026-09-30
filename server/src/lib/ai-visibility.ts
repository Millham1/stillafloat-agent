// ai-visibility.ts — the data behind the dashboard's AI Visibility page.
//
// Program goal (Mark's OK, 2026-09-29): get AI assistants — ChatGPT, Claude,
// Perplexity, Gemini — to cite the site and recommend Mark as an advisor. Mark:
// "give me a page on the dashboard so I can track your activity."
//
// Everything lives in ONE platform_state row, id "ai-visibility". A separate
// Python job fills the measurements (lookups, crawlers, praise, forum,
// promptTests); this server only reads them and appends to `activity` — the
// agent's log of what it did. Every field may be missing: the page renders an
// empty state for each section rather than failing on a first run.
//
// Pure helpers first (unit-tested in ai-visibility.test.ts); no I/O here.

export const ACTIVITY_KINDS = [
  "domain-block", "takedown", "page", "llms", "schema", "praise",
  "forum", "prompt-test", "measure", "note",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_STATUSES = ["done", "in-progress", "waiting-on-mark", "planned"] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export interface ActivityEntry {
  at: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  status: ActivityStatus;
  link?: string;
}

/** The newest 500 entries are kept — years of weekly work, and still a small row. */
export const ACTIVITY_CAP = 500;
export const TITLE_MAX = 200;
export const DETAIL_MAX = 4000;
export const LINK_MAX = 1000;

type Counts = Record<string, number>;

export interface AiVisibilityPayload {
  updatedAt?: string;
  lookups?: {
    days?: number;
    generatedAt?: string;
    weeks?: {
      weekStart: string;
      assistants?: Counts;
      referrals?: Counts;
      topPages?: { path: string; assistant: string; count: number }[];
    }[];
    crawlers?: Counts;
  };
  activity?: ActivityEntry[];
  praise?: {
    videoId: string; videoTitle: string; author: string; text: string;
    likes: number; publishedAt: string; why: string; used: boolean;
  }[];
  forum?: {
    source: "reddit" | "cruisecritic"; url: string; title: string; postedAt: string;
    matchedPage: string | null; reason: string; status: "new" | "answered" | "skipped";
  }[];
  promptTests?: {
    enabled?: boolean;
    costNote?: string;
    runs?: {
      at: string; assistant: string; prompt: string;
      mentionedMark: boolean; mentionedSite: boolean; excerpt: string;
    }[];
  };
}

export type ActivityCheck = { ok: true; entry: ActivityEntry } | { ok: false; error: string };

/** A link is an absolute http(s) URL or a site path ("/news/x.html"). */
function validLink(s: string): boolean {
  if (s.startsWith("/") && !s.startsWith("//")) return true;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Validate a POST /api/ai-visibility/activity body and stamp it. `status`
 * defaults to "done" (the common case: the agent logs work it finished);
 * `at` is always the server's clock, never the caller's.
 */
export function validateActivity(body: unknown, now: Date = new Date()): ActivityCheck {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body must be a JSON object" };
  const b = body as Record<string, unknown>;

  if (typeof b["kind"] !== "string" || !(ACTIVITY_KINDS as readonly string[]).includes(b["kind"])) {
    return { ok: false, error: `kind must be one of: ${ACTIVITY_KINDS.join(", ")}` };
  }
  const title = typeof b["title"] === "string" ? b["title"].trim() : "";
  if (!title) return { ok: false, error: "title is required" };
  if (title.length > TITLE_MAX) return { ok: false, error: `title is longer than ${TITLE_MAX} characters` };

  if (b["detail"] != null && typeof b["detail"] !== "string") return { ok: false, error: "detail must be text" };
  const detail = typeof b["detail"] === "string" ? b["detail"].trim() : "";
  if (detail.length > DETAIL_MAX) return { ok: false, error: `detail is longer than ${DETAIL_MAX} characters` };

  let status: ActivityStatus = "done";
  if (b["status"] != null) {
    if (typeof b["status"] !== "string" || !(ACTIVITY_STATUSES as readonly string[]).includes(b["status"])) {
      return { ok: false, error: `status must be one of: ${ACTIVITY_STATUSES.join(", ")}` };
    }
    status = b["status"] as ActivityStatus;
  }

  const entry: ActivityEntry = { at: now.toISOString(), kind: b["kind"] as ActivityKind, title, detail, status };
  if (b["link"] != null && b["link"] !== "") {
    const link = typeof b["link"] === "string" ? b["link"].trim() : "";
    if (!link || link.length > LINK_MAX || !validLink(link)) {
      return { ok: false, error: "link must be an http(s) URL or a site path starting with /" };
    }
    entry.link = link;
  }
  return { ok: true, entry };
}

/** Newest first, capped. Tolerates a stored `activity` that is missing or not an array. */
export function prependActivity(existing: unknown, entry: ActivityEntry, cap: number = ACTIVITY_CAP): ActivityEntry[] {
  const list = Array.isArray(existing) ? (existing as ActivityEntry[]) : [];
  return [entry, ...list].slice(0, Math.max(1, cap));
}
