import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import {
  Mail, CalendarDays, ListTodo, Lightbulb, Wallet, Megaphone,
  RefreshCw, ExternalLink, CheckCircle2, AlertTriangle, CalendarClock,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { authHeaders, getStoredToken } from "@/lib/auth-token";
import { EnableAlerts } from "@/components/enable-alerts";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";

interface ActionItem { thread_id: string; label: string; priority: string; sender: string; subject: string; snippet: string; unread: boolean; url: string; }
interface CalEvent { title: string; time: string; all_day: boolean; location: string; link: string; }
interface TaskItem { id: string; title: string; status: string; due_date?: string | null; }
interface IdeaItem { id: string; note: string; category?: string | null; }
interface MoneyBlock {
  month: string; month_expense: number; month_income: number; month_net: number;
  recent_receipts: Array<{ vendor?: string; amount?: number; currency?: string }>;
  upcoming_charges: Array<{ vendor?: string; amount?: number; currency?: string; next_charge_date?: string }>;
}
interface Brief {
  date: string; generatedAt: string; nothingToDo: boolean; opsReachable: boolean;
  sections: {
    actions: ActionItem[]; calendar: CalEvent[]; tasks: TaskItem[];
    ideas: { count: number; items: IdeaItem[] };
    money: MoneyBlock | null;
    social: { pending: number; items: Array<{ title: string; track: string }>; reviewPath: string };
  };
  counts: { actions: number; tasks: number; ideasNew: number; socialPending: number; events: number };
}

function money(n?: number, currency = "USD"): string {
  if (n == null) return "";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n); }
  catch { return `$${n.toFixed(2)}`; }
}

function Section({ icon: Icon, title, count, children }: {
  icon: React.ComponentType<{ className?: string }>; title: string; count?: number; children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-3">
          <Icon className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          {typeof count === "number" && count > 0 && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent text-accent-foreground">{count}</span>
          )}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

interface Conflict {
  key: string; new_title: string; new_start: string;
  existing_title: string; existing_start: string; sender: string; subject: string;
}

export default function Today() {
  const { toast } = useToast();
  const [resolving, setResolving] = React.useState<string | null>(null);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["daily-brief"],
    queryFn: async (): Promise<Brief> => {
      const r = await fetch("/api/brief", { headers: { ...authHeaders() } });
      if (!r.ok) throw new Error(`Failed to load brief (HTTP ${r.status})`);
      const j = await r.json();
      return j.brief as Brief;
    },
  });

  const conflictsQuery = useQuery({
    queryKey: ["calendar-conflicts"],
    queryFn: async (): Promise<Conflict[]> => {
      const r = await fetch("/api/ops/conflicts", { headers: { ...authHeaders() } });
      if (!r.ok) return [];
      const j = await r.json();
      return (j.conflicts ?? []) as Conflict[];
    },
  });
  const conflicts = conflictsQuery.data ?? [];

  const resolveConflict = async (key: string, choice: "1" | "2" | "3") => {
    setResolving(key);
    try {
      const r = await fetch("/api/ops/resolve-conflict", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ key, choice }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      toast({ title: "Conflict resolved", description: j.message });
      conflictsQuery.refetch();
      refetch();
    } catch (err) {
      toast({ variant: "destructive", title: "Couldn't resolve", description: (err as Error).message });
    } finally {
      setResolving(null);
    }
  };

  const refresh = async () => {
    await fetch("/api/brief?fresh=1", { headers: { ...authHeaders() } }).catch(() => {});
    refetch();
    conflictsQuery.refetch();
  };

  const s = data?.sections;
  const socialHref = s ? `${API_BASE}${s.social.reviewPath}?token=${encodeURIComponent(getStoredToken())}` : "#";

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Today</h2>
          <p className="text-sm text-muted-foreground mt-1">{data?.date ?? "Your daily brief"}</p>
        </div>
        <button
          onClick={refresh}
          disabled={isFetching}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border hover:bg-accent disabled:opacity-60 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      <EnableAlerts />

      {isLoading && <div className="text-sm text-muted-foreground animate-pulse">Building your brief…</div>}

      {data && !data.opsReachable && (
        <div className="flex items-center gap-2 text-sm rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-amber-600 dark:text-amber-400">
          <AlertTriangle className="w-4 h-4" /> Couldn't reach the ops-manager — calendar, mail, tasks and money may be incomplete.
        </div>
      )}

      {conflicts.length > 0 && (
        <Section icon={CalendarClock} title="Calendar conflicts — needs your call" count={conflicts.length}>
          <div className="space-y-3">
            {conflicts.map((c) => (
              <div key={c.key} className="rounded-md border border-red-500/40 bg-red-500/5 p-3">
                <div className="text-sm">
                  <span className="font-semibold">{c.new_title}</span>
                  <span className="text-muted-foreground"> clashes with </span>
                  <span className="font-semibold">{c.existing_title}</span>
                </div>
                {c.subject && <div className="text-xs text-muted-foreground mt-1">From email: {c.subject}{c.sender ? ` — ${c.sender}` : ""}</div>}
                <div className="flex flex-wrap gap-2 mt-3">
                  <button onClick={() => resolveConflict(c.key, "1")} disabled={resolving === c.key}
                    className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 font-medium">
                    Keep new (reschedule existing)
                  </button>
                  <button onClick={() => resolveConflict(c.key, "2")} disabled={resolving === c.key}
                    className="text-xs px-3 py-1.5 rounded-md border hover:bg-accent disabled:opacity-60">
                    Keep existing (decline new)
                  </button>
                  <button onClick={() => resolveConflict(c.key, "3")} disabled={resolving === c.key}
                    className="text-xs px-3 py-1.5 rounded-md border hover:bg-accent disabled:opacity-60">
                    Keep both
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {data?.nothingToDo && conflicts.length === 0 && (
        <Card className="border-emerald-500/30 bg-emerald-500/5">
          <CardContent className="p-6 flex items-center gap-3">
            <CheckCircle2 className="w-6 h-6 text-emerald-500" />
            <div>
              <div className="font-semibold">Nothing needs you today.</div>
              <div className="text-sm text-muted-foreground">Inbox, calendar, tasks and posts are all clear. ⚓</div>
            </div>
          </CardContent>
        </Card>
      )}

      {s && s.actions.length > 0 && (
        <Section icon={Mail} title="Waiting on you" count={s.actions.length}>
          <div className="space-y-2">
            {s.actions.map((a) => (
              <a key={a.thread_id} href={a.url} target="_blank" rel="noopener noreferrer"
                 className="block rounded-md border p-3 hover:bg-accent/50 transition-colors">
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${a.priority === "high" ? "bg-red-500/15 text-red-600 dark:text-red-400" : "bg-amber-500/15 text-amber-600 dark:text-amber-400"}`}>{a.label}</span>
                  {a.unread && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/15 text-primary">unread</span>}
                  <span className="font-medium text-sm truncate">{a.subject}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">{a.sender}{a.snippet ? ` — ${a.snippet}` : ""}</div>
              </a>
            ))}
          </div>
        </Section>
      )}

      {s && s.social.pending > 0 && (
        <Section icon={Megaphone} title="Social posts to review" count={s.social.pending}>
          <div className="text-sm text-foreground/80">
            {s.social.items.map((i, idx) => (
              <div key={idx} className="py-1">• {i.title} <span className="text-xs text-muted-foreground">(Track {i.track})</span></div>
            ))}
          </div>
          <a href={socialHref} target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1.5 mt-3 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium">
            Review &amp; approve <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </Section>
      )}

      {s && s.calendar.length > 0 && (
        <Section icon={CalendarDays} title="Today's calendar" count={s.calendar.length}>
          <div className="space-y-1.5">
            {s.calendar.map((e, idx) => (
              <div key={idx} className="flex items-baseline gap-3 text-sm">
                <span className="font-mono text-xs text-muted-foreground w-20 flex-shrink-0">{e.time}</span>
                <span className="font-medium">{e.title}</span>
                {e.location && <span className="text-xs text-muted-foreground">@ {e.location}</span>}
                {e.link && <a href={e.link} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">join</a>}
              </div>
            ))}
          </div>
        </Section>
      )}

      {s && s.tasks.length > 0 && (
        <Section icon={ListTodo} title="Open tasks" count={s.tasks.length}>
          <div className="space-y-1">
            {s.tasks.map((t) => (
              <div key={t.id} className="text-sm flex items-center gap-2">
                <span className={t.status === "in_progress" ? "text-primary" : "text-muted-foreground"}>{t.status === "in_progress" ? "▶" : "•"}</span>
                <span>{t.title}</span>
                {t.due_date && <span className="text-xs text-muted-foreground">(due {t.due_date})</span>}
              </div>
            ))}
          </div>
        </Section>
      )}

      {s && s.ideas.count > 0 && (
        <Section icon={Lightbulb} title="New phone notes" count={s.ideas.count}>
          <div className="space-y-1 text-sm text-foreground/80">
            {s.ideas.items.map((i) => (<div key={i.id} className="py-0.5">“{i.note}”</div>))}
          </div>
        </Section>
      )}

      {s?.money && (
        <Section icon={Wallet} title="Money">
          <div className="text-sm">
            This month: <span className={`font-semibold ${s.money.month_net >= 0 ? "text-emerald-500" : "text-red-500"}`}>{money(s.money.month_net)}</span> net
            <span className="text-muted-foreground"> (in {money(s.money.month_income)} / out {money(s.money.month_expense)})</span>
          </div>
          {s.money.upcoming_charges?.length > 0 && (
            <div className="text-xs text-muted-foreground mt-2">
              Upcoming: {s.money.upcoming_charges.map((c, i) => (
                <span key={i}>{i > 0 ? " · " : ""}{c.vendor} {money(c.amount, c.currency || "USD")} ({c.next_charge_date})</span>
              ))}
            </div>
          )}
          {s.money.recent_receipts?.length > 0 && (
            <div className="text-xs text-muted-foreground mt-1">
              Recent: {s.money.recent_receipts.slice(0, 3).map((r, i) => (
                <span key={i}>{i > 0 ? " · " : ""}{r.vendor} {money(r.amount, r.currency || "USD")}</span>
              ))}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
