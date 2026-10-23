// waiting.ts — collects everything waiting on Mark, LIVE, from each source of truth, and
// sends the one "Waiting on you: N" notification (lib/waiting-core.ts decides when).
//
// Why live and not a stored list: a stored "waiting" row has to be cleared by every path
// that resolves it, and the brief's needs-action list carried emails Mark had answered days
// earlier (Mark, 2026-10-08: "stale actions are a bug"). Reading each queue at the moment of
// asking cannot go stale. A source that cannot be reached is reported in `down` and shown on
// the brief, never silently counted as empty (incident 2026-08-31: a starved pipeline and a
// quiet day looked identical).
//
// Sources, in the order the phone lists them (GROUP_ORDER in waiting-core.ts):
//   decisions   public.actions pending rows            lib/actions.ts
//   news        stories with no decision yet           newsagent GET /api/editorial-queue
//   inbox       Gmail threads needing a reply          ops-manager /brief/feed (passed in)
//   conflicts   calendar conflicts                     ops-manager GET /brief/conflicts
//   commentary  draft awaiting take/approval           lib/commentary-agent.ts
//   newsletter  EN draft pending (ES follows approval) lib/newsletter.ts
//   social      pending post batches                   lib/social-agent.ts (passed in)
//   affiliate   pending picks                          lib/affiliate-agent.ts
//   proposals   public.tasks status 'proposed'         Mark, 2026-10-?: agent-filed tasks need his yes

import { listPendingActions } from "./actions";
import { loadDraft } from "./newsletter";
import { loadCommentaryDraft } from "./commentary-agent";
import { loadPending } from "./affiliate-agent";
import { getSupabase, readJson, writeJson } from "./persistence";
import { sendPush } from "./push";
import { reviewUrl } from "./notify";
import { logger } from "./logger";
import {
  pushWaitingWith, type WaitingItem, type WaitingPushResult, type WaitingState,
} from "./waiting-core";

export type { WaitingItem, WaitingGroup, WaitingPushResult } from "./waiting-core";
export { summarizeWaiting, describe, WAITING_TAG } from "./waiting-core";

const OPS_BASE = (process.env["OPS_MANAGER_URL"] ?? "http://127.0.0.1:5000").replace(/\/+$/, "");
const NEWS_BASE = (process.env["NEWSAGENT_URL"] ?? "http://127.0.0.1:3003").replace(/\/+$/, "");
const STATE_KEY = "waiting-last-push";

function dashboardBase(): string {
  return (process.env["DASHBOARD_URL"] || "https://dashboard.stillafloatcruising.com").replace(/\/$/, "");
}
function briefUrl(): string {
  return `${dashboardBase()}/brief.html`;
}
/** The news review page, with the token in the link — the same link the nudge has always carried. */
export function newsReviewUrl(): string {
  const tok = process.env["AGENT_APPROVAL_TOKEN"];
  return `${dashboardBase()}/review${tok ? `?token=${encodeURIComponent(tok)}` : ""}`;
}

export interface CollectInputs {
  /** The ops feed's Gmail "needs your reply" rows (brief.ts fetches the feed once). */
  inbox: Array<{ thread_id: string; subject: string; url: string }>;
  /** Pending social batches (brief.ts loads the queue once). */
  social: Array<{ videoId: string; track: string; lang: string; title: string }>;
}

export interface Collected {
  items: WaitingItem[];
  /** Sources that could not be read this time, by name. Shown on the brief, never hidden. */
  down: string[];
}

async function newsPending(): Promise<WaitingItem[]> {
  const tok = process.env["AGENT_APPROVAL_TOKEN"] ?? "";
  const r = await fetch(`${NEWS_BASE}/api/editorial-queue`, {
    headers: { "x-affiliate-token": tok, Authorization: `Bearer ${tok}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`newsagent editorial-queue HTTP ${r.status}`);
  const j = (await r.json()) as { success?: boolean; stories?: Array<{ id?: string; title?: string; status?: string | null }> };
  if (!j.success || !Array.isArray(j.stories)) throw new Error("newsagent editorial-queue: no stories array");
  const url = newsReviewUrl();
  return j.stories
    .filter((s) => !s.status) // a decided story (approved/featured/held/rejected) carries its status
    .map((s) => ({ key: `news:${s.id ?? s.title ?? ""}`, group: "news" as const, label: String(s.title ?? "Untitled"), url }));
}

async function conflictsPending(): Promise<WaitingItem[]> {
  const key = process.env["IDEAS_API_KEY"];
  if (!key) throw new Error("IDEAS_API_KEY unset");
  const r = await fetch(`${OPS_BASE}/brief/conflicts`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`ops conflicts HTTP ${r.status}`);
  const j = (await r.json()) as { conflicts?: Array<{ key?: string; new_title?: string; existing_title?: string }> };
  return (j.conflicts ?? []).map((c) => ({
    key: `conflict:${c.key ?? ""}`, group: "conflicts" as const,
    label: `${c.new_title ?? "New event"} clashes with ${c.existing_title ?? "an existing one"}`,
  }));
}

async function proposalsPending(): Promise<WaitingItem[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (getSupabase().from("tasks") as any)
    .select("id,title").eq("status", "proposed").limit(50);
  if (error) throw new Error(`tasks proposed: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; title: string }>)
    .map((t) => ({ key: `proposal:${t.id}`, group: "proposals" as const, label: t.title, url: briefUrl() }));
}

/** Read every source. Each failure is named in `down`; the others still count. */
export async function collectWaiting(input: CollectInputs): Promise<Collected> {
  const down: string[] = [];
  const guard = async (name: string, fn: () => Promise<WaitingItem[]>): Promise<WaitingItem[]> => {
    try { return await fn(); } catch (err) {
      logger.warn({ err, source: name }, "waiting: source unreadable");
      down.push(name);
      return [];
    }
  };

  const [decisions, news, conflicts, commentary, newsletter, affiliate, proposals] = await Promise.all([
    guard("decisions", async () => (await listPendingActions()).map((a) => ({
      key: `action:${a.id}`, group: "decisions" as const, label: a.title, url: briefUrl(),
    }))),
    guard("news", newsPending),
    guard("conflicts", conflictsPending),
    guard("commentary", async () => {
      const d = await loadCommentaryDraft();
      return d && (d.status === "awaiting_take" || d.status === "drafted")
        ? [{ key: `commentary:${d.generatedAt}`, group: "commentary" as const, label: d.suggestedTitle || "This week's commentary", url: reviewUrl("/api/commentary/review") }]
        : [];
    }),
    guard("newsletter", async () => {
      // EN only: Mark approves English; Spanish follows automatically and never asks (2026-10-08).
      const d = await loadDraft("en");
      return d && d.status === "pending"
        ? [{ key: `newsletter:en:${d.generatedAt ?? d.subject}`, group: "newsletter" as const, label: d.subject, url: reviewUrl("/api/newsletter/review?lang=en") }]
        : [];
    }),
    guard("affiliate", async () => (await loadPending()).items.map((i, idx) => ({
      key: `affiliate:${(i as { id?: string; asin?: string }).id ?? (i as { asin?: string }).asin ?? `${idx}:${i.title}`}`,
      group: "affiliate" as const, label: i.title, url: reviewUrl("/api/affiliate/review"),
    }))),
    guard("proposals", proposalsPending),
  ]);

  const inbox: WaitingItem[] = input.inbox.map((a) => ({ key: `inbox:${a.thread_id}`, group: "inbox", label: a.subject, url: a.url }));
  const social: WaitingItem[] = input.social.map((b) => ({
    key: `social:${b.videoId}:${b.track}:${b.lang}`, group: "social", label: b.title, url: reviewUrl("/api/social/review"),
  }));

  return { items: [...decisions, ...news, ...inbox, ...conflicts, ...commentary, ...newsletter, ...social, ...affiliate, ...proposals], down };
}

/** Send the one notification if something new is waiting (always, for the morning brief). */
export async function pushWaiting(opts: { items: WaitingItem[]; events?: number; force?: boolean; reason: string }): Promise<WaitingPushResult> {
  const r = await pushWaitingWith({
    load: () => readJson<WaitingState>(STATE_KEY, { keys: [], at: "", total: 0 }),
    save: (s) => writeJson(STATE_KEY, s),
    push: sendPush,
    url: briefUrl,
  }, opts);
  logger.info(
    { pushed: r.pushed, sent: r.sent, pruned: r.pruned, total: r.total, added: r.added, reason: opts.reason, title: r.title },
    r.pushed ? "waiting: notification sent" : "waiting: nothing new — no push",
  );
  return r;
}
