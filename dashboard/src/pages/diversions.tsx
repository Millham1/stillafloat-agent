// diversions.tsx — the running list of ship diversions for storms (Mark,
// 2026-09-26: "keep track at a glance of what is being pinged and answer
// questions quickly"). One row per ship movement the detector saw on a
// storm-pinned ship — routine moves and silent swaps included, not just the
// pending events the Storm Alerts page shows. Data: GET /api/storm-diversions/log.

import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Waypoints, RefreshCw } from "lucide-react";
import { authHeaders } from "@/lib/auth-token";

type Verdict = "diversion" | "swap" | "routine" | "unknown";
type EventStatus = "pending" | "published" | "ignored";
type Intel = { line: string; note: string; url?: string };
type EventSummary = { id: string; status: EventStatus; published_at: string | null; ignored_at: string | null; intel: Intel[] };
type Ping = {
  at: string; ship_name: string; cruise_line: string | null;
  kind: string; label: string; verdict: Verdict;
  from_slug: string | null; to_slug: string; from_name: string; to_name: string;
  raw: string | null; reason: string | null;
  storms: string[]; alert_ids: string[]; dedup_keys: string[];
  event: EventSummary | null; source: "ping" | "event";
};
type LiveStorm = { id: string; name: string; nhc_id: string; classification: string | null; status: string; live_pins: number };
type Counts = { pings: number; diversions: number; swaps: number; routine: number; unknown: number; pending: number };
type LogResponse = {
  success: boolean; since: string; days: number; generated_at: string;
  storms: LiveStorm[]; pings: Ping[]; counts: Counts; error?: string;
};

const WINDOWS = [7, 14, 30, 90] as const;
const DEFAULT_WINDOW = 30;

const VERDICT_WORD: Record<Verdict, string> = { diversion: "Diversion", swap: "Swap", routine: "Routine", unknown: "Unknown" };
const VERDICT_CLASS: Record<Verdict, string> = {
  diversion: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800",
  swap:      "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-800",
  routine:   "text-muted-foreground",
  unknown:   "",
};
const SELECT_CLASS = "px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary";

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function day(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export default function Diversions() {
  const { toast } = useToast();
  const [days, setDays] = useState<number>(DEFAULT_WINDOW);
  const [storm, setStorm] = useState("all");
  const [ship, setShip] = useState("");
  const [showRoutine, setShowRoutine] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const { data, isLoading, isFetching, refetch } = useQuery<LogResponse>({
    queryKey: ["storm-diversions-log", days],
    queryFn: () => fetch(`/api/storm-diversions/log?days=${days}`, { headers: { ...authHeaders() } }).then((r) => r.json()),
    staleTime: 30_000,
  });

  const pings = data?.pings ?? [];
  const storms = data?.storms ?? [];
  const counts = data?.counts;

  const stormNames = useMemo(() => Array.from(new Set(pings.flatMap((p) => p.storms))).sort(), [pings]);
  const stormFilter = stormNames.includes(storm) ? storm : "all";
  const shown = useMemo(() => {
    const q = ship.trim().toLowerCase();
    return pings.filter((p) =>
      (stormFilter === "all" || p.storms.includes(stormFilter)) &&
      (!q || p.ship_name.toLowerCase().includes(q)) &&
      (showRoutine || p.verdict !== "routine"));
  }, [pings, stormFilter, ship, showRoutine]);

  async function act(id: string, verb: "publish" | "ignore") {
    setBusy(id);
    try {
      const r = await fetch(`/api/storm-diversions/${id}/${verb}`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
      }).then((x) => x.json());
      if (r?.success) toast({ title: verb === "publish" ? `Published to ${r.alerts ?? 0} alert(s)${r.watchersEmailed ? `, ${r.watchersEmailed} watcher(s) emailed` : ""}` : "Ignored" });
      else toast({ title: "Failed", description: String(r?.error ?? "") });
    } catch {
      toast({ variant: "destructive", title: `${verb === "publish" ? "Publish" : "Ignore"} failed` });
    } finally {
      setBusy(null);
    }
    await refetch();
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Waypoints className="h-6 w-6 text-sky-600" />
          <h1 className="text-xl font-semibold">Ship Diversions</h1>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Every destination change the detector saw on a storm-pinned ship. Routine = next port on the published itinerary;
        Swap = on the itinerary but out of order (silent by design); Diversion = a port not on the plan.
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-2">
        {storms.length === 0 && !isLoading && (
          <span className="text-sm text-muted-foreground">No live storm is pinning ships right now.</span>
        )}
        {storms.map((s) => (
          <Badge key={s.id} variant="outline" className="bg-sky-50 text-sky-900 border-sky-200 dark:bg-sky-900/20 dark:text-sky-200 dark:border-sky-800">
            {s.name} · {s.classification ?? "—"} · {plural(s.live_pins, "ship")} pinned
          </Badge>
        ))}
      </div>
      {counts && (
        <p className="text-sm mb-4">
          <b>{plural(counts.pings, "ping")}</b> in the last {plural(data?.days ?? days, "day")}:{" "}
          {plural(counts.diversions, "diversion")}, {plural(counts.swaps, "swap")}, {counts.routine} routine, {counts.unknown} unknown.{" "}
          {counts.pending > 0
            ? <span className="text-amber-700 dark:text-amber-300 font-medium">{plural(counts.pending, "course change")} waiting on you.</span>
            : <span className="text-muted-foreground">Nothing waiting on you.</span>}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select aria-label="Window" value={days} onChange={(e) => setDays(Number(e.target.value))} className={SELECT_CLASS}>
          {WINDOWS.map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
        <select aria-label="Storm" value={stormFilter} onChange={(e) => setStorm(e.target.value)} className={SELECT_CLASS}>
          <option value="all">All storms</option>
          {stormNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <Input aria-label="Ship" placeholder="Ship name…" value={ship} onChange={(e) => setShip(e.target.value)} className="w-full sm:w-56" />
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <Checkbox checked={showRoutine} onCheckedChange={(v) => setShowRoutine(v === true)} />
          Show routine moves
        </label>
      </div>

      {isLoading && <p className="text-muted-foreground">Loading…</p>}
      {!isLoading && data && data.success === false && (
        <Card><CardContent className="py-10 text-center text-destructive">{data.error ?? "Could not load the diversion log."}</CardContent></Card>
      )}
      {!isLoading && data?.success !== false && pings.length === 0 && (
        <Card><CardContent className="py-10 text-center text-muted-foreground">
          No destination changes on storm-pinned ships in the last {plural(days, "day")}.
        </CardContent></Card>
      )}
      {!isLoading && pings.length > 0 && shown.length === 0 && (
        <Card><CardContent className="py-10 text-center text-muted-foreground">
          Nothing matches these filters — {plural(pings.length, "ping")} in the window.
        </CardContent></Card>
      )}

      {shown.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">When</TableHead>
                <TableHead>Ship</TableHead>
                <TableHead>Storm(s)</TableHead>
                <TableHead>Change</TableHead>
                <TableHead>Verdict</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Why</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((p) => {
                const ev = p.event;
                return (
                  <TableRow key={`${ev?.id ?? p.dedup_keys[0] ?? p.ship_name}|${p.at}`} className="align-top">
                    <TableCell className="whitespace-nowrap text-sm">{when(p.at)}</TableCell>
                    <TableCell className="text-sm">
                      <div className="font-medium whitespace-nowrap">{p.ship_name}</div>
                      {p.cruise_line ? <div className="text-xs text-muted-foreground">{p.cruise_line}</div> : null}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">{p.storms.length ? p.storms.join(", ") : "—"}</TableCell>
                    <TableCell className="text-sm">
                      <div className="whitespace-nowrap">{p.from_name} → {p.to_name}</div>
                      {p.raw ? <div className="text-xs text-muted-foreground">“{p.raw}”</div> : null}
                    </TableCell>
                    {/* Widths live on inner blocks: auto table layout ignores width/min-width on the cells themselves. */}
                    <TableCell className="text-sm">
                      <div className="w-44">
                        <Badge variant="outline" className={`whitespace-nowrap ${VERDICT_CLASS[p.verdict] ?? ""}`}>{VERDICT_WORD[p.verdict] ?? p.verdict}</Badge>
                        <div className="text-xs text-muted-foreground mt-1">{p.label}</div>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {ev?.status === "pending" ? (
                        <span className="flex gap-1">
                          <Button size="sm" onClick={() => act(ev.id, "publish")} disabled={busy === ev.id}>Publish</Button>
                          <Button variant="ghost" size="sm" onClick={() => act(ev.id, "ignore")} disabled={busy === ev.id}>Ignore</Button>
                        </span>
                      ) : ev?.status === "published" ? (
                        <span className="whitespace-nowrap">Published {day(ev.published_at)}</span>
                      ) : ev?.status === "ignored" ? (
                        <span className="text-muted-foreground">Ignored</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground"><div className="min-w-[16rem]">{p.reason ?? ""}</div></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
