// waiting-core.ts — the "Waiting on you: N" notification, pure and testable.
//
// Mark, 2026-10-22: one notification for everything that needs a decision. It always carries
// the same tag, so the phone shows at most one and updates it in place; its title is the count;
// its body says what is waiting; it opens the brief, where every item has its buttons.
//
// The list is COMPUTED LIVE from every source of truth (lib/waiting.ts collects it) — never
// stored, never incremented — so nothing can go stale: an approved story leaves the news queue
// and therefore leaves the count. Agents only say "something new is waiting"; this module
// decides whether that deserves a buzz: only when the set of waiting items gained a member
// since the last push. A removal never buzzes. The morning brief pushes regardless (Mark,
// 2026-06-29: always send, with a "nothing needs you" lead on quiet days).

export type WaitingGroup =
  | "decisions"   // public.actions rows: storm approvals, leads, agent-filed decisions
  | "news"        // news stories awaiting approval (newsagent queue)
  | "inbox"       // real email needing a reply (ops-manager Gmail queue)
  | "conflicts"   // calendar conflicts (ops-manager pending store)
  | "commentary"  // this week's commentary draft
  | "newsletter"  // newsletter draft (EN; ES follows EN approval, never asks)
  | "social"      // social post drafts
  | "affiliate"   // affiliate picks
  | "proposals";  // agent-filed task proposals

export interface WaitingItem {
  /** Stable identity of the item, e.g. `news:<story id>`. Drives "new since last push". */
  key: string;
  group: WaitingGroup;
  /** Short human label (a story headline, an email subject, a storm name). */
  label: string;
  /** Where to act. Absent = the brief page. */
  url?: string;
}

export const WAITING_TAG = "waiting-on-you";

/** Fixed order on the phone: decisions first, then the daily editorial queue, then the rest. */
export const GROUP_ORDER: readonly WaitingGroup[] = [
  "decisions", "news", "inbox", "conflicts", "commentary", "newsletter", "social", "affiliate", "proposals",
];

const one = (n: number, a: string, b: string) => (n === 1 ? a : b);

/** Plain-English phrase for N items of a group. */
export function phrase(group: WaitingGroup, n: number): string {
  switch (group) {
    case "decisions": return `${n} ${one(n, "decision", "decisions")} in your queue`;
    case "news": return `${n} news ${one(n, "story", "stories")} to approve`;
    case "inbox": return `${n} ${one(n, "email needs", "emails need")} your reply`;
    case "conflicts": return `${n} calendar ${one(n, "conflict", "conflicts")}`;
    case "commentary": return "this week's commentary to approve";
    case "newsletter": return n === 1 ? "a newsletter draft to approve" : `${n} newsletter drafts to approve`;
    case "social": return `${n} social ${one(n, "post", "posts")} to review`;
    case "affiliate": return `${n} affiliate ${one(n, "pick", "picks")} to review`;
    case "proposals": return `${n} agent ${one(n, "proposal", "proposals")} to decide`;
  }
}

/** Group a list into ordered (group, items) pairs, empty groups dropped. */
export function groupItems(items: WaitingItem[]): Array<[WaitingGroup, WaitingItem[]]> {
  const by = new Map<WaitingGroup, WaitingItem[]>();
  for (const it of items) by.set(it.group, [...(by.get(it.group) ?? []), it]);
  return GROUP_ORDER.filter((g) => by.has(g)).map((g) => [g, by.get(g) as WaitingItem[]]);
}

/**
 * "2 news stories to approve · 1 email needs your reply · Storm Nolo: approve the alert".
 * Decisions with their own title (≤ 2 of them) are named, not counted — a storm alert's name is
 * what makes Mark open it.
 */
export function describe(items: WaitingItem[]): string {
  return groupItems(items).map(([g, list]) => {
    if (g === "decisions" && list.length <= 2) return list.map((i) => i.label.slice(0, 60)).join(" · ");
    return phrase(g, list.length);
  }).join(" · ");
}

export interface SummaryOpts {
  /** Keys that were not in the previous push — named first. */
  newKeys?: ReadonlySet<string>;
  /** Today's calendar count, for the morning line. */
  events?: number;
  /** True for the 7 AM brief: full list + calendar, no "New:" line. */
  morning?: boolean;
}

export function summarizeWaiting(items: WaitingItem[], opts: SummaryOpts = {}): { title: string; body: string } {
  const n = items.length;
  const title = n ? `Waiting on you: ${n}` : "Nothing waiting on you";
  const cal = opts.events ? `${opts.events} on the calendar today` : "";
  if (!n) {
    return { title, body: ["Inbox, queue and drafts are clear.", cal].filter(Boolean).join(" · ") };
  }
  const fresh = opts.newKeys ? items.filter((i) => opts.newKeys!.has(i.key)) : [];
  if (!opts.morning && fresh.length && fresh.length < n) {
    const rest = items.filter((i) => !opts.newKeys!.has(i.key));
    return { title, body: `New: ${describe(fresh)}\nAlso waiting: ${describe(rest)}` };
  }
  if (!opts.morning && fresh.length) return { title, body: `New: ${describe(fresh)}` };
  return { title, body: [describe(items), cal].filter(Boolean).join("\n") };
}

export interface WaitingState { keys: string[]; at: string; total: number; reason?: string }
export interface WaitingPushResult {
  pushed: boolean; sent: number; pruned: number; total: number; added: number;
  title: string; body: string;
}

export interface PushWaitingDeps {
  load: () => Promise<WaitingState>;
  save: (s: WaitingState) => Promise<unknown>;
  push: (p: { title: string; body: string; url: string; tag: string }) => Promise<{ sent: number; pruned: number }>;
  url: () => string;
  now?: () => Date;
}

/**
 * Decide and (maybe) send. `force` = the morning brief. Otherwise a push goes out only when at
 * least one waiting item is new since the last push; a quiet run still records the current
 * set, so an item that leaves and later returns counts as new again.
 */
export async function pushWaitingWith(
  deps: PushWaitingDeps,
  opts: { items: WaitingItem[]; events?: number; force?: boolean; reason: string },
): Promise<WaitingPushResult> {
  const now = (deps.now ?? (() => new Date()))();
  const last = await deps.load().catch(() => ({ keys: [], at: "", total: 0 } as WaitingState));
  const lastSet = new Set(last.keys);
  const keys = opts.items.map((i) => i.key);
  const added = keys.filter((k) => !lastSet.has(k));
  const newKeys = new Set(added);
  const { title, body } = summarizeWaiting(opts.items, { newKeys, events: opts.events, morning: Boolean(opts.force) });

  if (!opts.force && added.length === 0) {
    await deps.save({ keys, at: last.at, total: opts.items.length, reason: `quiet: ${opts.reason}` });
    return { pushed: false, sent: 0, pruned: 0, total: opts.items.length, added: 0, title, body };
  }

  const res = await deps.push({ title, body, url: deps.url(), tag: WAITING_TAG });
  await deps.save({ keys, at: now.toISOString(), total: opts.items.length, reason: opts.reason });
  return { pushed: true, sent: res.sent, pruned: res.pruned, total: opts.items.length, added: added.length, title, body };
}
