import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Route, Eye, Check, Send, Plus, Trash2, FlaskConical, Link2, Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { ApiFn } from "./group-paperwork";

// The group journey (migration 0053): the emails after the paperwork — the booking confirmation, the 120 / 90 / 45 / 20 / 10 / 5 / 2-day
// messages, payment notices and the nudge for missing details — plus change notices from Mark. Templates are approved ONCE (Mark 2026-10-02):
// he previews each one here, in English and Spanish, for a sample traveler, and approves it. The daily job sends only approved templates.
// The rules are in server/src/lib/group-journey*.ts; the traveler's own page is server/public/my-cruise.html.

type Row = Record<string, any>;

type Approval = { kind: string; approved: boolean; source: "group" | "default" | "none"; at: string | null; stale: boolean };
type Counts = { planned: number; due: number; sent: number; failed: number; skipped: number; blocked: number };
type Milestone = { kind: string; label: string; date: string | null; counts: Counts; sampleTravelerId: string | null; approval: Approval };
type PlanItem = { kind: string; date: string | null; status: string; reason: string | null; blocked: string | null };
type PlanTraveler = { id: string; name: string; lang: "en" | "es"; has_email: boolean; items: PlanItem[] };
type JourneyData = {
  success: boolean; template_version: string; sim_enabled: boolean; link_key_set: boolean; test_list_set: boolean;
  live: boolean; live_reason: string | null; today: string; sail_date: string | null; days_to_sail: number | null; video_sources: string[];
  milestones: Milestone[]; travelers: PlanTraveler[];
  messages: Array<{ id: string; template: string; traveler: string | null; to_email: string | null; subject: string | null; status: string; sent_at: string | null; created_at: string; error: string | null; sim: boolean }>;
  told: Array<{ traveler_id: string; name: string; answers: Record<string, string>; updated_at: string | null }>;
};
type Preview = { success: boolean; kind: string; lang: "en" | "es"; traveler: { id: string; name: string; lang: "en" | "es" }; subject: string; html: string; text: string; sections: string[]; notes: string[]; recipients?: Array<{ id: string; name: string; lang: string; willSend: boolean; reason: string | null }>; will_send?: number };
type SimResult = { success: boolean; count: number; sent: number; to_email: string; messages: Array<{ kind: string; subject: string; sections: string[]; status: string; reason: string | null }> };

const btn = "text-xs px-2 py-1 rounded border bg-card hover:bg-muted/40 disabled:opacity-50 inline-flex items-center gap-1 whitespace-nowrap";
const input = "px-2 py-1 rounded border bg-card text-sm";

const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d.slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
const when = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

const SHORT: Record<string, string> = {
  confirmation: "Booked", "t-120": "120", "t-90": "90", "t-45": "45", "t-20": "20", "t-10": "10", "t-5": "5", "t-2": "2", "payment-due": "Pay", "data-needed": "Nudge",
};
const MATRIX = ["confirmation", "t-120", "t-90", "t-45", "t-20", "t-10", "t-5", "t-2"];
const STATUS_CLS: Record<string, string> = {
  sent: "bg-green-100 text-green-800 border-green-200", due: "bg-amber-100 text-amber-800 border-amber-200", planned: "bg-slate-100 text-slate-700 border-slate-200",
  skipped: "bg-slate-50 text-slate-500 border-slate-200", failed: "bg-red-100 text-red-800 border-red-200",
};

function approvalChip(a: Approval) {
  if (a.approved) return <Badge variant="outline" className="bg-green-100 text-green-800 border-green-200">Approved{a.source === "default" ? " (site default)" : ""}</Badge>;
  if (a.stale) return <Badge variant="outline" className="bg-amber-100 text-amber-800 border-amber-200">Words changed: approve again</Badge>;
  return <Badge variant="outline" className="bg-slate-100 text-slate-700 border-slate-200">Not approved</Badge>;
}

// ── The preview ───────────────────────────────────────────────────────────────

function PreviewPanel({ p, onLang, onClose }: { p: Preview; onLang: (l: "en" | "es") => void; onClose: () => void }) {
  return (
    <div className="m-4 border rounded-md bg-muted/20">
      <div className="px-3 py-2 border-b flex items-center gap-2 flex-wrap text-sm">
        <span className="font-semibold">Preview for {p.traveler.name || "a traveler"}</span>
        <div className="flex border rounded overflow-hidden">
          {(["en", "es"] as const).map((l) => <button key={l} className={`px-2 py-0.5 text-xs ${p.lang === l ? "bg-foreground text-background" : "bg-card"}`} onClick={() => onLang(l)}>{l === "en" ? "English" : "Español"}</button>)}
        </div>
        <button className={`${btn} ml-auto`} onClick={onClose}>Close</button>
      </div>
      <div className="px-3 py-2 text-sm space-y-1">
        <div><span className="text-muted-foreground">Subject:</span> <span className="font-semibold">{p.subject}</span></div>
        <div className="text-xs text-muted-foreground">Sections in this email: {p.sections.join(", ")}. A section the file cannot support is left out, never printed blank.</div>
        {p.notes.map((n, i) => <div key={i} className="text-xs text-amber-700">{n}</div>)}
        {p.recipients && (
          <div className="text-xs">
            <span className="font-semibold">Will be sent to {p.will_send} of {p.recipients.length}.</span>{" "}
            <span className="text-muted-foreground">{p.recipients.filter((r) => !r.willSend).map((r) => `${r.name} (${r.reason})`).join("; ")}</span>
          </div>
        )}
      </div>
      <iframe title="Email preview" sandbox="" srcDoc={`<!doctype html><meta charset="utf-8"><body style="margin:0;padding:12px;background:#fff">${p.html}</body>`} className="w-full bg-white border-t" style={{ height: 620 }} />
    </div>
  );
}

// ── The change-notice composer ───────────────────────────────────────────────

type Field = { label: string; before: string; after: string };

function ChangeNotice({ api, groupId, travelers, data, onSent }: { api: ApiFn; groupId: string; travelers: PlanTraveler[]; data: JourneyData; onSent: () => void }) {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [textEs, setTextEs] = useState("");
  const [fields, setFields] = useState<Field[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [tid, setTid] = useState("");
  const [busy, setBusy] = useState(false);
  const body = () => ({ text, ...(textEs.trim() ? { text_es: textEs } : {}), fields: fields.filter((f) => f.label.trim() || f.before.trim() || f.after.trim()) });
  const show = async (lang?: "en" | "es", travelerId = tid) => {
    setBusy(true);
    try {
      const q = new URLSearchParams({ preview: "1", ...(lang ? { lang } : {}), ...(travelerId ? { traveler_id: travelerId } : {}) });
      setPreview(await api<Preview>(`/groups/${groupId}/journey/change-notice?${q}`, "POST", body()));
    } catch (e) { toast({ variant: "destructive", title: "Could not show it", description: (e as Error).message }); }
    setBusy(false);
  };
  const send = async () => {
    const n = preview?.will_send;
    if (!window.confirm(`Send this notice${n !== undefined ? ` to ${n} traveler${n === 1 ? "" : "s"}` : ""} now? It also appears on each traveler's cruise page.`)) return;
    setBusy(true);
    try {
      const r = await api<{ sent: number; failed: number; already_sent: number }>(`/groups/${groupId}/journey/change-notice`, "POST", body());
      toast({ title: `Notice sent to ${r.sent}`, description: [r.failed ? `${r.failed} failed (send it again to retry them)` : "", r.already_sent ? `${r.already_sent} already had it` : ""].filter(Boolean).join(". ") || undefined });
      setText(""); setTextEs(""); setFields([]); setPreview(null); onSent();
    } catch (e) { toast({ variant: "destructive", title: "Not sent", description: (e as Error).message }); }
    setBusy(false);
  };
  const set = (i: number, k: keyof Field, v: string) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, [k]: v } : f)));
  return (
    <div className="px-4 py-3 border-t space-y-2">
      <h4 className="font-semibold text-sm">Change notice</h4>
      <p className="text-xs text-muted-foreground">For a real change (ship, dates, ports, deadlines). It goes to every booked traveler with an email address, in their language, and shows on their cruise page. Your words are sent as typed; a Spanish traveler is told they are in English unless you add a Spanish version.</p>
      <textarea className={`${input} w-full`} rows={3} placeholder="What changed, in your words" value={text} onChange={(e) => setText(e.target.value)} />
      <details>
        <summary className="text-xs cursor-pointer text-muted-foreground">Spanish version (optional)</summary>
        <textarea className={`${input} w-full mt-1`} rows={3} placeholder="Texto en español (opcional)" value={textEs} onChange={(e) => setTextEs(e.target.value)} />
      </details>
      <div className="space-y-1">
        {fields.map((f, i) => (
          <div key={i} className="flex gap-1 flex-wrap items-center">
            <input className={`${input} w-40`} placeholder="What changed" value={f.label} onChange={(e) => set(i, "label", e.target.value)} />
            <input className={`${input} w-48`} placeholder="Was" value={f.before} onChange={(e) => set(i, "before", e.target.value)} />
            <input className={`${input} w-48`} placeholder="Now" value={f.after} onChange={(e) => set(i, "after", e.target.value)} />
            <button className="text-muted-foreground hover:text-destructive" title="Remove this line" onClick={() => setFields(fields.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
        {fields.length < 12 && <button className={btn} onClick={() => setFields([...fields, { label: "", before: "", after: "" }])}><Plus className="w-3 h-3" /> Add a changed item (was / now)</button>}
      </div>
      <div className="flex gap-2 items-center flex-wrap">
        <select className={input} value={tid} onChange={(e) => { setTid(e.target.value); if (preview) show(preview.lang, e.target.value); }}>
          <option value="">Preview for: first booked traveler</option>
          {travelers.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.lang === "es" ? "Spanish" : "English"})</option>)}
        </select>
        <button className={btn} disabled={busy || !text.trim()} onClick={() => show()}><Eye className="w-3 h-3" /> Preview</button>
        <button className={btn} disabled={busy || !preview || !text.trim() || !data.link_key_set} onClick={send} title={preview ? "" : "Preview it first"}><Send className="w-3 h-3" /> Send to everyone booked</button>
      </div>
      {preview && <PreviewPanel p={preview} onLang={(l) => show(l)} onClose={() => setPreview(null)} />}
    </div>
  );
}

// ── The dry run (dev only) ───────────────────────────────────────────────────

function Simulate({ api, groupId, travelers, onDone }: { api: ApiFn; groupId: string; travelers: PlanTraveler[]; onDone: () => void }) {
  const { toast } = useToast();
  const [tid, setTid] = useState(travelers[0]?.id ?? "");
  const [to, setTo] = useState("");
  const [out, setOut] = useState<SimResult | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { setOut(await api<SimResult>(`/groups/${groupId}/journey/simulate`, "POST", { traveler_id: tid, to_email: to })); onDone(); }
    catch (e) { toast({ variant: "destructive", title: "The dry run did not run", description: (e as Error).message }); }
    setBusy(false);
  };
  const clear = async () => {
    try { const r = await api<{ removed: number }>(`/groups/${groupId}/journey/simulate`, "DELETE"); setOut(null); toast({ title: `Removed ${r.removed} simulated message${r.removed === 1 ? "" : "s"}` }); onDone(); }
    catch (e) { toast({ variant: "destructive", title: "Not removed", description: (e as Error).message }); }
  };
  return (
    <div className="px-4 py-3 border-t space-y-2 bg-amber-50/40">
      <h4 className="font-semibold text-sm flex items-center gap-2"><FlaskConical className="w-4 h-4" /> Run the whole journey now (test box only)</h4>
      <p className="text-xs text-muted-foreground">Writes every email for one traveler in order — booking confirmation, then 120, 90, 45, 20, 10, 5 and 2 days — each as it would read on its own day, and sends them to one test address, only if this box's test list names it. Nothing is sent to the traveler. These are logged as simulated and never stop a real send.</p>
      <div className="flex gap-2 flex-wrap items-center">
        <select className={input} value={tid} onChange={(e) => setTid(e.target.value)}>{travelers.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.lang === "es" ? "Spanish" : "English"})</option>)}</select>
        <input className={`${input} w-64`} type="email" placeholder="test address to send to" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className={btn} disabled={busy || !tid || !to} onClick={run}><FlaskConical className="w-3 h-3" /> Run the sequence</button>
        <button className={btn} onClick={clear}>Remove simulated messages</button>
      </div>
      {out && (
        <div className="text-sm">
          <p className="font-semibold">{out.sent} of {out.count} sent to {out.to_email}</p>
          <ol className="list-decimal pl-5 space-y-0.5">
            {out.messages.map((m) => (
              <li key={m.kind}><span className="font-medium">{m.subject}</span> <span className="text-xs text-muted-foreground">[{m.sections.join(", ")}]</span> <span className={m.status === "sent" ? "text-green-700" : m.status === "failed" ? "text-red-700" : "text-amber-700"}>{m.status}{m.reason ? `: ${m.reason}` : ""}</span></li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// ── The card ──────────────────────────────────────────────────────────────────

export function GroupJourney({ api, groupId }: { api: ApiFn; groupId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<JourneyData>({ queryKey: ["group-journey", groupId], queryFn: () => api(`/groups/${groupId}/journey`) });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [asDefault, setAsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showMatrix, setShowMatrix] = useState(false);
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["group-journey", groupId] });

  const show = async (m: Milestone, lang?: "en" | "es", travelerId?: string) => {
    setBusy(true);
    try {
      const who = travelerId ?? m.sampleTravelerId;
      const q = new URLSearchParams({ ...(lang ? { lang } : {}), ...(who ? { traveler_id: who } : {}) });
      setPreview(await api<Preview>(`/groups/${groupId}/journey/preview/${m.kind}?${q}`));
    } catch (e) { toast({ variant: "destructive", title: "No preview", description: (e as Error).message }); }
    setBusy(false);
  };
  const makeLink = async (t: PlanTraveler) => {
    try { const r = await api<{ url: string }>(`/groups/${groupId}/travelers/${t.id}/cruise-link`, "POST", {}); setLink({ name: t.name, url: r.url }); }
    catch (e) { toast({ variant: "destructive", title: "Could not make the link", description: (e as Error).message }); }
  };
  const approve = async (kinds: string[], approved: boolean | null) => {
    setBusy(true);
    try {
      await api(`/groups/${groupId}/journey/approve`, "PUT", { kinds, approved, as_default: asDefault });
      toast({ title: approved === null ? "Following the site default again" : approved ? (kinds.length > 1 ? "All approved" : "Approved") : "Approval withdrawn", description: approved === null ? undefined : asDefault ? "For every group that has not decided otherwise." : "For this group." });
      refresh();
    } catch (e) { toast({ variant: "destructive", title: "Not saved", description: (e as Error).message }); }
    setBusy(false);
  };

  if (isLoading) return <Card><p className="px-4 py-4 text-sm text-muted-foreground">Loading the journey…</p></Card>;
  if (error || !data) return <Card><p className="px-4 py-4 text-sm text-destructive">Could not load the journey: {(error as Error)?.message}</p></Card>;

  const approvable = data.milestones.filter((m) => m.kind !== "change-notice");
  const allApproved = approvable.every((m) => m.approval.approved);

  return (
    <Card>
      <div className="px-4 py-3 border-b space-y-1">
        <h3 className="font-semibold flex items-center gap-2"><Route className="w-4 h-4" /> Journey: the emails after the paperwork</h3>
        <p className="text-xs text-muted-foreground">The booking confirmation, then messages 120, 90, 45, 20, 10, 5 and 2 days before sailing, payment notices and a nudge for missing details, each in the traveler's language and each linking to their private cruise page. Preview one, approve it once, and the daily job sends it. Nothing goes out unapproved. Videos come from your own channel only.</p>
        {!data.live && <p className="text-xs text-amber-700">Nothing is sent for this group right now: {data.live_reason}</p>}
        {!data.link_key_set && <p className="text-xs text-red-700">This box has no link key (GROUP_LINK_KEY or GROUP_PII_KEY), so no journey email can carry a working link and none is sent.</p>}
        <p className="text-xs text-muted-foreground">{data.test_list_set ? "This box has a test list: only the addresses on it are emailed." : "This box has no test list: a traveler's own address is emailed."} Wording version {data.template_version}.</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30">
              {["Message", "Goes out", "Travelers", "Approval", ""].map((h) => <th key={h} className="text-left px-3 py-2 font-semibold text-muted-foreground whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.milestones.map((m) => {
              const c = m.counts;
              const isNotice = m.kind === "change-notice";
              return (
                <tr key={m.kind} className="hover:bg-muted/20 align-top">
                  <td className="px-3 py-2">{m.label}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{m.date ? fmtDate(m.date) : isNotice ? "when you send it" : m.kind === "confirmation" ? "when a booking number appears" : m.kind === "payment-due" ? "14 and 3 days before a date" : "7 days after a request"}</td>
                  <td className="px-3 py-2 text-xs">
                    {isNotice ? "—" : [
                      c.sent ? `${c.sent} sent` : "", c.due ? `${c.due} due${c.blocked ? ` (${c.blocked} waiting on approval)` : ""}` : "", c.planned ? `${c.planned} planned` : "",
                      c.failed ? `${c.failed} failed` : "", c.skipped ? `${c.skipped} skipped` : "",
                    ].filter(Boolean).join(" · ") || "no one yet"}
                  </td>
                  <td className="px-3 py-2">{isNotice ? <span className="text-xs text-muted-foreground">sending it is the approval</span> : approvalChip(m.approval)}</td>
                  <td className="px-3 py-2">
                    {!isNotice && (
                      <div className="flex gap-1 justify-end">
                        <button className={btn} disabled={busy} onClick={() => show(m)}><Eye className="w-3 h-3" /> Preview</button>
                        {m.approval.approved
                          ? <button className={btn} disabled={busy} onClick={() => approve([m.kind], false)}>Withdraw</button>
                          : <button className={btn} disabled={busy} onClick={() => approve([m.kind], true)}><Check className="w-3 h-3" /> Approve</button>}
                        {m.approval.source === "group" && <button className={btn} disabled={busy} onClick={() => approve([m.kind], null)} title="Drop this group's own decision and follow the site default">Use default</button>}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 border-t flex items-center gap-3 flex-wrap text-sm">
        <button className={btn} disabled={busy || allApproved} onClick={() => approve(approvable.map((m) => m.kind), true)}><Check className="w-3 h-3" /> Approve all</button>
        <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={asDefault} onChange={(e) => setAsDefault(e.target.checked)} /> Also make this the default for every group that has not decided</label>
        <button className={`${btn} ml-auto`} onClick={() => setShowMatrix(!showMatrix)}>{showMatrix ? "Hide" : "Show"} each traveler</button>
      </div>

      {showMatrix && (
        <div className="overflow-x-auto border-t">
          {link && (
            <div className="m-3 p-2 border rounded bg-muted/30 space-y-1 text-xs">
              <div className="font-semibold">Cruise page link for {link.name} (the same link every time; it also opens their paperwork)</div>
              <div className="flex gap-1">
                <input readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} className="flex-1 min-w-0 px-2 py-1 rounded border bg-card" aria-label="Cruise page link" />
                <button className={btn} onClick={async () => { try { await navigator.clipboard.writeText(link.url); toast({ title: "Link copied" }); } catch { toast({ variant: "destructive", title: "Select the link and copy it" }); } }}><Copy className="w-3 h-3" /> Copy</button>
              </div>
            </div>
          )}
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Traveler</th>
                {MATRIX.map((k) => <th key={k} className="px-2 py-2 font-semibold text-muted-foreground">{SHORT[k]}</th>)}
                <th className="px-2 py-2 font-semibold text-muted-foreground">Pay / nudge</th>
                <th className="px-2 py-2 font-semibold text-muted-foreground">Cruise page</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.travelers.map((t) => (
                <tr key={t.id}>
                  <td className="px-3 py-1.5 whitespace-nowrap">{t.name} <span className="text-muted-foreground">{t.lang === "es" ? "ES" : "EN"}{t.has_email ? "" : ", no email"}</span></td>
                  {MATRIX.map((k) => {
                    const i = t.items.find((x) => x.kind === k);
                    return <td key={k} className="px-1 py-1 text-center">{i ? <Badge variant="outline" className={`${STATUS_CLS[i.status] ?? ""} text-[10px] px-1`} title={[i.date ? fmtDate(i.date) : "", i.reason ?? "", i.blocked ?? ""].filter(Boolean).join(" · ")}>{i.status}</Badge> : ""}</td>;
                  })}
                  <td className="px-2 py-1 text-center whitespace-nowrap">
                    {t.items.filter((x) => x.kind === "payment-due" || x.kind === "data-needed").map((x, n) => <Badge key={n} variant="outline" className={`${STATUS_CLS[x.status] ?? ""} text-[10px] px-1 mr-0.5`} title={[x.kind, x.date ? fmtDate(x.date) : "", x.reason ?? ""].filter(Boolean).join(" · ")}>{SHORT[x.kind]} {x.status}</Badge>)}
                  </td>
                  <td className="px-2 py-1 text-center"><button className={btn} onClick={() => makeLink(t)} title="Make the traveler's private cruise page link"><Link2 className="w-3 h-3" /> Link</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview && <PreviewPanel p={preview} onLang={(l) => { const m = data.milestones.find((x) => x.kind === preview.kind); if (m) show(m, l, preview.traveler.id); }} onClose={() => setPreview(null)} />}

      <ChangeNotice api={api} groupId={groupId} travelers={data.travelers} data={data} onSent={refresh} />
      {data.sim_enabled && <Simulate api={api} groupId={groupId} travelers={data.travelers} onDone={refresh} />}

      {data.told.length > 0 && (
        <div className="px-4 py-3 border-t">
          <h4 className="font-semibold text-sm mb-1">What travelers told us on their cruise page</h4>
          <ul className="text-sm space-y-0.5">
            {data.told.map((t) => <li key={t.traveler_id}><span className="font-medium">{t.name}:</span> <span className="text-muted-foreground">{Object.entries(t.answers).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(" · ")}</span></li>)}
          </ul>
        </div>
      )}

      <div className="border-t">
        <div className="px-4 py-2 text-sm font-semibold">Recent journey emails <span className="text-muted-foreground font-normal">({data.messages.length})</span></div>
        <div className="divide-y divide-border max-h-72 overflow-y-auto">
          {data.messages.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">None yet.</p>}
          {data.messages.map((m) => (
            <div key={m.id} className="px-4 py-1.5 flex items-center justify-between gap-3 text-sm">
              <span>{m.subject || m.template}{m.sim ? <Badge variant="outline" className="ml-2 text-[10px]">simulated</Badge> : null} <span className="text-muted-foreground">→ {m.traveler ?? "everyone"}{m.to_email ? ` (${m.to_email})` : ""}</span></span>
              <span className={`whitespace-nowrap ${m.status === "failed" ? "text-red-700" : "text-muted-foreground"}`} title={m.error ?? ""}>{m.status}{m.sent_at ? ` · ${when(m.sent_at)}` : ""}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
