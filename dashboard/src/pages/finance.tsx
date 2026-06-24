import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingDown, TrendingUp, Scale, RefreshCcw } from "lucide-react";
import { authHeaders } from "@/lib/auth-token";

type Summary = {
  ok: boolean;
  month: string;
  total_expense: number;
  total_income: number;
  net: number;
  reimbursable_personal: number;
  count: number;
  by_category: Record<string, number>;
  by_payment_source: Record<string, number>;
};
type Cashflow = {
  ok: boolean;
  series: { month: string; expense: number; income: number }[];
  projected_monthly_spend: number;
  projected_yearly_spend: number;
};
type Txn = {
  id: string; vendor: string | null; description: string | null; amount: number | null;
  currency: string; txn_date: string | null; category: string | null;
  direction: "expense" | "income"; payment_source: string; status: string; source: string;
};
type TxnResp = { ok: boolean; count: number; transactions: Txn[] };

const money = (n: number | null, ccy = "USD") =>
  n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: ccy }).format(n);
const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

function useApi<T>(url: string, key: string[]) {
  return useQuery<T>({
    queryKey: key,
    queryFn: () => fetch(url, { headers: { ...authHeaders() } }).then((r) => r.json()),
    staleTime: 60_000,
  });
}

export default function Finance() {
  const summary = useApi<Summary>("/api/ops/finance/summary", ["ops-fin-summary"]);
  const cashflow = useApi<Cashflow>("/api/ops/finance/cashflow?months=12", ["ops-fin-cashflow"]);
  const txns = useApi<TxnResp>("/api/ops/finance/transactions?limit=25", ["ops-fin-txns"]);

  const s = summary.data;
  const series = cashflow.data?.series ?? [];
  const maxBar = Math.max(1, ...series.map((d) => Math.max(d.expense, d.income)));
  const categories = Object.entries(s?.by_category ?? {});
  const transactions = txns.data?.transactions ?? [];

  const cards = [
    { label: "Spend this month", value: money(s?.total_expense ?? 0), icon: TrendingDown, color: "text-red-500" },
    { label: "Income this month", value: money(s?.total_income ?? 0), icon: TrendingUp, color: "text-green-500" },
    { label: "Net", value: money(s?.net ?? 0), icon: Scale, color: (s?.net ?? 0) >= 0 ? "text-green-500" : "text-red-500" },
    { label: "On personal card", value: money(s?.reimbursable_personal ?? 0), icon: RefreshCcw, color: "text-orange-500" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight">Finance</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          {s ? `${s.month} · ${s.count} transaction${s.count !== 1 ? "s" : ""}` : "Receipts, invoices, and cash flow."}
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {cards.map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="p-4">
            <CardContent className="p-0 flex items-center gap-3">
              <Icon className={`w-5 h-5 ${color}`} />
              <div>
                <div className="text-xl font-bold">{summary.isLoading ? "…" : value}</div>
                <div className="text-xs text-muted-foreground">{label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Cash flow */}
        <Card className="lg:col-span-2 p-4">
          <div className="flex items-baseline justify-between mb-4">
            <h3 className="text-sm font-semibold">Cash flow (12 mo)</h3>
            <div className="text-xs text-muted-foreground">
              Projected: <span className="font-medium text-foreground">{money(cashflow.data?.projected_monthly_spend ?? 0)}/mo</span>
              {" · "}<span className="font-medium text-foreground">{money(cashflow.data?.projected_yearly_spend ?? 0)}/yr</span>
            </div>
          </div>
          {series.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">{cashflow.isLoading ? "Loading…" : "No transactions yet."}</div>
          ) : (
            <div className="flex items-end gap-2 h-44">
              {series.map((d) => (
                <div key={d.month} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                  <div className="w-full flex items-end justify-center gap-0.5 h-36">
                    <div className="w-1/2 bg-red-400/80 rounded-t" style={{ height: `${(d.expense / maxBar) * 100}%` }} title={`Spend ${money(d.expense)}`} />
                    <div className="w-1/2 bg-green-400/70 rounded-t" style={{ height: `${(d.income / maxBar) * 100}%` }} title={`Income ${money(d.income)}`} />
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate w-full text-center">{d.month.slice(5)}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* By category */}
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-4">Spend by category</h3>
          {categories.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">{summary.isLoading ? "Loading…" : "Nothing this month."}</div>
          ) : (
            <div className="space-y-2">
              {categories.map(([cat, amt]) => {
                const pct = (amt / (s?.total_expense || 1)) * 100;
                return (
                  <div key={cat}>
                    <div className="flex justify-between text-xs mb-0.5">
                      <span className="text-muted-foreground">{cat}</span>
                      <span className="font-mono">{money(amt)}</span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-primary/70 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Recent transactions */}
      <Card>
        <div className="px-4 py-3 border-b"><h3 className="text-sm font-semibold">Recent transactions</h3></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Date</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Vendor</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Category</th>
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground">Amount</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {txns.isLoading && <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>}
              {txns.error && <tr><td colSpan={5} className="px-4 py-8 text-center text-destructive">Failed to load transactions.</td></tr>}
              {!txns.isLoading && !txns.error && transactions.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No transactions yet — snap a receipt to the Telegram bot.</td></tr>}
              {transactions.map((t) => (
                <tr key={t.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmtDate(t.txn_date)}</td>
                  <td className="px-4 py-3 font-medium">{t.vendor ?? "—"}{t.description && <div className="text-xs text-muted-foreground font-normal">{t.description}</div>}</td>
                  <td className="px-4 py-3 text-muted-foreground">{t.category ?? "—"}</td>
                  <td className={`px-4 py-3 text-right font-mono ${t.direction === "income" ? "text-green-500" : ""}`}>{t.direction === "income" ? "+" : ""}{money(t.amount, t.currency)}</td>
                  <td className="px-4 py-3"><Badge variant="outline" className="text-xs">{t.source}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
