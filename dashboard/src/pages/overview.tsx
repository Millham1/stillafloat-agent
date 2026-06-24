import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import {
  Anchor, Sparkles, TrendingDown, TrendingUp, Scale, RefreshCcw, Wallet,
  Youtube, Facebook, Eye, Users, Video,
} from "lucide-react";
import { authHeaders } from "@/lib/auth-token";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, AreaChart, Area } from "recharts";

type Summary = { ok: boolean; month: string; total_expense: number; total_income: number; net: number; reimbursable_personal: number; count: number; by_category: Record<string, number> };
type Cashflow = { ok: boolean; series: { month: string; expense: number; income: number }[]; projected_monthly_spend: number; projected_yearly_spend: number };
type Subs = { ok: boolean; monthly_burn: number; annual_burn: number; active_count: number; count: number };
type YT = {
  success: boolean; error?: string;
  channel?: { title: string; subscribers: number; views: number; videos: number };
  avgViews?: number;
  topVideos?: { id: string; title: string; views: number; url: string }[];
};
type Analytics = {
  ok?: boolean; detail?: string;
  daily?: { date: string; views: number; minutes: number; avg_view_seconds: number; subs_gained: number }[];
  totals?: { views: number; watch_hours: number; avg_view_seconds: number; subs_gained: number };
};

const money = (n: number | null | undefined, ccy = "USD") =>
  n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: ccy, maximumFractionDigits: 0 }).format(n);
const num = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("en-US").format(n));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function useApi<T>(url: string, key: string[]) {
  return useQuery<T>({
    queryKey: key,
    queryFn: () => fetch(url, { headers: { ...authHeaders() } }).then((r) => r.json()),
    staleTime: 60_000,
  });
}

export default function Overview() {
  const summary = useApi<Summary>("/api/ops/finance/summary", ["ov-summary"]);
  const cashflow = useApi<Cashflow>("/api/ops/finance/cashflow?months=7", ["ov-cashflow"]);
  const subs = useApi<Subs>("/api/ops/finance/subscriptions", ["ov-subs"]);
  const yt = useApi<YT>("/api/youtube-stats", ["ov-youtube"]);
  const ytAnalytics = useApi<Analytics>("/api/ops/youtube-analytics?days=28", ["ov-yt-analytics"]);

  const s = summary.data;
  const series = cashflow.data?.series ?? [];
  const categories = Object.entries(s?.by_category ?? {}).slice(0, 5);
  const ch = yt.data?.channel;
  const topVid = yt.data?.topVideos?.[0];

  const lastM = series[series.length - 1];
  const prevM = series[series.length - 2];
  const spendDelta = lastM && prevM && prevM.expense > 0
    ? Math.round(((lastM.expense - prevM.expense) / prevM.expense) * 100) : null;
  const topShare = topVid && ch?.views ? Math.round((topVid.views / ch.views) * 100) : null;

  const health = [
    spendDelta != null
      ? `Spend ${spendDelta <= 0 ? "down" : "up"} ${Math.abs(spendDelta)}% vs last month`
      : (s ? `${money(s.total_expense)} spent this month` : null),
    subs.data ? `${money(subs.data.monthly_burn)}/mo across ${subs.data.active_count} active subscriptions` : null,
    ch ? `YouTube: ${num(ch.subscribers)} subs${topShare != null ? `, top video = ${topShare}% of views` : ""}` : null,
  ].filter(Boolean).join(" · ");

  const kpis = [
    { label: "Net cash (month)", value: money(s?.net), icon: Scale, color: (s?.net ?? 0) >= 0 ? "text-green-500" : "text-red-500" },
    { label: "Spend (month)", value: money(s?.total_expense), icon: TrendingDown, color: "text-red-500" },
    { label: "Monthly burn", value: money(subs.data?.monthly_burn), icon: Wallet, color: "text-orange-500" },
    { label: "Subscriptions", value: subs.data ? `${subs.data.count}` : "—", icon: RefreshCcw, color: "text-blue-500", sub: subs.data ? `${subs.data.active_count} active` : "" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Anchor className="w-5 h-5 text-muted-foreground" />
        <h2 className="text-xl font-bold tracking-tight">Business Health</h2>
      </div>

      {/* AI/health summary line */}
      <div className="flex items-start gap-2 rounded-md bg-blue-50 dark:bg-blue-950/30 px-3 py-2.5">
        <Sparkles className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />
        <span className="text-sm text-blue-700 dark:text-blue-300">{health || "Gathering business metrics…"}</span>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {kpis.map(({ label, value, icon: Icon, color, sub }) => (
          <Card key={label} className="p-4">
            <CardContent className="p-0 flex items-center gap-3">
              <Icon className={`w-5 h-5 ${color}`} />
              <div>
                <div className="text-xl font-bold">{value}</div>
                <div className="text-xs text-muted-foreground">{label}{sub ? ` · ${sub}` : ""}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Cash flow + category */}
      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 p-4">
          <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold">Cash flow</h3>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: "#D85A30" }} />Spend</span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: "#1D9E75" }} />Income</span>
            </div>
            <div className="text-xs text-muted-foreground">
              Projected <span className="font-medium text-foreground">{money(cashflow.data?.projected_monthly_spend)}/mo</span>
            </div>
          </div>
          {series.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">{cashflow.isLoading ? "Loading…" : "No transactions yet."}</div>
          ) : (
            <div style={{ width: "100%", height: 200 }}>
              <ResponsiveContainer>
                <BarChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -8 }} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(136,135,128,0.18)" />
                  <XAxis dataKey="month" tickFormatter={(m: string) => MONTHS[Number(m.slice(5, 7)) - 1] ?? m} tick={{ fill: "#888780", fontSize: 12 }} axisLine={false} tickLine={false} dy={4} />
                  <YAxis tick={{ fill: "#888780", fontSize: 12 }} axisLine={false} tickLine={false} width={52} tickFormatter={(v: number) => `$${v}`} />
                  <Tooltip cursor={{ fill: "rgba(136,135,128,0.1)" }} formatter={(v: number, n: string) => [money(v), n]} />
                  <Bar dataKey="expense" name="Spend" fill="#D85A30" radius={[4, 4, 0, 0]} maxBarSize={56} />
                  <Bar dataKey="income" name="Income" fill="#1D9E75" radius={[4, 4, 0, 0]} maxBarSize={56} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-4">Spend by category</h3>
          {categories.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">{summary.isLoading ? "Loading…" : "Nothing this month."}</div>
          ) : (
            <div className="space-y-2">
              {categories.map(([cat, amt]) => (
                <div key={cat}>
                  <div className="flex justify-between text-xs mb-0.5">
                    <span className="text-muted-foreground">{cat}</span>
                    <span className="font-mono">{money(amt)}</span>
                  </div>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-primary/70 rounded-full" style={{ width: `${(amt / (s?.total_expense || 1)) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* YouTube */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Youtube className="w-5 h-5 text-red-500" />
          <h3 className="text-sm font-semibold">YouTube performance</h3>
        </div>
        {!ch ? (
          <div className="text-sm text-muted-foreground py-6 text-center">
            {yt.isLoading ? "Loading…" : "YouTube stats not configured yet (add YOUTUBE_API_KEY)."}
          </div>
        ) : (() => {
          const vids = (yt.data?.topVideos ?? []).slice(0, 8);
          const maxV = Math.max(1, ...vids.map((v) => v.views));
          const topShare = topVid && ch.views ? Math.round((topVid.views / ch.views) * 100) : 0;
          const an = ytAnalytics.data;
          const daily = an?.daily ?? [];
          const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
          return (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
                <div><div className="text-xs text-muted-foreground flex items-center gap-1.5"><Users className="w-3.5 h-3.5" />Subscribers</div><div className="text-2xl font-bold mt-0.5">{num(ch.subscribers)}</div></div>
                <div><div className="text-xs text-muted-foreground flex items-center gap-1.5"><Eye className="w-3.5 h-3.5" />Total views</div><div className="text-2xl font-bold mt-0.5">{num(ch.views)}</div></div>
                <div><div className="text-xs text-muted-foreground flex items-center gap-1.5"><Video className="w-3.5 h-3.5" />Videos</div><div className="text-2xl font-bold mt-0.5">{num(ch.videos)}</div></div>
                <div><div className="text-xs text-muted-foreground flex items-center gap-1.5"><TrendingUp className="w-3.5 h-3.5" />Avg / video</div><div className="text-2xl font-bold mt-0.5">{num(yt.data?.avgViews)}</div></div>
              </div>

              {/* Last 28 days — from the YouTube Analytics API */}
              {an?.totals ? (
                <div className="mb-4">
                  <div className="text-xs font-medium text-muted-foreground mb-2">Last 28 days</div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                    <div className="rounded-md bg-muted/40 p-3"><div className="text-xs text-muted-foreground">Views</div><div className="text-xl font-bold">{num(an.totals.views)}</div></div>
                    <div className="rounded-md bg-muted/40 p-3"><div className="text-xs text-muted-foreground">Watch hours</div><div className="text-xl font-bold">{num(an.totals.watch_hours)}</div></div>
                    <div className="rounded-md bg-muted/40 p-3"><div className="text-xs text-muted-foreground">Avg view</div><div className="text-xl font-bold">{mmss(an.totals.avg_view_seconds)}</div></div>
                    <div className="rounded-md bg-muted/40 p-3"><div className="text-xs text-muted-foreground">Subs gained</div><div className="text-xl font-bold text-green-600">+{num(an.totals.subs_gained)}</div></div>
                  </div>
                  {daily.length > 1 && (
                    <div style={{ width: "100%", height: 110 }}>
                      <ResponsiveContainer>
                        <AreaChart data={daily} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(136,135,128,0.18)" />
                          <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} tick={{ fill: "#888780", fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} />
                          <YAxis tick={{ fill: "#888780", fontSize: 11 }} axisLine={false} tickLine={false} width={36} />
                          <Tooltip formatter={(v: number) => [num(v), "views"]} />
                          <Area dataKey="views" stroke="#E24B4A" fill="#E24B4A" fillOpacity={0.15} strokeWidth={2} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground mb-4 rounded-md border border-dashed px-3 py-2">
                  {ytAnalytics.isLoading
                    ? "Loading 28-day analytics…"
                    : "28-day views, watch-time and growth load once the Analytics OAuth is connected to the Still Afloat channel."}
                </div>
              )}

              {topShare > 0 && (
                <div className="text-sm mb-4 rounded-md bg-muted/40 px-3 py-2">Your top video drives <span className="font-semibold">{topShare}%</span> of all channel views — that's your formula. Lean into it.</div>
              )}

              <div className="text-xs font-medium text-muted-foreground mb-2">Views by video</div>
              <div className="space-y-2">
                {vids.map((v) => (
                  <div key={v.id} className="flex items-center gap-3">
                    <a href={v.url} target="_blank" rel="noreferrer" className="text-sm w-48 truncate shrink-0 hover:underline" title={v.title}>{v.title}</a>
                    <div className="flex-1 h-4 bg-muted/60 rounded overflow-hidden"><div className="h-full bg-[#E24B4A] rounded" style={{ width: `${(v.views / maxV) * 100}%` }} /></div>
                    <span className="text-sm font-mono w-14 text-right shrink-0 tabular-nums">{num(v.views)}</span>
                  </div>
                ))}
              </div>
            </>
          );
        })()}
      </Card>

      {/* Facebook */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <Facebook className="w-5 h-5 text-blue-500" />
          <h3 className="text-sm font-semibold">Facebook</h3>
        </div>
        <div className="text-sm text-muted-foreground py-4 text-center">
          Connect a Facebook Page token to enable reach &amp; engagement stats.
        </div>
      </Card>
    </div>
  );
}
