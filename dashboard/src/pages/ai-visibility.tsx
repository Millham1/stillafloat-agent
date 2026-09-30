// AI Visibility — are ChatGPT, Claude, Perplexity and Gemini reading the site
// and recommending Mark, and what is the agent doing about it?
//
// Mark, 2026-09-29, approving the program: "give me a page on the dashboard so I
// can track your activity." Sections, top to bottom:
//   1. Headline strip — last full week's live AI lookups and the visits AI
//      assistants sent, against the week before, with a one-line "so what".
//   2. What the agent did — the activity log, newest first (the reason this
//      page exists).
//   3. AI lookups by week + the pages the assistants read most.
//   4. AI crawlers over the measurement window.
//   5. Viewers who said it helped — YouTube praise comments.
//   6. Questions worth answering — forum threads matched to our pages.
//   7. Do the assistants recommend Mark? — prompt tests (off until Mark OKs the cost).
//
// Data: GET /api/ai-visibility (routes/ai-visibility.ts). A separate job fills
// the measurements daily; any field may be missing, so every section has its own
// empty state. Same fetch + authHeaders pattern as search.tsx / diversions.tsx.

import { type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Bot, MousePointerClick, RefreshCw, ListChecks, BarChart3, Radar, ThumbsUp, MessagesSquare, Sparkles, ExternalLink,
} from "lucide-react";
import { authHeaders } from "@/lib/auth-token";

type Counts = Record<string, number>;
type Week = {
  weekStart: string;
  assistants?: Counts;
  referrals?: Counts;
  topPages?: { path: string; assistant: string; count: number }[];
};
type Status = "done" | "in-progress" | "waiting-on-mark" | "planned";
type Activity = { at: string; kind: string; title: string; detail?: string; status?: Status; link?: string };
type Praise = {
  videoId: string; videoTitle: string; author: string; text: string;
  likes: number; publishedAt: string; why: string; used: boolean;
};
type ForumItem = {
  source: "reddit" | "cruisecritic"; url: string; title: string; postedAt: string;
  matchedPage: string | null; reason: string; status: "new" | "answered" | "skipped";
};
type PromptRun = { at: string; assistant: string; prompt: string; mentionedMark: boolean; mentionedSite: boolean; excerpt: string };
type Payload = {
  success: boolean;
  error?: string;
  updatedAt?: string;
  lookups?: { days?: number; generatedAt?: string; weeks?: Week[]; crawlers?: Counts };
  activity?: Activity[];
  praise?: Praise[];
  forum?: ForumItem[];
  promptTests?: { enabled?: boolean; costNote?: string; runs?: PromptRun[] };
};

const SITE = "https://stillafloatcruising.com";
const NO_DATA = "No data yet — the measurement job runs daily.";

const ASSISTANT_NAME: Record<string, string> = {
  chatgpt: "ChatGPT", claude: "Claude", perplexity: "Perplexity", gemini: "Gemini", copilot: "Copilot", other: "Other",
};
const LOOKUP_ASSISTANTS = ["chatgpt", "claude", "perplexity", "other"];

// What each crawler is, in one line — the job reports them by user-agent name.
const CRAWLER_NOTE: Record<string, string> = {
  GPTBot: "OpenAI — collects pages for ChatGPT's models",
  "OAI-SearchBot": "OpenAI — builds ChatGPT's search results",
  ClaudeBot: "Anthropic — collects pages for Claude",
  PerplexityBot: "Perplexity — builds its search index",
  Applebot: "Apple — Siri, Spotlight and Apple Intelligence",
  "Google-Extended": "Google — Gemini's use of Google's crawl",
};

const STATUS_WORD: Record<Status, string> = {
  done: "Done", "in-progress": "In progress", "waiting-on-mark": "Waiting on you", planned: "Planned",
};
const STATUS_CLASS: Record<Status, string> = {
  done: "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800",
  "in-progress": "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-800",
  "waiting-on-mark": "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800",
  planned: "text-muted-foreground",
};
const KIND_WORD: Record<string, string> = {
  "domain-block": "Domain block", takedown: "Takedown", page: "Page", llms: "llms.txt", schema: "Markup",
  praise: "Praise", forum: "Forum", "prompt-test": "Prompt test", measure: "Measurement", note: "Note",
};
const FORUM_CLASS: Record<ForumItem["status"], string> = {
  new: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800",
  answered: "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800",
  skipped: "text-muted-foreground",
};

const num = (n: number | undefined) => (n == null ? "—" : new Intl.NumberFormat("en-US").format(n));
const sum = (c: Counts | undefined) => Object.values(c ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const assistantName = (k: string) => ASSISTANT_NAME[k.toLowerCase()] ?? k;

function when(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function day(iso: string | undefined): string {
  if (!iso) return "";
  // A bare YYYY-MM-DD is a calendar date, not midnight UTC — read it as local.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Only http(s) links leave the dashboard; site paths go to the public site, not the dashboard host. */
function safeHref(link: string | null | undefined): string | null {
  if (!link) return null;
  if (link.startsWith("/") && !link.startsWith("//")) return `${SITE}${link}`;
  try {
    const u = new URL(link);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** A week counts once all 7 days of it are over. */
function isFull(weekStart: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(`${weekStart}T00:00:00`);
  return !Number.isNaN(start.getTime()) && start.getTime() + 7 * 86_400_000 <= today.getTime();
}

/** The newest week that has fully ended, and the one before it. */
function fullWeeks(weeks: Week[]): { last?: Week; prev?: Week } {
  const done = weeks.filter((w) => isFull(w.weekStart)).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  return { last: done[done.length - 1], prev: done[done.length - 2] };
}

function change(now: number, before: number | undefined, unit: string): string {
  if (before == null) return "no earlier week to compare";
  const d = now - before;
  if (d === 0) return `same as the week before (${plural(before, unit)})`;
  return `${d > 0 ? "up" : "down"} ${plural(Math.abs(d), unit)} from the week before (${num(before)})`;
}

function Section({ icon: Icon, title, note, children }: { icon: typeof Bot; title: string; note?: string; children: ReactNode }) {
  return (
    <Card>
      <div className="px-4 py-3 border-b">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        {note && <p className="text-xs text-muted-foreground mt-0.5">{note}</p>}
      </div>
      {children}
    </Card>
  );
}

function Empty({ text = NO_DATA }: { text?: string }) {
  return <div className="px-4 py-8 text-center text-sm text-muted-foreground">{text}</div>;
}

export default function AiVisibility() {
  const { data, isLoading, isFetching, isError, refetch } = useQuery<Payload>({
    queryKey: ["ai-visibility"],
    queryFn: () => fetch("/api/ai-visibility", { headers: { ...authHeaders() } }).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  const failed = data && data.success === false;
  const weeks = [...(data?.lookups?.weeks ?? [])].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  const windowDays = data?.lookups?.days;
  const { last, prev } = fullWeeks(weeks);
  const lookupsLast = sum(last?.assistants);
  const visitsLast = sum(last?.referrals);
  const lookupsPrev = prev ? sum(prev.assistants) : undefined;
  const visitsPrev = prev ? sum(prev.referrals) : undefined;

  const activity = data?.activity ?? [];
  const waiting = activity.filter((a) => a.status === "waiting-on-mark").length;

  // Top pages across the whole window: total reads per page, split by assistant.
  const pageTotals = new Map<string, { total: number; by: Counts }>();
  for (const w of weeks) {
    for (const p of w.topPages ?? []) {
      const row = pageTotals.get(p.path) ?? { total: 0, by: {} };
      row.total += Number(p.count) || 0;
      row.by[p.assistant] = (row.by[p.assistant] ?? 0) + (Number(p.count) || 0);
      pageTotals.set(p.path, row);
    }
  }
  const topPages = [...pageTotals.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 12);
  const maxWeek = Math.max(1, ...weeks.map((w) => sum(w.assistants)));

  const crawlers = Object.entries(data?.lookups?.crawlers ?? {}).sort((a, b) => b[1] - a[1]);
  const praise = data?.praise ?? [];
  const forum = data?.forum ?? [];
  const pt = data?.promptTests;
  const runs = pt?.runs ?? [];
  const namedMark = runs.filter((r) => r.mentionedMark).length;
  const namedSite = runs.filter((r) => r.mentionedSite).length;

  const soWhat = last
    ? lookupsLast === 0 && visitsLast === 0
      ? "No assistant opened a page or sent a visitor last week — the work below is about changing that."
      : `AI assistants opened your pages ${plural(lookupsLast, "time")} while answering people's questions last week, and ${plural(visitsLast, "person", "people")} clicked through to the site from an assistant's answer.`
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="h-6 w-6 text-sky-600" />
            <h2 className="text-xl font-bold tracking-tight">AI Visibility</h2>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Whether ChatGPT, Claude, Perplexity and Gemini read the site and recommend you — and what the agent is doing about it.
            {data?.updatedAt ? ` Measurements last updated ${when(data.updatedAt)}.` : ""}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border hover:bg-muted disabled:opacity-60 transition-colors font-medium"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {(failed || (isError && !data)) && (
        <Card className="p-4 text-sm text-destructive">
          {data?.error ?? "Could not reach the server for the AI visibility data. Try Refresh in a minute."}
        </Card>
      )}

      {/* 1 · Headline strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <Bot className="w-5 h-5 text-sky-500" />
            <div className="min-w-0">
              <div className="text-xl font-bold">{isLoading ? "…" : last ? plural(lookupsLast, "lookup") : "—"}</div>
              <div className="text-xs text-muted-foreground">
                AI live lookups{last ? `, week of ${day(last.weekStart)}` : ""}
              </div>
            </div>
          </div>
          {last ? (
            <>
              <p className="text-xs mt-2">
                {LOOKUP_ASSISTANTS.map((k) => `${assistantName(k)} ${num(last.assistants?.[k] ?? 0)}`).join(" · ")}
              </p>
              <p className="text-xs text-muted-foreground mt-1 leading-snug">
                Times an assistant opened one of your pages mid-answer — {change(lookupsLast, lookupsPrev, "lookup")}.
              </p>
            </>
          ) : (
            !isLoading && <p className="text-xs text-muted-foreground mt-2">No full week measured yet — the measurement job runs daily.</p>
          )}
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <MousePointerClick className="w-5 h-5 text-green-500" />
            <div className="min-w-0">
              <div className="text-xl font-bold">{isLoading ? "…" : last ? plural(visitsLast, "visit") : "—"}</div>
              <div className="text-xs text-muted-foreground">
                Visits sent by AI assistants{last ? `, week of ${day(last.weekStart)}` : ""}
              </div>
            </div>
          </div>
          {last ? (
            <>
              <p className="text-xs mt-2">
                {Object.entries(last.referrals ?? {}).map(([k, v]) => `${assistantName(k)} ${num(v)}`).join(" · ") || "None"}
              </p>
              <p className="text-xs text-muted-foreground mt-1 leading-snug">
                People who clicked a link to the site in an assistant's answer — {change(visitsLast, visitsPrev, "visit")}.
              </p>
            </>
          ) : (
            !isLoading && <p className="text-xs text-muted-foreground mt-2">No full week measured yet — the measurement job runs daily.</p>
          )}
        </Card>
      </div>
      {soWhat && <p className="text-sm -mt-3"><b>So what:</b> {soWhat}</p>}

      {/* 2 · What the agent did */}
      <Section
        icon={ListChecks}
        title="What the agent did"
        note={`Newest first.${waiting ? ` ${plural(waiting, "item")} waiting on you.` : ""}`}
      >
        {isLoading ? (
          <Empty text="Loading…" />
        ) : activity.length === 0 ? (
          <Empty text="Nothing logged yet — every change the agent makes for this program will appear here." />
        ) : (
          <div className="divide-y divide-border">
            {activity.map((a, i) => {
              const href = safeHref(a.link);
              const status = a.status ?? "done";
              return (
                <div key={`${a.at}|${i}`} className="px-4 py-3 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4">
                  <div className="text-xs text-muted-foreground whitespace-nowrap sm:w-32 flex-shrink-0">{when(a.at)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{a.title}</span>
                      <Badge variant="outline" className="text-xs">{KIND_WORD[a.kind] ?? a.kind}</Badge>
                    </div>
                    {a.detail && <p className="text-xs text-muted-foreground mt-1 whitespace-pre-line">{a.detail}</p>}
                    {href && (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="text-xs text-primary inline-flex items-center gap-1 mt-1 hover:underline">
                        Open <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                  <Badge variant="outline" className={`self-start ${STATUS_CLASS[status] ?? ""}`}>{STATUS_WORD[status] ?? status}</Badge>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* 3 · Lookups by week + top pages */}
      <div className="space-y-6">
        <Section
          icon={BarChart3}
          title="AI lookups by week"
          note="Live lookups per assistant (times it opened a page mid-answer) and the visits assistants sent to the site. Newest week first."
        >
          {weeks.length === 0 ? (
            <Empty text={isLoading ? "Loading…" : NO_DATA} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left px-4 py-2.5 font-semibold text-muted-foreground">Week of</th>
                    {LOOKUP_ASSISTANTS.map((k) => (
                      <th key={k} className="text-right px-2 py-2.5 font-semibold text-muted-foreground">{assistantName(k)}</th>
                    ))}
                    <th className="text-left px-4 py-2.5 font-semibold text-muted-foreground">Lookups</th>
                    <th className="text-right px-4 py-2.5 font-semibold text-muted-foreground">Visits</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {weeks.map((w) => {
                    const total = sum(w.assistants);
                    return (
                      <tr key={w.weekStart} className="hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          {day(w.weekStart)}
                          {!isFull(w.weekStart) && <span className="text-xs text-muted-foreground"> (so far)</span>}
                        </td>
                        {LOOKUP_ASSISTANTS.map((k) => (
                          <td key={k} className="px-2 py-2.5 text-right font-mono text-muted-foreground">{num(w.assistants?.[k] ?? 0)}</td>
                        ))}
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="h-2 rounded bg-sky-500/70" style={{ width: `${Math.max(2, (total / maxWeek) * 80)}px` }} />
                            <span className="font-mono">{num(total)}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono">{num(sum(w.referrals))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section
          icon={Bot}
          title="Pages the assistants read most"
          note={`Live lookups per page${windowDays ? ` over the last ${plural(windowDays, "day")}` : ""}. These are the pages AI answers are built from — keep them current.`}
        >
          {topPages.length === 0 ? (
            <Empty text={isLoading ? "Loading…" : NO_DATA} />
          ) : (
            <div className="divide-y divide-border">
              {topPages.map(([path, row]) => (
                <div key={path} className="px-4 py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <a href={safeHref(path) ?? undefined} target="_blank" rel="noopener noreferrer" className="text-sm font-medium truncate block hover:underline" title={path}>
                      {path}
                    </a>
                    <div className="text-xs text-muted-foreground">
                      {Object.entries(row.by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${assistantName(k)} ${num(v)}`).join(" · ")}
                    </div>
                  </div>
                  <span className="text-sm font-mono text-sky-600 flex-shrink-0">{plural(row.total, "lookup")}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      {/* 4 · Crawlers */}
      <Section
        icon={Radar}
        title="AI crawlers"
        note={`Pages fetched by each AI company's crawler${windowDays ? ` over the last ${plural(windowDays, "day")}` : ""}. Crawls feed what the assistants know about you between live lookups.`}
      >
        {crawlers.length === 0 ? (
          <Empty text={isLoading ? "Loading…" : NO_DATA} />
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 divide-y sm:divide-y-0 divide-border">
            {crawlers.map(([name, n]) => (
              <div key={name} className="px-4 py-3">
                <div className="text-sm font-medium">{name}</div>
                <div className="text-sm font-mono text-sky-600 whitespace-nowrap">{plural(n, "page fetched", "pages fetched")}</div>
                <div className="text-xs text-muted-foreground">{CRAWLER_NOTE[name] ?? ""}</div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 5 · Praise */}
      <Section
        icon={ThumbsUp}
        title="Viewers who said it helped"
        note="YouTube comments where a viewer says a video helped them — candidates for quotes on the site."
      >
        {praise.length === 0 ? (
          <Empty text={isLoading ? "Loading…" : NO_DATA} />
        ) : (
          <div className="divide-y divide-border">
            {praise.map((p, i) => (
              <div key={`${p.videoId}|${p.author}|${i}`} className="px-4 py-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <a
                    href={`https://www.youtube.com/watch?v=${encodeURIComponent(p.videoId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium hover:underline"
                  >
                    {p.videoTitle || p.videoId}
                  </a>
                  <Badge variant="outline" className={`text-xs ${p.used ? STATUS_CLASS.done : "text-muted-foreground"}`}>
                    {p.used ? "Used on the site" : "Not used yet"}
                  </Badge>
                </div>
                <blockquote className="text-sm mt-1 border-l-2 pl-3 italic">“{p.text}”</blockquote>
                <div className="text-xs text-muted-foreground mt-1">
                  — {p.author} · {day(p.publishedAt)} · {plural(Number(p.likes) || 0, "like")}
                </div>
                {p.why && <p className="text-xs text-muted-foreground mt-1">Why it matters: {p.why}</p>}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 6 · Forum */}
      <Section
        icon={MessagesSquare}
        title="Questions worth answering"
        note="Reddit and Cruise Critic threads asking something one of your pages already answers."
      >
        {forum.length === 0 ? (
          <Empty text={isLoading ? "Loading…" : NO_DATA} />
        ) : (
          <div className="divide-y divide-border">
            {forum.map((f, i) => {
              const href = safeHref(f.url);
              const page = safeHref(f.matchedPage);
              return (
                <div key={`${f.url}|${i}`} className="px-4 py-3 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-xs">{f.source === "cruisecritic" ? "Cruise Critic" : "Reddit"}</Badge>
                      {href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="text-sm font-medium hover:underline inline-flex items-center gap-1">
                          {f.title} <ExternalLink className="w-3 h-3" />
                        </a>
                      ) : (
                        <span className="text-sm font-medium">{f.title}</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Posted {day(f.postedAt)}
                      {f.matchedPage && (
                        <>
                          {" · Our answer: "}
                          {page ? <a href={page} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{f.matchedPage}</a> : f.matchedPage}
                        </>
                      )}
                    </div>
                    {f.reason && <p className="text-xs text-muted-foreground mt-1">{f.reason}</p>}
                  </div>
                  <Badge variant="outline" className={`self-start capitalize ${FORUM_CLASS[f.status] ?? ""}`}>{f.status}</Badge>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* 7 · Prompt tests */}
      <Section
        icon={Sparkles}
        title="Do the assistants recommend Mark?"
        note="We ask the assistants the questions a cruiser would ask and check whether the answer names you or the site."
      >
        {pt?.enabled !== true && (
          <div className="px-4 py-3 border-b">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-300">Off — waiting for Mark's OK on cost</p>
            {pt?.costNote && <p className="text-xs text-muted-foreground mt-1">{pt.costNote}</p>}
          </div>
        )}
        {runs.length === 0 ? (
          <Empty text={isLoading ? "Loading…" : pt?.enabled ? NO_DATA : "No tests run yet."} />
        ) : (
          <>
            <p className="px-4 pt-3 text-sm">
              You were named in <b>{namedMark} of {plural(runs.length, "answer")}</b>; the site was named in {namedSite} of {runs.length}.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left px-4 py-2.5 font-semibold text-muted-foreground">When</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-muted-foreground">Assistant</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-muted-foreground">Question asked</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-muted-foreground">Named Mark?</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-muted-foreground">Named the site?</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-muted-foreground">What it said</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {runs.map((r, i) => (
                    <tr key={`${r.at}|${i}`} className="align-top">
                      <td className="px-4 py-2.5 whitespace-nowrap text-xs">{when(r.at)}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap">{assistantName(r.assistant)}</td>
                      <td className="px-4 py-2.5 min-w-[14rem]">{r.prompt}</td>
                      <td className={`px-4 py-2.5 ${r.mentionedMark ? "text-green-600 font-medium" : "text-muted-foreground"}`}>{r.mentionedMark ? "Yes" : "No"}</td>
                      <td className={`px-4 py-2.5 ${r.mentionedSite ? "text-green-600 font-medium" : "text-muted-foreground"}`}>{r.mentionedSite ? "Yes" : "No"}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground min-w-[18rem]">{r.excerpt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}
