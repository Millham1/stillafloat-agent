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

// "declined" = Mark pressed Not now (2026-10-29). It is a closed state like done.
export const ACTIVITY_STATUSES = ["done", "in-progress", "waiting-on-mark", "planned", "declined"] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

/**
 * A button on a waiting item — the same three shapes the brief's action queue
 * renders (lib/notify.ts NotifyButton): API (method + path under /api/), link
 * (href), or dismiss (an explicit "Not now"). Mark, 2026-10-29, looking at two
 * "Waiting on you" rows with nothing to press: "There is nothing here that takes
 * me to an action." So a waiting item MUST carry at least one button.
 */
export interface ActivityButton {
  label: string;
  method?: "GET" | "POST";
  path?: string;
  href?: string;
  dismiss?: boolean;
}

export interface ActivityEntry {
  at: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  status: ActivityStatus;
  link?: string;
  /** Present on a waiting item: what Mark can press. */
  buttons?: ActivityButton[];
  /** The public.actions row filed for this item (the brief shows the same buttons). */
  actionId?: string;
}

/** The newest 500 entries are kept — years of weekly work, and still a small row. */
export const ACTIVITY_CAP = 500;
export const TITLE_MAX = 200;
export const DETAIL_MAX = 4000;
export const LINK_MAX = 1000;
export const BUTTONS_MAX = 4;
export const BUTTON_LABEL_MAX = 40;

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
    /** Mark's switch from the dashboard (prompt-tests/on|off); the job reads it. */
    wanted?: boolean;
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

export type ButtonsCheck = { ok: true; buttons: ActivityButton[] } | { ok: false; error: string };

/** Up to four buttons, each exactly one shape: API (method + /api/ path), link, or dismiss. */
export function validateButtons(raw: unknown): ButtonsCheck {
  if (raw == null) return { ok: true, buttons: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "buttons must be a list" };
  if (raw.length > BUTTONS_MAX) return { ok: false, error: `at most ${BUTTONS_MAX} buttons` };
  const out: ActivityButton[] = [];
  for (const b of raw) {
    if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, error: "each button must be an object" };
    const o = b as Record<string, unknown>;
    const label = typeof o["label"] === "string" ? o["label"].trim() : "";
    if (!label || label.length > BUTTON_LABEL_MAX) return { ok: false, error: `a button needs a label of 1–${BUTTON_LABEL_MAX} characters` };
    const hasApi = o["path"] != null, hasHref = o["href"] != null, dismiss = o["dismiss"] === true;
    if ([hasApi, hasHref, dismiss].filter(Boolean).length !== 1) {
      return { ok: false, error: `button "${label}" must be one of: method+path, href, or dismiss` };
    }
    if (dismiss) { out.push({ label, dismiss: true }); continue; }
    if (hasHref) {
      const href = typeof o["href"] === "string" ? o["href"].trim() : "";
      if (!href || href.length > LINK_MAX || !validLink(href)) return { ok: false, error: `button "${label}": href must be an http(s) URL or a site path` };
      out.push({ label, href });
      continue;
    }
    const path = typeof o["path"] === "string" ? o["path"].trim() : "";
    if (!path.startsWith("/api/") || path.length > LINK_MAX || /[\s?#]/.test(path)) {
      return { ok: false, error: `button "${label}": path must be a site API path starting with /api/` };
    }
    const method = o["method"] == null ? "POST" : String(o["method"]).toUpperCase();
    if (method !== "GET" && method !== "POST") return { ok: false, error: `button "${label}": method must be GET or POST` };
    out.push({ label, method, path });
  }
  return { ok: true, buttons: out };
}

/** The source_ref that ties an activity item to its public.actions row. */
export function activitySourceRef(title: string): string {
  return "ai-visibility:" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

export type ActivityMatch = { actionId?: string; title?: string };
export type ActivityPatch = { status?: ActivityStatus; detail?: string; note?: string; buttons?: ActivityButton[]; actionId?: string; remove?: boolean };

/**
 * Change ONE stored item in place — the newest one that matches (by actionId, else by
 * title, case-insensitive). `note` appends a dated line to the detail; `detail` replaces
 * it. Returns the new list and the entry as it now reads, or null when nothing matched.
 * Does not modify the list it was given.
 */
export function patchActivity(existing: unknown, match: ActivityMatch, patch: ActivityPatch, now: Date = new Date()):
  { list: ActivityEntry[]; entry: ActivityEntry | null; before: ActivityEntry | null } {
  // `remove: true` drops the matched item instead (entry = what was removed).
  const list = Array.isArray(existing) ? [...(existing as ActivityEntry[])] : [];
  const want = (match.title ?? "").trim().toLowerCase();
  const i = list.findIndex((e) => e && typeof e === "object" && (
    (match.actionId && e.actionId === match.actionId) || (!match.actionId && want && String(e.title ?? "").trim().toLowerCase() === want)));
  if (i < 0) return { list, entry: null, before: null };
  const before = list[i]!;
  if (patch.remove) {
    // Retract a line (a wrong log entry, or the gate's dev fixture): gone from the log; the caller closes its action row.
    list.splice(i, 1);
    return { list, entry: { ...before }, before };
  }
  const entry: ActivityEntry = { ...before };
  if (patch.status) entry.status = patch.status;
  if (typeof patch.detail === "string") entry.detail = patch.detail.slice(0, DETAIL_MAX);
  if (patch.note) {
    const stamp = now.toISOString().slice(0, 10);
    entry.detail = `${entry.detail ? entry.detail + "\n\n" : ""}${stamp}: ${patch.note}`.slice(0, DETAIL_MAX);
  }
  if (patch.buttons) entry.buttons = patch.buttons;
  if (patch.actionId) entry.actionId = patch.actionId;
  if (entry.status !== "waiting-on-mark") delete entry.buttons; // a closed item has nothing to press
  list[i] = entry;
  return { list, entry, before };
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

  const buttons = validateButtons(b["buttons"]);
  if (!buttons.ok) return buttons;
  if (status === "waiting-on-mark" && buttons.buttons.length === 0) {
    return { ok: false, error: "an item that waits on Mark must carry at least one button he can press (buttons: [{label, method, path} | {label, href} | {label, dismiss: true}])" };
  }

  const entry: ActivityEntry = { at: now.toISOString(), kind: b["kind"] as ActivityKind, title, detail, status };
  if (buttons.buttons.length && status === "waiting-on-mark") entry.buttons = buttons.buttons;
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
