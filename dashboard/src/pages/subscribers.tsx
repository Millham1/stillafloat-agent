import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, MailCheck, Clock, UserX, Search, Download } from "lucide-react";

type Subscriber = {
  id: string;
  email: string;
  name: string;
  status: "pending" | "confirmed" | "unsubscribed";
  created_at: string;
  confirmed_at: string | null;
};

type SubscribersResponse = {
  subscribers: Subscriber[];
  total: number;
};

const STATUS_COLORS: Record<string, string> = {
  confirmed:    "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800",
  pending:      "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-800",
  unsubscribed: "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700",
};

function fmt(dateStr: string | null) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function Subscribers() {
  const [search, setSearch]     = useState("");
  const [statusFilter, setStatus] = useState("all");
  const [debouncedSearch, setDebounced] = useState("");

  // Simple debounce
  const handleSearch = (v: string) => {
    setSearch(v);
    clearTimeout((window as unknown as { _st?: ReturnType<typeof setTimeout> })._st);
    (window as unknown as { _st?: ReturnType<typeof setTimeout> })._st = setTimeout(() => setDebounced(v), 300);
  };

  const { data, isLoading, error } = useQuery<SubscribersResponse>({
    queryKey: ["subscribers", statusFilter, debouncedSearch],
    queryFn: () =>
      fetch(`/api/subscribers?status=${statusFilter}&search=${encodeURIComponent(debouncedSearch)}&limit=500`)
        .then((r) => r.json()),
    staleTime: 30_000,
  });

  const subscribers = data?.subscribers ?? [];
  const total       = data?.total ?? 0;

  const counts = useMemo(() => {
    const all = data?.subscribers ?? [];
    return {
      confirmed:    all.filter((s) => s.status === "confirmed").length,
      pending:      all.filter((s) => s.status === "pending").length,
      unsubscribed: all.filter((s) => s.status === "unsubscribed").length,
    };
  }, [data]);

  function exportCsv() {
    const confirmed = subscribers.filter((s) => s.status === "confirmed");
    const rows = [
      ["Name", "Email", "Status", "Joined", "Confirmed"],
      ...confirmed.map((s) => [
        s.name, s.email, s.status, fmt(s.created_at), fmt(s.confirmed_at),
      ]),
    ];
    const csv = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = "still-afloat-subscribers.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Subscribers</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {total} total {statusFilter !== "all" ? statusFilter : ""} subscriber{total !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={exportCsv}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-card border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
        >
          <Download className="w-3.5 h-3.5" />
          Export CSV
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Confirmed", value: counts.confirmed, icon: MailCheck, color: "text-green-500" },
          { label: "Pending",   value: counts.pending,   icon: Clock,     color: "text-yellow-500" },
          { label: "Unsubscribed", value: counts.unsubscribed, icon: UserX, color: "text-gray-400" },
          { label: "Total",     value: total,            icon: Users,     color: "text-blue-500" },
        ].map(({ label, value, icon: Icon, color }) => (
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

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search name or email…"
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border bg-card placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex gap-1">
          {["all", "confirmed", "pending", "unsubscribed"].map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-3 py-1.5 text-xs rounded-md border capitalize transition-colors ${
                statusFilter === s
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-muted-foreground hover:text-foreground border-border"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Name</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Email</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Status</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Joined</th>
                <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Confirmed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
              )}
              {error && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-destructive">Failed to load subscribers.</td></tr>
              )}
              {!isLoading && !error && subscribers.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No subscribers found.</td></tr>
              )}
              {subscribers.map((s) => (
                <tr key={s.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3 font-medium">{s.name}</td>
                  <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{s.email}</td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className={STATUS_COLORS[s.status] ?? ""}>
                      {s.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{fmt(s.created_at)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{fmt(s.confirmed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
