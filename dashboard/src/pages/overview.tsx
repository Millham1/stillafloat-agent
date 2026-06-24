import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import {
  Anchor, Sparkles, TrendingDown, TrendingUp, Scale, RefreshCcw, Wallet,
  Youtube, Facebook, Eye, Users, Video,
} from "lucide-react";
import { authHeaders } from "@/lib/auth-token";

type Summary = { ok: boolean; month: string; total_expense: number; total_income: number; net: number; reimbursable_personal: number; count: number; by_category: Record<string, number> };
type Cashflow = { ok: boolean; series: { month: string; expense: number; income: number }[]; projected_monthly_spend: number; projected_yearly_spend: number };
type Subs = { ok: boolean; monthly_burn: number; annual_burn: number; active_count: number; count: number };
type YT = {
  success: boolean; error?: string;
  channel?: { title: string; subscribers: number; views: number; videos: number };
  avgViews?: number;
  topVideos?: { id: string; title: string; views: number; url: string }[];
  history?: { date: string; subscribers: number; views: number }[];
};

const money = (n: number | null | undefined, ccy = "USD") =>
  n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: ccy, maximumFractionDigits: 0 }).format(n);
const num = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("en-US").format(n));

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

  const s = summary.data;
  const series = cashflow.data?.series ?? [];
  const maxBar = Math.max(1, ...series.map((d) => Math.max(d.expense, d.income)));
  const categories = Object.entries(s?.by_category ?? {}).slice(0, 5);
  const ch = yt.data?.channel;
  const topVid = yt.data?.topVideos?.[0];

  const health = [
    s ? `Spend this month ${money(s.total_expense)}` : null,
    subs.data ? `burn ${money(subs.data.monthly_burn)}/mo` : null,
    ch ? `${num(ch.subscribers)} YouTube subs · ${num(ch.views)} views` : null,
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
          <div className="flex items-baseline justify-between mb-4">
            <h3 className="text-sm font-semibold">Cash flow</h3>
            <div className="text-xs text-muted-foreground">
              Projected <span className="font-medium text-foreground">{money(cashflow.data?.projected_monthly_spend)}/mo</span>
            </div>
          </div>
          {series.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">{cashflow.isLoading ? "Loading…" : "No transactions yet."}</div>
          ) : (
            <div className="flex items-end gap-2 h-40">
              {series.map((d) => (
                <div key={d.month} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                  <div className="w-full flex items-end justify-center gap-0.5 h-32">
                    <div className="w-1/2 bg-red-400/80 rounded-t" style={{ height: `${(d.expense / maxBar) * 100}%` }} title={`Spend ${money(d.expense)}`} />
                    <div className="w-1/2 bg-green-400/70 rounded-t" style={{ height: `${(d.income / maxBar) * 100}%` }} title={`Income ${money(d.income)}`} />
                  </div>
                  <div className="text-[10px] text-muted-foreground">{d.month.slice(5)}</div>
                </div>
              ))}
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
          const vids = yt.data?.topVideos ?? [];
          const maxV = Math.max(1, ...vids.map((v) => v.views));
          const hist = yt.data?.history ?? [];
          const first = hist[0], last = hist[hist.length - 1];
          const subsGain = first && last ? last.subscribers - first.subscribers : 0;
          const viewsGain = first && last ? last.views - first.views : 0;
          const topShare = topVid && ch.views ? Math.round((topVid.views / ch.views) * 100) : 0;
          const maxH = Math.max(1, ...hist.map((h) => h.views));
          const minH = Math.min(...hist.map((h) => h.views), maxH);
          return (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <div><div className="text-xs text-muted-foreground flex items-center gap-1"><Users className="w-3 h-3" />Subscribers</div><div className="text-xl font-bold">{num(ch.subscribers)}{hist.length > 1 && <span className="text-xs text-green-500 ml-1">+{num(subsGain)}</span>}</div></div>
                <div><div className="text-xs text-muted-foreground flex items-center gap-1"><Eye className="w-3 h-3" />Total views</div><div className="text-xl font-bold">{num(ch.views)}{hist.length > 1 && <span className="text-xs text-green-500 ml-1">+{num(viewsGain)}</span>}</div></div>
                <div><div className="text-xs text-muted-foreground flex items-center gap-1"><Video className="w-3 h-3" />Videos</div><div className="text-xl font-bold">{num(ch.videos)}</div></div>
                <div><div className="text-xs text-muted-foreground flex items-center gap-1"><TrendingUp className="w-3 h-3" />Avg / video</div><div className="text-xl font-bold">{num(yt.data?.avgViews)}</div></div>
              </div>

              {topShare > 0 && (
                <div className="text-xs text-muted-foreground mb-3">Your top video drives <span className="text-foreground font-medium">{topShare}%</span> of all views — lean into what worked.</div>
              )}

              <div className="grid lg:grid-cols-2 gap-5">
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-2">Views by video</div>
                  <div className="space-y-1.5">
                    {vids.slice(0, 8).map((v) => (
                      <div key={v.id} className="flex items-center gap-2">
                        <a href={v.url} target="_blank" rel="noreferrer" className="text-xs w-32 truncate shrink-0 hover:underline" title={v.title}>{v.title}</a>
                        <div className="flex-1 h-3 bg-muted rounded-sm overflow-hidden"><div className="h-full bg-red-400/80 rounded-sm" style={{ width: `${(v.views / maxV) * 100}%` }} /></div>
                        <span className="text-xs font-mono w-12 text-right shrink-0">{num(v.views)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-2">Views growth (last {hist.length} day{hist.length !== 1 ? "s" : ""})</div>
                  {hist.length < 2 ? (
                    <div className="text-xs text-muted-foreground h-24 flex items-center justify-center text-center px-4">Trend starts building today — a snapshot is recorded each day you open this. Check back tomorrow.</div>
                  ) : (
                    <div className="flex items-end gap-1 h-24">
                      {hist.map((h) => (
                        <div key={h.date} className="flex-1 bg-blue-400/70 rounded-t min-w-0" style={{ height: `${maxH === minH ? 50 : ((h.views - minH) / (maxH - minH)) * 90 + 10}%` }} title={`${h.date}: ${num(h.views)} views`} />
                      ))}
                    </div>
                  )}
                </div>
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
