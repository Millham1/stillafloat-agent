// Search — the CEO's SEO cockpit.
//
// "Pull the data and present it to me as if I'm the CEO making business
// decisions and can live on the dashboard." Three layers, top to bottom:
//   1. Headline strip — the four Search Console vitals (28d, vs the 90-day
//      pace) with a clicks sparkline. Every number gets a one-line "so what".
//   2. Money board — the same query data ranked into decisions, not metrics:
//      WINNING (defend), STRIKING DISTANCE (cheap wins; shows the prize as
//      expected clicks at a page-1 CTR of 8%), CONTENT GAPS (content plays).
//   3. Proposals — the agent's filed corrections (status='proposed' tasks) with
//      Approve/Dismiss, each stating exactly what happens on approve: payloaded
//      title/meta rewrites are applied to the live pages automatically
//      (server-side executor); everything else lands on the task list.
//
// Data: /api/ops/gsc/* (proxy → ops-manager Search Console API) and
// /api/ops/seo-proposals; Approve/Dismiss hit the existing /api/proposals/:id
// endpoints. Same fetch + authHeaders pattern as finance.tsx / storm-alerts.tsx.

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MousePointerClick, Eye, Percent, MapPin, Trophy, Crosshair, Lightbulb, Sparkles, RefreshCw } from "lucide-react";
import { authHeaders } from "@/lib/auth-token";
import { useToast } from "@/hooks/use-toast";

type Row = { query: string; clicks: number; impressions: number; ctr: number; position: number };
type TrendRow = { date: string; clicks: number; impressions: number };
type Gsc = {
  ok: boolean;
  period_days: number;
  start: string;
  end: string;
  totals: { clicks: number; impressions: number; ctr: number; position: number };
  top_queries: Row[];
  top_pages: { page: string; clicks: number; impressions: number; ctr: number; position: number }[];
  trend: TrendRow[];
};
type Proposal = {
  id: string;
  title: string;
  detail: string | null;
  priority: number;
  category: string | null;
  payload: { type?: string; page?: string; storyId?: string; title?: string; metaDescription?: string } | null;
  created_at: string;
};

const num = (n: number | undefined) => (n == null ? "—" : new Intl.NumberFormat("en-US").format(n));

function useApi<T>(url: string, key: string[]) {
  return useQuery<T>({
    queryKey: key,
    queryFn: () => fetch(url, { headers: { ...authHeaders() } }).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });
}

// Tiny inline sparkline (clicks/day over the window).
function Sparkline({ trend }: { trend: TrendRow[] }) {
  if (!trend || trend.length < 2) return null;
  const w = 120, h = 28;
  const max = Math.max(1, ...trend.map((t) => t.clicks));
  const pts = trend
    .map((t, i) => `${((i / (trend.length - 1)) * w).toFixed(1)},${(h - (t.clicks / max) * (h - 2) - 1).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} className="text-primary/70" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

// ── money board buckets ───────────────────────────────────────────────────────
// Page-1 results earn roughly an 8% CTR — that's the "prize" for a striking-
// distance query: impressions × 8% = the clicks page 1 would be worth.
const PAGE1_CTR = 0.08;

function buckets(queries: Row[]) {
  const winning = queries
    .filter((q) => q.position <= 5 && q.clicks >= 1)
    .sort((a, b) => b.clicks - a.clicks);
  const striking = queries
    .filter((q) => q.position > 5 && q.position <= 15 && q.impressions > 0)
    .map((q) => ({ ...q, prize: Math.max(1, Math.round(q.impressions * PAGE1_CTR)) }))
    .sort((a, b) => b.prize - a.prize);
  const gaps = queries
    .filter((q) => q.position > 15 && q.impressions > 0)
    .sort((a, b) => b.impressions - a.impressions);
  return { winning, striking, gaps };
}

function QueryList({
  rows,
  empty,
  right,
}: {
  rows: Row[];
  empty: string;
  right: (q: Row & { prize?: number }) => ReactNode;
}) {
  if (rows.length === 0) return <div className="text-sm text-muted-foreground py-6 text-center">{empty}</div>;
  return (
    <div className="divide-y divide-border">
      {rows.slice(0, 6).map((q) => (
        <div key={q.query} className="py-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{q.query}</div>
            <div className="text-xs text-muted-foreground">
              #{q.position.toFixed(0)} · {num(q.impressions)} views · {q.clicks} click{q.clicks !== 1 ? "s" : ""}
            </div>
          </div>
          <div className="text-right flex-shrink-0">{right(q)}</div>
        </div>
      ))}
    </div>
  );
}

export default function Search() {
  const { toast } = useToast();
  const d28 = useApi<Gsc>("/api/ops/gsc/analytics?days=28", ["gsc-28"]);
  const d90 = useApi<Gsc>("/api/ops/gsc/analytics?days=90", ["gsc-90"]);
  const proposals = useApi<{ ok: boolean; proposals: Proposal[] }>("/api/ops/seo-proposals", ["seo-proposals"]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const s = d28.data;
  const s90 = d90.data;
  const unavailable = d28.data && !d28.data.ok;

  // 28d pace vs 90d pace — same units (clicks/day), honest comparison.
  const pace28 = s ? s.totals.clicks / (s.period_days || 28) : 0;
  const pace90 = s90 ? s90.totals.clicks / (s90.period_days || 90) : 0;
  const paceUp = pace28 >= pace90;

  const { winning, striking, gaps } = buckets(s?.top_queries ?? []);
  const totalPrize = striking.reduce((acc, q) => acc + q.prize, 0);

  const vitals = s
    ? [
        {
          label: "Clicks (28d)",
          value: num(s.totals.clicks),
          icon: MousePointerClick,
          soWhat: `Visitors Google sent you — ${paceUp ? "ahead of" : "behind"} your 90-day pace (${pace28.toFixed(1)}/day vs ${pace90.toFixed(1)}/day).`,
          color: paceUp ? "text-green-500" : "text-orange-500",
        },
        {
          label: "Impressions (28d)",
          value: num(s.totals.impressions),
          icon: Eye,
          soWhat: "Times you appeared in results — your total demand pool.",
          color: "text-blue-500",
        },
        {
          label: "Click-through rate",
          value: `${s.totals.ctr}%`,
          icon: Percent,
          soWhat: "How often your listing wins the click — titles & descriptions move this.",
          color: "text-purple-500",
        },
        {
          label: "Avg position",
          value: `#${s.totals.position}`,
          icon: MapPin,
          soWhat: "Your average spot in results — under #10 means page 1.",
          color: s.totals.position <= 10 ? "text-green-500" : "text-orange-500",
        },
      ]
    : [];

  const act = async (p: Proposal, action: "approve" | "dismiss") => {
    setBusyId(p.id);
    try {
      const r = await fetch(`/api/proposals/${p.id}/${action}`, { method: "POST", headers: { ...authHeaders() } });
      const body = (await r.json()) as { success?: boolean; implemented?: boolean };
      if (!body.success) throw new Error("failed");
      if (action === "approve") {
        toast(
          body.implemented
            ? { title: "Applied to the live site", description: "The page's search title/description was updated automatically." }
            : { title: "Approved", description: "Added to your task list for implementation." },
        );
      } else {
        toast({ title: "Dismissed" });
      }
      await proposals.refetch();
    } catch {
      toast({ variant: "destructive", title: `${action === "approve" ? "Approve" : "Dismiss"} failed` });
    } finally {
      setBusyId(null);
    }
  };

  const runReview = async () => {
    setRunning(true);
    try {
      const r = await fetch("/api/ops/gsc/insights/run?days=28", { method: "POST", headers: { ...authHeaders() } });
      const body = (await r.json()) as { ok?: boolean; tasks_filed?: number };
      if (!body.ok) throw new Error("failed");
      toast({
        title: "Review complete",
        description: `${body.tasks_filed ?? 0} new proposal(s) filed${(body.tasks_filed ?? 0) > 0 ? " — see below." : "."}`,
      });
      await proposals.refetch();
    } catch {
      toast({ variant: "destructive", title: "Review failed", description: "The SEO agent couldn't complete its run." });
    } finally {
      setRunning(false);
    }
  };

  const open = proposals.data?.proposals ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Search</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {s?.ok ? `Google Search Console · ${s.start} → ${s.end}` : "How Google sends you customers — and what to do about it."}
          </p>
        </div>
        <button
          onClick={runReview}
          disabled={running}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors font-medium"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${running ? "animate-spin" : ""}`} />
          {running ? "Analyzing…" : "Ask the agent for fresh proposals"}
        </button>
      </div>

      {unavailable && (
        <Card className="p-4 text-sm text-muted-foreground">
          Search Console data isn’t reachable right now (the ops-manager may be offline or unauthorized). The proposals
          panel below still works.
        </Card>
      )}

      {/* 1 · Headline strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {(d28.isLoading ? Array.from({ length: 4 }) : vitals).map((v, i) => {
          const vital = v as (typeof vitals)[number] | undefined;
          const Icon = vital?.icon ?? MousePointerClick;
          return (
            <Card key={vital?.label ?? i} className="p-4">
              <div className="flex items-center gap-3">
                <Icon className={`w-5 h-5 ${vital?.color ?? "text-muted-foreground"}`} />
                <div className="min-w-0">
                  <div className="text-xl font-bold">{vital?.value ?? "…"}</div>
                  <div className="text-xs text-muted-foreground">{vital?.label ?? "Loading"}</div>
                </div>
                {vital?.label === "Clicks (28d)" && <div className="ml-auto">{s && <Sparkline trend={s.trend} />}</div>}
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-snug">{vital?.soWhat ?? ""}</p>
            </Card>
          );
        })}
      </div>

      {/* 2 · Money board */}
      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <Trophy className="w-4 h-4 text-green-500" />
            <h3 className="text-sm font-semibold">Winning</h3>
            <Badge variant="outline" className="ml-auto text-xs">{winning.length}</Badge>
          </div>
          <p className="text-xs text-muted-foreground mb-2">
            Top-5 rankings that earn real clicks. Defend these — keep the pages fresh and link to them.
          </p>
          <QueryList
            rows={winning}
            empty={d28.isLoading ? "Loading…" : "Nothing ranking top-5 with clicks yet."}
            right={(q) => <span className="text-sm font-mono text-green-500">{q.clicks} clicks</span>}
          />
        </Card>

        <Card className="p-4 border-primary/40">
          <div className="flex items-center gap-2 mb-1">
            <Crosshair className="w-4 h-4 text-orange-500" />
            <h3 className="text-sm font-semibold">Striking distance</h3>
            <Badge variant="outline" className="ml-auto text-xs">{striking.length}</Badge>
          </div>
          <p className="text-xs text-muted-foreground mb-2">
            Ranked #6–15 — one good title/meta rewrite from page 1. Worth ~{num(totalPrize)} extra clicks if they all
            get there. The cheapest wins on this page.
          </p>
          <QueryList
            rows={striking}
            empty={d28.isLoading ? "Loading…" : "No near-misses right now."}
            right={(q) => (
              <div>
                <div className="text-sm font-mono text-orange-500">+{num(q.prize)}</div>
                <div className="text-[10px] text-muted-foreground">clicks if page 1</div>
              </div>
            )}
          />
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <Lightbulb className="w-4 h-4 text-blue-500" />
            <h3 className="text-sm font-semibold">Content gaps</h3>
            <Badge variant="outline" className="ml-auto text-xs">{gaps.length}</Badge>
          </div>
          <p className="text-xs text-muted-foreground mb-2">
            People search these and see you, but you rank too deep to matter. Each is a content idea with proven demand.
          </p>
          <QueryList
            rows={gaps}
            empty={d28.isLoading ? "Loading…" : "No obvious gaps — the demand you're shown for, you rank for."}
            right={(q) => <span className="text-sm font-mono text-blue-500">{num(q.impressions)} views</span>}
          />
        </Card>
      </div>

      {/* 3 · Proposals */}
      <Card>
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold">Agent proposals</h3>
          <span className="text-xs text-muted-foreground">— filed by the weekly SEO review; nothing changes without your approval</span>
        </div>
        {proposals.isLoading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : open.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No proposals waiting. The agent reviews Search Console every Monday morning — or ask it now with the button
            above.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {open.map((p) => {
              const auto = p.payload?.type === "seo-override";
              return (
                <div key={p.id} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{p.title}</span>
                      {p.category && <Badge variant="outline" className="text-xs">{p.category}</Badge>}
                      {p.priority === 1 && <Badge className="text-xs">High priority</Badge>}
                    </div>
                    {p.detail && <p className="text-xs text-muted-foreground mt-1">{p.detail}</p>}
                    <p className={`text-xs mt-1 ${auto ? "text-green-500" : "text-muted-foreground"}`}>
                      {auto
                        ? `On approve: the page's search title/description is rewritten automatically${p.payload?.page ? ` (${p.payload.page.replace(/^https?:\/\/[^/]+/, "")})` : ""} — no further work needed.`
                        : "On approve: goes onto your task list for implementation."}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <button
                      onClick={() => act(p, "approve")}
                      disabled={busyId === p.id}
                      className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 font-medium transition-colors"
                    >
                      {busyId === p.id ? "…" : "Approve"}
                    </button>
                    <button
                      onClick={() => act(p, "dismiss")}
                      disabled={busyId === p.id}
                      className="text-xs px-3 py-1.5 rounded-md border hover:bg-muted disabled:opacity-60 transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Top pages — which URLs actually earn the traffic */}
      <Card>
        <div className="px-4 py-3 border-b">
          <h3 className="text-sm font-semibold">Pages earning traffic (28d)</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Where Google actually sends people — your proven landing pages.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-2.5 font-semibold text-muted-foreground">Page</th>
                <th className="text-right px-4 py-2.5 font-semibold text-muted-foreground">Clicks</th>
                <th className="text-right px-4 py-2.5 font-semibold text-muted-foreground">Views</th>
                <th className="text-right px-4 py-2.5 font-semibold text-muted-foreground">CTR</th>
                <th className="text-right px-4 py-2.5 font-semibold text-muted-foreground">Pos</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(s?.top_pages ?? []).slice(0, 10).map((p) => (
                <tr key={p.page} className="hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-2.5 max-w-[360px] truncate" title={p.page}>
                    {p.page.replace(/^https?:\/\/[^/]+/, "") || "/"}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono">{num(p.clicks)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{num(p.impressions)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{p.ctr}%</td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">#{p.position}</td>
                </tr>
              ))}
              {!d28.isLoading && (s?.top_pages ?? []).length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">No page data yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
