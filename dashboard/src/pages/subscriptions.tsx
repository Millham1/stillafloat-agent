import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CreditCard, Repeat, CalendarClock, Wallet } from "lucide-react";
import { authHeaders } from "@/lib/auth-token";

type Subscription = {
  id: string;
  vendor: string;
  description: string | null;
  amount: number | null;
  currency: string;
  cadence: "monthly" | "annual" | "quarterly" | "weekly" | "other";
  next_charge_date: string | null;
  category: string | null;
  payment_source: "business" | "personal" | "unknown";
  status: "active" | "cancelled" | "paused" | "trial";
  detected_from: string;
  notes: string | null;
};

type Resp = {
  ok: boolean;
  count: number;
  active_count: number;
  monthly_burn: number;
  annual_burn: number;
  subscriptions: Subscription[];
};

const STATUS_COLORS: Record<string, string> = {
  active:    "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800",
  cancelled: "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700",
  paused:    "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-800",
  trial:     "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800",
};

const money = (n: number | null, ccy = "USD") =>
  n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: ccy }).format(n);

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

export default function Subscriptions() {
  const [filter, setFilter] = useState("all");

  const { data, isLoading, error } = useQuery<Resp>({
    queryKey: ["ops-subscriptions"],
    queryFn: () => fetch("/api/ops/finance/subscriptions", { headers: { ...authHeaders() } }).then((r) => r.json()),
    staleTime: 60_000,
  });

  const subs = data?.subscriptions ?? [];
  const shown = useMemo(() => {
    if (filter === "paid") return subs.filter((s) => (s.amount ?? 0) > 0 && s.status === "active");
    if (filter === "free") return subs.filter((s) => (s.amount ?? 0) === 0 && s.status === "active");
    if (filter === "cancelled") return subs.filter((s) => s.status === "cancelled");
    return subs;
  }, [subs, filter]);

  const cards = [
    { label: "Monthly burn", value: money(data?.monthly_burn ?? 0), icon: Wallet, color: "text-red-500" },
    { label: "Annual burn", value: money(data?.annual_burn ?? 0), icon: Repeat, color: "text-orange-500" },
    { label: "Active services", value: String(data?.active_count ?? 0), icon: CreditCard, color: "text-green-500" },
    { label: "Tracked total", value: String(data?.count ?? 0), icon: CalendarClock, color: "text-blue-500" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight">Subscriptions</h2>
        <p className="text-sm text-muted-foreground mt-0.5">Recurring spend and the full service inventory.</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {cards.map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="p-4">
            <CardContent className="p-0 flex items-center gap-3">
              <Icon className={`w-5 h-5 ${color}`} />
              <div>
                <div className="text-xl font-bold">{isLoading ? "…" : value}</div>
                <div className="text-xs text-muted-foreground">{label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex gap-1">
        {["all", "paid", "free", "cancelled"].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 text-xs rounded-md border capitalize transition-colors ${
              filter === f ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground hover:text-foreground border-border"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Vendor</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Category</th>
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground">Amount</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Cadence</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Next charge</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Pay source</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading && <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>}
              {error && <tr><td colSpan={7} className="px-4 py-8 text-center text-destructive">Failed to load subscriptions.</td></tr>}
              {!isLoading && !error && shown.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">No subscriptions.</td></tr>}
              {shown.map((s) => (
                <tr key={s.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium">{s.vendor}</div>
                    {s.description && <div className="text-xs text-muted-foreground">{s.description}</div>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{s.category ?? "—"}</td>
                  <td className="px-4 py-3 text-right font-mono">{(s.amount ?? 0) === 0 ? <span className="text-muted-foreground">free</span> : money(s.amount, s.currency)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{s.cadence}</td>
                  <td className="px-4 py-3 text-muted-foreground">{fmtDate(s.next_charge_date)}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs ${s.payment_source === "personal" ? "text-orange-500" : "text-muted-foreground"}`}>{s.payment_source}</span>
                  </td>
                  <td className="px-4 py-3"><Badge variant="outline" className={STATUS_COLORS[s.status] ?? ""}>{s.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
