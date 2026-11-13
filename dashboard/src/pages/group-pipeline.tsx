import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, BarChart3, CheckCircle2, ChevronRight, Trash2 } from "lucide-react";
import { api, groupBookingsHref } from "@/lib/group-api";
import { useToast } from "@/hooks/use-toast";
import { Tile } from "./group-big-picture";
import { BookingForm } from "./group-booking";

// The group, level by level (Mark 2026-11-11): "i need to see all the groups, the top level shows me the status. then be able to branch through it. open
// the group with sub levels for details, leads, quotes, and booked. each sublevel opens up to allow me to choose the name … then open a booking by name
// and see the detail. this should be like a power bi set up where you browse through the sublevels" and, of the first outline, "I want a continuation of
// the power bi format from the top level, not just a list and clean up the detail page by separating the group information (which should be one level
// above) from the individual booking info. this is now becoming a booking platform and should act like one."
//
// So every level is the same kind of page as the top one: a band of number cards and a panel beside it, and a card is the button that opens what it
// counts. All groups → one group (Leads, Quotes, Booked, Group details) → one level (its statuses as cards, its people) → one person (their status and
// next step as cards, then only their own booking). Who stands where, and whose move it is, comes from the server: GET /api/groups/:id/pipeline.

type Row = Record<string, any>;
export type Level = "lead" | "quote" | "booked";
export type Person = {
  id: string; name: string; level: Level | "closed"; key: string; status: string; next: string; on: "mark" | "guest" | "done"; since: string | null;
  category: string | null; party: number | null; replied_at: string | null; protection: string | null; has_booking: boolean;
};
type GroupFile = { group: Row; summary: Row };

export const LEVELS: Array<{ view: "leads" | "quotes" | "booked"; level: Level; label: string; one: string; about: string }> = [
  { view: "leads", level: "lead", label: "Leads", one: "lead", about: "They answered the group page. Their choices are not in yet." },
  { view: "quotes", level: "quote", label: "Quotes", one: "quote", about: "Their choices are in. The price is not approved yet." },
  { view: "booked", level: "booked", label: "Booked", one: "booking", about: "They said Book It. From here it is booking, paperwork and confirming." },
];

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const money0 = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const day = (d: string | null | undefined) => (d ? new Date(d.length <= 10 ? `${d}T12:00:00` : d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");
const moment = (d: string | null | undefined) => (d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const personHref = (groupId: string, p: Pick<Person, "id" | "has_booking">) => `/groups/${groupId}/${p.has_booking ? "booking" : "lead"}/${p.id}`;
const usePipeline = (groupId: string) => useQuery<{ success: boolean; people: Person[] }>({ queryKey: ["group-pipeline", groupId], queryFn: () => api(`/groups/${groupId}/pipeline`) });
const useGroup = (groupId: string) => useQuery<GroupFile>({ queryKey: ["group", groupId], queryFn: () => api(`/groups/${groupId}?horizon=3650`) });

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700 border-slate-200", marketing: "bg-blue-100 text-blue-800 border-blue-200", booking: "bg-amber-100 text-amber-800 border-amber-200",
  "final-paid": "bg-green-100 text-green-800 border-green-200", sailed: "bg-teal-100 text-teal-800 border-teal-200", closed: "bg-gray-100 text-gray-600 border-gray-200", cancelled: "bg-red-100 text-red-700 border-red-200",
};

/** Whose move it is, in two words. */
function Move({ on }: { on: Person["on"] }) {
  if (on === "mark") return <span className="inline-block rounded px-2 py-0.5 text-xs font-semibold bg-red-600 text-white whitespace-nowrap">Your move</span>;
  if (on === "guest") return <span className="inline-block rounded px-2 py-0.5 text-xs font-medium border text-muted-foreground whitespace-nowrap">Waiting on the guest</span>;
  return <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-green-600 whitespace-nowrap"><CheckCircle2 className="w-3.5 h-3.5" /> Done</span>;
}

// Mark 2026-11-12: "there are too many steps here … way too much effort" and "i need to be able to delete a group, quotes, and individuals".
// Where a person's next step is a single press (email the quote again, send the paperwork again, mark the call done, confirm the booking), the list
// does it right there; a refusal comes back in the server's own words. Each row can also be deleted from the list.
const ONE_PRESS: Record<string, { label: string; path: (g: string, id: string) => string; ask: (name: string) => string; done: string }> = {
  "call-booked": { label: "We talked", path: (g, id) => `/groups/${g}/interests/${id}/mark/talked`, ask: (n) => `Mark the planning call with ${n} as done?`, done: "Marked: you talked" },
  "quote-not-sent": { label: "Email the quote now", path: (g, id) => `/groups/${g}/interests/${id}/price-email`, ask: (n) => `Email the quote to ${n} now? It is a real email.`, done: "Quote emailed" },
  "paperwork-not-sent": { label: "Send the paperwork now", path: (g, id) => `/groups/${g}/interests/${id}/booked`, ask: (n) => `Send the paperwork link to ${n} now?`, done: "Paperwork sent" },
  signed: { label: "Mark it confirmed", path: (g, id) => `/groups/${g}/interests/${id}/complete`, ask: (n) => `${n}'s booking is confirmed with the cruise line and every vendor?`, done: "Booking confirmed" },
};
function usePersonActions(groupId: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["group-pipeline", groupId] }); qc.invalidateQueries({ queryKey: ["group", groupId] }); qc.invalidateQueries({ queryKey: ["groups"] }); qc.invalidateQueries({ queryKey: ["group-interests", groupId] }); };
  const press = async (p: Person) => {
    const a = ONE_PRESS[p.key];
    if (!a || !window.confirm(a.ask(p.name))) return;
    setBusy(p.id); setProblem(null);
    try {
      const r = await api<{ price?: { sent?: string } }>(a.path(groupId, p.id), "POST", {});
      if (r.price && r.price.sent && r.price.sent !== "sent") setProblem({ id: p.id, text: `The quote was NOT sent (${r.price.sent === "held" ? "this is the test site and it only emails its test addresses" : r.price.sent === "no-email" ? "no email address on file" : "the mail service refused it"}).` });
      else toast({ title: a.done });
    } catch (e) { setProblem({ id: p.id, text: (e as Error).message }); }
    finally { setBusy(null); refresh(); }
  };
  const remove = async (p: Person): Promise<boolean> => {
    const what = p.level === "lead" || p.level === "closed" ? "lead" : p.level === "quote" ? "quote" : "booking";
    if (!window.confirm(`Delete ${p.name}'s ${what}${p.has_booking ? " and everything on it (their travelers, the uploaded cruise line quote, your open items)? The cabin goes back to held" : ""}? This cannot be undone.`)) return false;
    setBusy(p.id); setProblem(null);
    try {
      const r = await api<{ cabin: string | null }>(`/groups/${groupId}/interests/${p.id}/delete`, "POST", {});
      toast({ title: `${p.name} deleted`, ...(r.cabin ? { description: r.cabin } : {}) });
      return true;
    } catch (e) { setProblem({ id: p.id, text: (e as Error).message }); return false; }
    finally { setBusy(null); refresh(); }
  };
  return { busy, problem, press, remove };
}

// ── The frame every page of one group shares: where you are, the group's name, and the levels as tabs ──

type View = "overview" | "leads" | "quotes" | "booked" | "details";

export function GroupFrame({ groupId, view, person, children }: { groupId: string; view: View; person?: { name: string } | null; children: React.ReactNode }) {
  const { data, error } = useGroup(groupId);
  const { data: pipe } = usePipeline(groupId);
  const g = data?.group, s = data?.summary;
  const count = (level: Level) => (pipe?.people ?? []).filter((p) => p.level === level).length;
  const crumb = "text-muted-foreground hover:text-foreground cursor-pointer";
  const levelName = view === "details" ? "Group details" : LEVELS.find((l) => l.view === view)?.label;
  const tabs: Array<{ view: View; label: string; href: string }> = [
    { view: "overview", label: "Overview", href: `/groups/${groupId}` },
    ...LEVELS.map((l) => ({ view: l.view as View, label: pipe ? `${l.label} (${count(l.level)})` : l.label, href: `/groups/${groupId}/${l.view}` })),
    { view: "details", label: "Group details", href: `/groups/${groupId}/details` },
  ];
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <nav aria-label="Where you are" className="text-xs flex items-center gap-1 flex-wrap">
            <Link href="/groups" className={crumb}>All groups</Link>
            <ChevronRight className="w-3 h-3 text-muted-foreground" />
            {view === "overview" ? <span className="font-semibold">{g?.name ?? "Group"}</span> : <Link href={`/groups/${groupId}`} className={crumb}>{g?.name ?? "Group"}</Link>}
            {view !== "overview" && (<>
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
              {person ? <Link href={`/groups/${groupId}/${view}`} className={crumb}>{levelName}</Link> : <span className="font-semibold">{levelName}</span>}
            </>)}
            {person && (<><ChevronRight className="w-3 h-3 text-muted-foreground" /><span className="font-semibold">{person.name}</span></>)}
          </nav>
          <h2 className="text-xl font-bold tracking-tight mt-1">{person ? person.name : g?.name ?? "Group"}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {person ? `${g?.name ?? ""} · ` : ""}{g ? [g.cruise_line, g.ship_name].filter(Boolean).join(" · ") || "Ship not set" : ""}{g?.sail_date ? ` · sails ${day(g.sail_date)}` : ""}
            {s && s.daysToSail !== null && s.daysToSail >= 0 ? ` · ${s.daysToSail} days to go` : ""}
          </p>
        </div>
        {g && (
          <div className="flex items-center gap-2">
            <a href={groupBookingsHref(`g=${g.id}&status=all`)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs px-3 py-1 rounded-md border bg-card hover:border-foreground/30" title="Open this group in the Group Bookings app"><BarChart3 className="w-3.5 h-3.5" /> Group Bookings app</a>
            <Badge variant="outline" className={STATUS_STYLE[g.status] ?? ""}>{g.status}</Badge>
          </div>
        )}
      </div>
      {error && !data && <p className="text-destructive">Could not load this group: {(error as Error).message}</p>}
      <div role="tablist" aria-label="The levels of this group" className="flex flex-wrap gap-x-1 border-b">
        {tabs.map((t) => (
          <Link key={t.view} href={t.href} role="tab" aria-selected={view === t.view}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap ${view === t.view ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{t.label}</Link>
        ))}
      </div>
      {children}
    </div>
  );
}

// ── One group: the levels as number cards, and what is waiting on Mark ──

export function GroupOverview({ groupId }: { groupId: string }) {
  const { data } = useGroup(groupId);
  const { data: pipe, error } = usePipeline(groupId);
  const s = data?.summary;
  const people = pipe?.people ?? [];
  const mine = people.filter((p) => p.on === "mark");
  const attention: Row[] = s?.attention ?? [];
  return (
    <GroupFrame groupId={groupId} view="overview">
      <Card>
        <div className="px-4 py-3 border-b">
          <h3 className="font-semibold">This group at a glance</h3>
          <p className="text-xs text-muted-foreground">Open a card to see the people in it. Group details holds the group's own file: dates, cabins, travelers, payments, paperwork.</p>
        </div>
        {error && !pipe && <p className="px-4 py-4 text-sm text-red-700 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> The people of this group could not load: {(error as Error).message}</p>}
        <div className="p-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
          <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] content-start">
            {LEVELS.map((l) => {
              const here = people.filter((p) => p.level === l.level), yours = here.filter((p) => p.on === "mark").length;
              return <Tile key={l.view} label={l.label} value={pipe ? String(here.length) : "…"} href={`/groups/${groupId}/${l.view}`}
                caption={yours > 0 ? `${plural(here.length, "person", "people")} · ${yours} waiting on you` : `${plural(here.length, "person", "people")} · none waiting on you`} captionBad={yours > 0} />;
            })}
            {s && (<>
              <Tile label="Cabins booked" value={`${s.cabins.booked} of ${s.cabins.total - s.cabins.released}`} caption={`cabins · ${s.cabins.held} held`} href={`/groups/${groupId}/details/cabins`} />
              <Tile label={s.deposits.total > 0 ? "Deposits paid" : "Paid"} value={s.deposits.total > 0 ? `${money0(s.deposits.paid)} of ${money0(s.deposits.total)}` : money0(s.payments.paidTotal)}
                caption={s.payments.overdueCount > 0 ? `dollars · ${plural(s.payments.overdueCount, "payment")} overdue` : `dollars · ${money0(s.payments.dueTotal)} still due`} captionBad={s.payments.overdueCount > 0} href={`/groups/${groupId}/details/payments`} />
              <Tile label="Travelers signed" value={`${s.travelers.signed} of ${s.travelers.total}`} caption={`travelers · ${s.documents.open} open paperwork items`} href={`/groups/${groupId}/details/paperwork`} />
            </>)}
          </div>
          <div className="space-y-4">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Waiting on you</div>
              {pipe && mine.length === 0 ? <p className="text-sm text-muted-foreground">Nobody in this group is waiting on you.</p> : (
                <ul className="divide-y divide-border rounded-md border bg-card">
                  {mine.map((p) => (
                    <li key={p.id}>
                      <Link href={personHref(groupId, p)} className="flex items-start gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-muted/40">
                        <span className="min-w-0 flex-1"><span className="font-medium">{p.name}</span><span className="text-muted-foreground"> · {p.status}</span><span className="block text-red-500">{p.next}</span></span>
                        <ChevronRight className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Group deadlines</div>
              {s && attention.length === 0 ? <p className="text-sm text-muted-foreground">Nothing dated is open.</p> : (
                <ul className="divide-y divide-border rounded-md border bg-card">
                  {attention.slice(0, 6).map((a, i) => (
                    <li key={i} className="flex items-baseline justify-between gap-3 px-3 py-1.5 text-sm">
                      <span className="min-w-0">{a.label}</span>
                      <span className={`whitespace-nowrap ${a.overdue ? "text-red-600 font-semibold" : "text-muted-foreground"}`}>{a.due ? day(a.due) : "no date"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </Card>
    </GroupFrame>
  );
}

// ── One level: its statuses as number cards (a card filters the people), and the people ──

export function LevelPage({ groupId, view }: { groupId: string; view: "leads" | "quotes" | "booked" }) {
  const [, go] = useLocation();
  const L = LEVELS.find((l) => l.view === view)!;
  const { data: pipe, error } = usePipeline(groupId);
  const [only, setOnly] = useState<string | null>(null);   // "mine", or one status key
  const here = (pipe?.people ?? []).filter((p) => p.level === L.level);
  const closed = view === "leads" ? (pipe?.people ?? []).filter((p) => p.level === "closed") : [];
  const keys = [...new Map(here.map((p) => [p.key, p.status.split(":")[0]!])).entries()];
  const shown = (only === "closed" ? closed : here).filter((p) => !only || only === "closed" || (only === "mine" ? p.on === "mark" : p.key === only));
  const yours = here.filter((p) => p.on === "mark").length;
  const pick = (k: string) => setOnly((o) => (o === k ? null : k));
  const act = usePersonActions(groupId);
  return (
    <GroupFrame groupId={groupId} view={view}>
      <Card>
        <div className="px-4 py-3 border-b">
          <h3 className="font-semibold">{L.label}</h3>
          <p className="text-xs text-muted-foreground">{L.about} Press a card to show only those people; press a name to open it.</p>
        </div>
        {error && !pipe && <p className="px-4 py-4 text-sm text-red-700 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> This level could not load: {(error as Error).message}</p>}
        <div className="p-4 space-y-4">
          <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))]">
            <Tile label={`All ${L.label.toLowerCase()}`} value={pipe ? String(here.length) : "…"} caption={plural(here.length, "person", "people").replace(/^\d+ /, "")} onClick={() => setOnly(null)} active={only === null} />
            <Tile label="Waiting on you" value={String(yours)} caption={yours === 1 ? "person · your move" : "people · your move"} bad={yours > 0} onClick={() => pick("mine")} active={only === "mine"} />
            {keys.map(([k, label]) => {
              const n = here.filter((p) => p.key === k).length;
              return <Tile key={k} label={label} value={String(n)} caption={n === 1 ? "person" : "people"} onClick={() => pick(k)} active={only === k} />;
            })}
            {closed.length > 0 && <Tile label="Closed" value={String(closed.length)} caption={closed.length === 1 ? "person · declined or spam" : "people · declined or spam"} onClick={() => pick("closed")} active={only === "closed"} />}
          </div>
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-left text-muted-foreground">
                  <th className="px-3 py-2 font-semibold">Name</th><th className="px-3 py-2 font-semibold">Asked for</th><th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Next step</th><th className="px-3 py-2 font-semibold">Whose move</th><th className="px-3 py-2 font-semibold">Do it</th><th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pipe && shown.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">{here.length === 0 && only === null ? `Nobody is on this level right now.` : "Nobody matches that card."}</td></tr>}
                {shown.map((p) => (
                  <tr key={p.id} className="cursor-pointer hover:bg-muted/30" onClick={() => go(personHref(groupId, p))}>
                    <td className="px-3 py-2.5 font-semibold whitespace-nowrap"><Link href={personHref(groupId, p)} className="underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>{p.name}</Link></td>
                    <td className="px-3 py-2.5 text-muted-foreground">{[p.category, p.party ? `party of ${p.party}` : null].filter(Boolean).join(" · ") || "not said yet"}</td>
                    <td className="px-3 py-2.5">{p.status}{p.since ? <span className="block text-xs text-muted-foreground">{p.key === "call-booked" || p.key === "talked" ? `call: ${moment(p.since)}` : `since ${moment(p.since)}`}</span> : null}</td>
                    <td className={`px-3 py-2.5 ${p.on === "mark" ? "text-red-500 font-medium" : "text-muted-foreground"}`}>{p.next}{act.problem?.id === p.id && <span role="alert" className="block mt-1 font-semibold text-red-500">{act.problem.text}</span>}</td>
                    <td className="px-3 py-2.5"><Move on={p.on} /></td>
                    <td className="px-3 py-2.5 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      {ONE_PRESS[p.key]
                        ? <button className="text-xs font-semibold px-3 py-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-50" disabled={act.busy === p.id} onClick={() => void act.press(p)}>{ONE_PRESS[p.key]!.label}</button>
                        : <Link href={personHref(groupId, p)} className="text-xs px-3 py-1.5 rounded-md border bg-card hover:border-foreground/40">Open</Link>}
                    </td>
                    <td className="pr-2" onClick={(e) => e.stopPropagation()}><button title={`Delete ${p.name}`} aria-label={`Delete ${p.name}`} disabled={act.busy === p.id} onClick={() => void act.remove(p)} className="text-muted-foreground hover:text-red-500 disabled:opacity-50"><Trash2 className="w-4 h-4" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Card>
    </GroupFrame>
  );
}

// ── One lead: who they are, where they stand, and the two things Mark can do ──

export function LeadPage({ groupId, iid }: { groupId: string; iid: string }) {
  const [, go] = useLocation();
  const people = usePersonActions(groupId);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: pipe } = usePipeline(groupId);
  const { data: replies, error } = useQuery<{ interests: Row[] }>({ queryKey: ["group-interests", groupId], queryFn: () => api(`/groups/${groupId}/interests`) });
  const p = pipe?.people.find((x) => x.id === iid) ?? null;
  const r = replies?.interests.find((x) => x.id === iid) ?? null;
  const [busy, setBusy] = useState(false);
  const act = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await what(); toast({ title: done }); }
    catch (e) { toast({ variant: "destructive", title: "Not done", description: (e as Error).message }); }
    finally { setBusy(false); qc.invalidateQueries({ queryKey: ["group-pipeline", groupId] }); qc.invalidateQueries({ queryKey: ["group-interests", groupId] }); }
  };
  const btn = "text-sm px-4 py-2 rounded-md border bg-card hover:bg-muted/40 disabled:opacity-50";
  const fact = (label: string, value: React.ReactNode) => <div><div className="text-xs text-muted-foreground">{label}</div><div className="text-sm">{value || <span className="text-muted-foreground">not given</span>}</div></div>;
  return (
    <GroupFrame groupId={groupId} view="leads" person={{ name: p?.name ?? "Lead" }}>
      {error && !replies && <p className="text-destructive">Could not load this lead: {(error as Error).message}</p>}
      {pipe && !p && <p className="text-muted-foreground">That person is not in this group.</p>}
      {p && (
        <Card>
          <div className="p-4 grid gap-3 grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
            <Tile label="Status" value={p.status} small caption={p.since ? (p.key === "call-booked" || p.key === "talked" ? `call: ${moment(p.since)}` : `since ${moment(p.since)}`) : p.replied_at ? `answered the group page ${day(p.replied_at)}` : ""} />
            <Tile label="Next step" value={p.next} small caption={p.on === "mark" ? "your move" : p.on === "guest" ? "waiting on the guest" : "done"} bad={p.on === "mark"} />
            <Tile label="Asked for" value={p.category ?? "Not said yet"} small caption={p.party ? `party of ${p.party}` : "party size not given"} />
          </div>
          {r && (
            <div className="border-t p-4 space-y-4">
              <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                {fact("Email", r.email)}{fact("Phone", r.phone)}{fact("Language", r.lang === "es" ? "Spanish" : "English")}
                {fact("Answered the group page", day(r.created_at))}{fact("Planning call", r.call_when ? moment(r.call_when) : null)}{fact("Their note", r.note)}
              </div>
              <div className="flex flex-wrap gap-2 items-center">
                {p.key === "call-booked" && <button className={`${btn} bg-primary text-primary-foreground border-primary`} disabled={busy} onClick={() => act(() => api(`/groups/${groupId}/interests/${iid}/mark/talked`, "POST", {}), "Marked: you talked")}>We talked</button>}
                {p.level !== "closed" && <button className={btn} disabled={busy} onClick={() => { if (window.confirm(`Close ${p.name} as declined? They leave the Leads list. You can reopen them here.`)) void act(() => api(`/groups/${groupId}/interests/${iid}`, "PATCH", { status: "declined" }), "Lead closed"); }}>Close this lead (declined)</button>}
                {p.level === "closed" && <button className={btn} disabled={busy} onClick={() => act(() => api(`/groups/${groupId}/interests/${iid}`, "PATCH", { status: "new" }), "Lead reopened")}>Reopen this lead</button>}
                <button className={`${btn} ml-auto text-red-500 border-red-500/50 inline-flex items-center gap-1`} disabled={busy || people.busy === iid} onClick={async () => { if (await people.remove(p)) go(`/groups/${groupId}/leads`); }}><Trash2 className="w-4 h-4" /> Delete this lead</button>
              </div>
              {people.problem?.id === iid && <p role="alert" className="text-sm font-semibold text-red-500">{people.problem.text}</p>}
              <p className="text-xs text-muted-foreground">This person moves to Quotes by themselves the moment their choices come in. The names they typed and the cabin to place them on are under <Link href={`/groups/${groupId}/details/marketing`} className="underline">Group details, Marketing, Replies from the page</Link>.</p>
            </div>
          )}
        </Card>
      )}
    </GroupFrame>
  );
}

// ── One booking: only this person's booking. Its cards (status, next step as a button, totals) and its summary are the form's own first screen. ──

export function BookingPage({ groupId, iid }: { groupId: string; iid: string }) {
  const { data: pipe } = usePipeline(groupId);
  const p = pipe?.people.find((x) => x.id === iid) ?? null;
  const view = p?.level === "booked" ? "booked" : "quotes";
  return (
    <GroupFrame groupId={groupId} view={view} person={{ name: p?.name ?? "Booking" }}>
      {pipe && !p && <p className="text-muted-foreground">That person is not in this group.</p>}
      {p && <Card><BookingForm key={iid} groupId={groupId} iid={iid} stage={p} /></Card>}
    </GroupFrame>
  );
}
