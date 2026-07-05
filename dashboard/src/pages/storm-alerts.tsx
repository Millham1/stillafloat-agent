import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { CloudLightning, Ship, Send, Trash2, ChevronDown, RefreshCw } from "lucide-react";
import { authHeaders } from "@/lib/auth-token";

type Sailing = { ship_name: string; cruise_line: string; depart_port: string | null; start_date: string; end_date: string };
type CruiseInfo = { line: string; note: string; url?: string };
type Alert = {
  id: string;
  name: string;
  classification: string | null;
  status: string;
  is_threat: boolean;
  grounds_label: string;
  formation_chance: number | null;
  headline: string | null;
  body_md: string | null;
  detail_md: string | null;
  cruise_line_info: CruiseInfo[];
  sailings: Sailing[];
  sent_count: number;
  sent_at: string | null;
};
type AlertsResponse = { alerts: Alert[] };

const STATUS_COLORS: Record<string, string> = {
  draft:    "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300",
  approved: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300",
  sent:     "bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300",
};

function formatCruiseInfo(arr: CruiseInfo[]): string {
  return (arr ?? []).map((a) => [a.line, a.note, a.url].filter(Boolean).join(" :: ")).join("\n");
}
function parseCruiseInfo(text: string): CruiseInfo[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const p = l.split("::").map((x) => x.trim());
    return { line: p[0] ?? "", note: p[1] ?? "", url: p[2] ?? "" };
  });
}

export default function StormAlerts() {
  const { toast } = useToast();
  const [scanning, setScanning] = useState(false);
  const { data, isLoading, refetch } = useQuery<AlertsResponse>({
    queryKey: ["storm-alerts"],
    queryFn: () => fetch("/api/storm-alerts", { headers: { ...authHeaders() } }).then((r) => r.json()),
    staleTime: 30_000,
  });

  const alerts = data?.alerts ?? [];

  async function runScan(test: boolean) {
    setScanning(true);
    try {
      const r = await fetch(`/api/storm-scan${test ? "?test=1" : ""}`, {
        method: "POST", headers: { ...authHeaders() },
      }).then((x) => x.json());
      toast({ title: "Scan complete", description: `${r.drafted ?? 0} new · ${r.updated ?? 0} updated · ${r.scanned ?? 0} scanned` });
      await refetch();
    } catch {
      toast({ variant: "destructive", title: "Scan failed" });
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <CloudLightning className="h-6 w-6 text-sky-600" />
          <h1 className="text-xl font-semibold">Storm Alerts</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => runScan(false)} disabled={scanning}>
            <RefreshCw className={`h-4 w-4 mr-1 ${scanning ? "animate-spin" : ""}`} /> Scan NHC
          </Button>
          <Button variant="secondary" size="sm" onClick={() => runScan(true)} disabled={scanning}>
            Test alert
          </Button>
        </div>
      </div>

      {isLoading && <p className="text-muted-foreground">Loading…</p>}
      {!isLoading && alerts.length === 0 && (
        <Card><CardContent className="py-10 text-center text-muted-foreground">
          No active storm alerts. The scanner runs hourly; use “Test alert” to preview the flow.
        </CardContent></Card>
      )}

      <div className="space-y-4">
        {alerts.map((a) => (
          <AlertCard key={a.id} alert={a} onChanged={refetch} />
        ))}
      </div>
    </div>
  );
}

function AlertCard({ alert, onChanged }: { alert: Alert; onChanged: () => void }) {
  const { toast } = useToast();
  const [headline, setHeadline] = useState(alert.headline ?? "");
  const [body, setBody] = useState(alert.body_md ?? "");
  const [cruiseInfo, setCruiseInfo] = useState(formatCruiseInfo(alert.cruise_line_info));
  const [showShips, setShowShips] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = headline !== (alert.headline ?? "")
    || body !== (alert.body_md ?? "")
    || cruiseInfo !== formatCruiseInfo(alert.cruise_line_info);

  async function call(path: string, method: string, payload?: unknown) {
    setBusy(true);
    try {
      return await fetch(`/api/storm-alerts/${alert.id}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...authHeaders() },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      }).then((x) => x.json());
    } finally {
      setBusy(false);
    }
  }

  const editPayload = () => ({
    headline, body_md: body, cruise_line_info: parseCruiseInfo(cruiseInfo),
  });

  async function save() {
    await call("", "PATCH", editPayload());
    toast({ title: "Saved" });
    onChanged();
  }
  async function approve() {
    if (dirty) await call("", "PATCH", editPayload());
    const r = await call("/approve", "POST");
    toast({ title: "Approved & sent", description: `Emailed ${r?.sent ?? 0} subscriber(s).` });
    onChanged();
  }
  async function dismiss() {
    await call("/dismiss", "POST");
    toast({ title: "Dismissed" });
    onChanged();
  }

  return (
    <Card>
      <CardContent className="py-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className={STATUS_COLORS[alert.status] ?? ""}>{alert.status}</Badge>
          <span className="font-semibold">{alert.name}</span>
          {alert.classification && <Badge variant="outline">{alert.classification}</Badge>}
          {alert.formation_chance != null && (
            <Badge variant="outline">{alert.formation_chance}% formation</Badge>
          )}
          {alert.grounds_label && <span className="text-sm text-muted-foreground">{alert.grounds_label}</span>}
        </div>

        <Input value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="Headline" />
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} placeholder="What this means for you…" />

        <div>
          <label className="text-xs font-medium text-muted-foreground">
            Cruise-line advisories — one per line: <code>Line :: note :: url</code>
          </label>
          <Textarea
            value={cruiseInfo}
            onChange={(e) => setCruiseInfo(e.target.value)}
            rows={3}
            placeholder="Royal Caribbean :: Symphony skipping St. Thomas :: https://…"
          />
        </div>

        <div>
          <button
            type="button"
            onClick={() => setShowShips((s) => !s)}
            className="inline-flex items-center gap-1 text-sm font-medium text-sky-700 dark:text-sky-300"
          >
            <Ship className="h-4 w-4" />
            Impacted sailings ({alert.sailings.length})
            <ChevronDown className={`h-4 w-4 transition-transform ${showShips ? "rotate-180" : ""}`} />
          </button>
          {showShips && (
            alert.sailings.length > 0 ? (
              <ul className="mt-2 border rounded-md divide-y">
                {alert.sailings.map((s, i) => (
                  <li key={`${s.ship_name}-${i}`} className="px-3 py-2 text-sm flex justify-between gap-3">
                    <span>{s.ship_name} <span className="text-muted-foreground">· {s.cruise_line}</span></span>
                    <span className="text-muted-foreground">{s.depart_port ? `${s.depart_port} · ` : ""}{s.start_date}–{s.end_date}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">No tracked sailings match this system’s area + dates.</p>
            )
          )}
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          {dirty && (
            <Button variant="outline" size="sm" onClick={save} disabled={busy}>Save edits</Button>
          )}
          {alert.status !== "sent" && (
            <Button size="sm" onClick={approve} disabled={busy}>
              <Send className="h-4 w-4 mr-1" /> Approve &amp; Send
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={dismiss} disabled={busy}>
            <Trash2 className="h-4 w-4 mr-1" /> Dismiss
          </Button>
          {alert.status === "sent" && (
            <span className="text-sm text-muted-foreground self-center">Sent to {alert.sent_count} subscriber(s)</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
