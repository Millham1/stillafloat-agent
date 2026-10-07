import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Megaphone, Loader2, CheckCircle2, AlertTriangle, ExternalLink, Copy, Users } from "lucide-react";
import { authHeaders, getStoredToken } from "@/lib/auth-token";
import { useToast } from "@/hooks/use-toast";

// Marketing for one group file: Mark's interview → written copy (per language)
// → his edits → preview → approve (the group page goes live) → replies.
// Facts (dates, prices, ports, perks) are never typed here: the page reads them
// from the group file, so the words can never contradict the booking.

type Row = Record<string, any>;
type Question = { key: string; label: string; hint?: string; type: "text" | "long" | "yesno" | "choice"; choices?: Array<{ value: string; label: string }> };
type Field = { key: string; label: string; max: number; long?: boolean; optional?: boolean };
type Problem = { field: string; problem: string };
type Marketing = {
  interview: Question[]; answers: Row; missing: string[]; copyFields: Field[]; langs: Array<"en" | "es">;
  perLang: Record<string, { facts: Row; copy: Row | null; problems: Problem[] }>;
  shareCode: string | null; approvedAt: string | null; writtenAt: string | null;
};

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...authHeaders() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error("This browser's access token was not accepted. Open the sign-in link again.");
  if (!r.ok) throw Object.assign(new Error(json?.error || `Request failed (${r.status})`), { problems: json?.problems });
  return json as T;
}

const LANG_NAME = { en: "English", es: "Spanish" } as const;
const input = "mt-1 w-full px-3 py-2 text-base rounded-md border bg-card text-foreground";

/** The public site's address. The dashboard calls the API on the main site, so its origin is the page origin. */
function siteOrigin(): string {
  const base = (import.meta.env.VITE_API_BASE_URL as string | undefined) || window.location.origin;
  return base.replace(/\/+$/, "");
}

export function GroupMarketing({ groupId }: { groupId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, error } = useQuery<Marketing>({ queryKey: ["group-marketing", groupId], queryFn: () => api(`/groups/${groupId}/marketing`) });
  const { data: replies } = useQuery<{ interests: Row[] }>({ queryKey: ["group-interests", groupId], queryFn: () => api(`/groups/${groupId}/interests`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["group-marketing", groupId] }); qc.invalidateQueries({ queryKey: ["group"] }); };

  const [answers, setAnswers] = useState<Row>({});
  const [lang, setLang] = useState<"en" | "es">("en");
  const [draft, setDraft] = useState<Row>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);

  useEffect(() => { if (data) setAnswers(data.answers); }, [data?.answers]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (data && !data.langs.includes(lang)) setLang(data.langs[0]!); }, [data?.langs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const pl = data?.perLang[lang];
    setDraft(pl?.copy ?? {});
    setProblems(pl?.problems ?? []);
  }, [data, lang]);

  if (isLoading) return <Card className="p-4"><p className="text-muted-foreground">Loading marketing…</p></Card>;
  if (error || !data) return <Card className="p-4"><p className="text-destructive">Could not load marketing: {(error as Error)?.message}</p></Card>;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try { await fn(); }
    catch (e) {
      const ps = (e as { problems?: Problem[] }).problems;
      if (ps) setProblems(ps);
      toast({ variant: "destructive", title: "Not done", description: (e as Error).message });
    } finally { setBusy(null); }
  };

  const saveAnswers = () => run("answers", async () => {
    await api(`/groups/${groupId}/marketing/answers`, "PUT", answers);
    toast({ title: "Interview saved" });
    refresh();
  });
  const write = () => run("write", async () => {
    await api(`/groups/${groupId}/marketing/answers`, "PUT", answers);
    const r = await api<{ copy: Row; problems: Problem[] }>(`/groups/${groupId}/marketing/write`, "POST", { lang });
    setDraft(r.copy); setProblems(r.problems);
    toast({ title: r.problems.length ? `Written, with ${r.problems.length} thing(s) to fix` : `${LANG_NAME[lang]} copy written`, description: "Read it through, edit anything, then approve." });
    refresh();
  });
  const saveCopy = () => run("copy", async () => {
    const r = await api<{ problems: Problem[] }>(`/groups/${groupId}/marketing/copy`, "PUT", { lang, copy: draft });
    setProblems(r.problems);
    toast({ title: r.problems.length ? `Saved, with ${r.problems.length} thing(s) to fix` : "Copy saved" });
    refresh();
  });
  const approve = (approved: boolean) => run("approve", async () => {
    await api(`/groups/${groupId}/marketing/copy`, "PUT", { lang, copy: draft });
    await api(`/groups/${groupId}/marketing/approve`, "POST", { approved });
    toast({ title: approved ? "Approved — the group page is live" : "The group page is taken down" });
    refresh();
  });
  const preview = () => run("preview", async () => {
    const r = await api<{ shareCode: string }>(`/groups/${groupId}/marketing/share-code`, "POST", {});
    const path = lang === "es" ? "/es/group.html" : "/group.html";
    window.open(`${siteOrigin()}${path}?g=${r.shareCode}#preview=${encodeURIComponent(getStoredToken())}`, "_blank", "noopener");
    refresh();
  });

  const shareUrl = (l: "en" | "es") => data.shareCode ? `${siteOrigin()}${l === "es" ? "/es/group.html" : "/group.html"}?g=${data.shareCode}` : "";
  const copyText = async (text: string, what: string) => { await navigator.clipboard.writeText(text); toast({ title: `${what} copied` }); };
  const facts = data.perLang[lang]?.facts ?? {};
  const fieldProblems = (k: string) => problems.filter((p) => p.field === k);
  const live = !!data.approvedAt;

  return (
    <Card>
      <div className="px-4 py-3 border-b flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2"><Megaphone className="w-4 h-4" /><h3 className="font-semibold">Marketing</h3></div>
        {live
          ? <span className="flex items-center gap-1.5 text-sm text-green-500"><CheckCircle2 className="w-4 h-4" /> Group page is live</span>
          : <span className="text-sm text-muted-foreground">Not published</span>}
      </div>
      <CardContent className="p-4 space-y-8">

        {/* 1. Interview */}
        <div>
          <h4 className="text-lg font-semibold">1. Tell me about the group</h4>
          <p className="text-sm text-muted-foreground mb-3">Only what the contract cannot say. Ship, dates, ports, perks and prices come from the group file.</p>
          <div className="grid md:grid-cols-2 gap-4">
            {data.interview.map((q) => (
              <label key={q.key} className={`text-sm ${q.type === "long" ? "md:col-span-2" : ""}`}>
                <span className="font-medium">{q.label}</span>{data.missing.includes(q.key) && !answers[q.key] && <span className="text-amber-600"> · needed</span>}
                {q.hint && <span className="block text-muted-foreground text-xs mt-0.5">{q.hint}</span>}
                {q.type === "text" && <input className={input} value={answers[q.key] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })} />}
                {q.type === "long" && <textarea className={input} rows={3} value={answers[q.key] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })} />}
                {q.type === "yesno" && (
                  <select className={input} value={answers[q.key] ? "yes" : "no"} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value === "yes" })}>
                    <option value="yes">Yes</option><option value="no">No</option>
                  </select>
                )}
                {q.type === "choice" && (
                  <select className={input} value={answers[q.key] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })}>
                    {q.choices!.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                )}
              </label>
            ))}
          </div>
          <button onClick={saveAnswers} disabled={!!busy} className="mt-3 text-sm px-4 py-1.5 rounded-md border bg-card disabled:opacity-50">Save answers</button>
        </div>

        {/* 2. Copy */}
        <div>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h4 className="text-lg font-semibold">2. The words</h4>
            {data.langs.length > 1 && (
              <div className="flex rounded-md border overflow-hidden">
                {data.langs.map((l) => (
                  <button key={l} onClick={() => setLang(l)} className={`px-4 py-1.5 text-sm ${lang === l ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground"}`}>{LANG_NAME[l]}</button>
                ))}
              </div>
            )}
          </div>
          <p className="text-sm text-muted-foreground mb-3">
            Written from your answers and the group file{facts.ship ? ` (${facts.ship}${facts.sailDateText ? ", " + facts.sailDateText : ""})` : ""}.
            Every number is checked against the file, and hype words are refused. Writing uses the AI box; Claude is only the backup.
          </p>
          <div className="flex gap-2 flex-wrap mb-4">
            <button onClick={write} disabled={!!busy} className="flex items-center gap-1.5 text-sm px-4 py-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-50">
              {busy === "write" && <Loader2 className="w-4 h-4 animate-spin" />}
              {data.perLang[lang]?.copy ? `Rewrite the ${LANG_NAME[lang]} copy` : `Write the ${LANG_NAME[lang]} copy`}
            </button>
            {busy === "write" && <span className="text-sm text-muted-foreground self-center">This takes a minute or two.</span>}
          </div>

          {Object.keys(draft).length > 0 && (
            <div className="space-y-4">
              {problems.length > 0 && (
                <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                  <div className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="w-4 h-4 text-amber-500" /> Fix these before approving</div>
                  <ul className="list-disc pl-5 mt-1">{problems.map((p, i) => <li key={i}>{data.copyFields.find((f) => f.key === p.field)?.label ?? p.field}: {p.problem}</li>)}</ul>
                </div>
              )}
              {data.copyFields.map((f) => (
                <label key={f.key} className="block text-sm">
                  <span className="font-medium">{f.label}</span>
                  <span className="text-muted-foreground"> · {(draft[f.key] ?? "").length} / {f.max}{f.optional ? " · optional" : ""}</span>
                  {f.long
                    ? <textarea className={`${input} ${fieldProblems(f.key).length ? "border-amber-500" : ""}`} rows={f.key === "email_body" ? 9 : 4} value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
                    : <input className={`${input} ${fieldProblems(f.key).length ? "border-amber-500" : ""}`} value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />}
                  {fieldProblems(f.key).map((p, i) => <span key={i} className="block text-amber-600 text-xs mt-1">{p.problem}</span>)}
                </label>
              ))}
              <div className="flex gap-2 flex-wrap">
                <button onClick={saveCopy} disabled={!!busy} className="text-sm px-4 py-1.5 rounded-md border bg-card disabled:opacity-50">Save my edits</button>
                <button onClick={preview} disabled={!!busy} className="flex items-center gap-1.5 text-sm px-4 py-1.5 rounded-md border bg-card disabled:opacity-50"><ExternalLink className="w-4 h-4" /> Preview the group page</button>
              </div>
            </div>
          )}
        </div>

        {/* 3. Publish */}
        <div>
          <h4 className="text-lg font-semibold">3. Publish and share</h4>
          <p className="text-sm text-muted-foreground mb-3">
            Approving puts the page live at a private link (never listed on the site, never in search). Rewriting the copy takes it down until you approve again.
            {data.langs.length > 1 ? " Both languages must be written and clean." : ""}
          </p>
          <div className="flex gap-2 flex-wrap">
            {!live
              ? <button onClick={() => approve(true)} disabled={!!busy || Object.keys(draft).length === 0} className="text-sm px-4 py-1.5 rounded-md bg-green-600 text-white disabled:opacity-50">Approve and publish</button>
              : <button onClick={() => approve(false)} disabled={!!busy} className="text-sm px-4 py-1.5 rounded-md border bg-card disabled:opacity-50">Take the page down</button>}
          </div>
          {live && data.shareCode && (
            <div className="mt-4 space-y-3 text-sm">
              {data.langs.map((l) => (
                <div key={l} className="flex items-center gap-2 flex-wrap">
                  <span className="w-20 text-muted-foreground">{LANG_NAME[l]}</span>
                  <a className="underline break-all" href={shareUrl(l)} target="_blank" rel="noopener noreferrer">{shareUrl(l)}</a>
                  <button onClick={() => copyText(shareUrl(l), "Link")} className="flex items-center gap-1 px-2 py-1 rounded border"><Copy className="w-3.5 h-3.5" /> Copy</button>
                </div>
              ))}
              {data.langs.map((l) => {
                const c = data.perLang[l]?.copy;
                if (!c) return null;
                const email = `${c.email_subject}\n\n${c.email_body}\n\n${shareUrl(l)}`;
                const post = `${c.social_post}\n\n${shareUrl(l)}`;
                return (
                  <div key={`share-${l}`} className="flex gap-2 flex-wrap">
                    <button onClick={() => copyText(email, `${LANG_NAME[l]} invitation email`)} className="flex items-center gap-1 px-3 py-1.5 rounded border"><Copy className="w-3.5 h-3.5" /> Copy the {LANG_NAME[l]} invitation email</button>
                    <button onClick={() => copyText(post, `${LANG_NAME[l]} post`)} className="flex items-center gap-1 px-3 py-1.5 rounded border"><Copy className="w-3.5 h-3.5" /> Copy the {LANG_NAME[l]} post</button>
                  </div>
                );
              })}
              <p className="text-muted-foreground">Send the email from your own mailbox, or give the organizer the post for the group's Facebook or chat. Nothing is sent automatically.</p>
            </div>
          )}
        </div>

        {/* 4. Replies */}
        <div>
          <h4 className="text-lg font-semibold flex items-center gap-2"><Users className="w-4 h-4" /> Replies from the page ({replies?.interests.length ?? 0})</h4>
          <p className="text-sm text-muted-foreground mb-3">Each reply also lands in your website contact list and pings your phone. Aim to answer within a few hours.</p>
          {(replies?.interests.length ?? 0) === 0
            ? <p className="text-sm text-muted-foreground">No replies yet.</p>
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b bg-muted/30 text-muted-foreground"><th className="text-left px-2 py-2">Name</th><th className="text-left px-2 py-2">Contact</th><th className="text-left px-2 py-2">Cabin · guests</th><th className="text-left px-2 py-2">Note</th><th className="text-left px-2 py-2">When</th><th className="text-left px-2 py-2">Status</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {replies!.interests.map((r) => (
                      <tr key={r.id}>
                        <td className="px-2 py-2">{r.first_name} {r.last_name}{r.lang === "es" ? " · ES" : ""}</td>
                        <td className="px-2 py-2"><a className="underline" href={`mailto:${r.email}`}>{r.email}</a>{r.phone ? <div>{r.phone}</div> : null}</td>
                        <td className="px-2 py-2">{r.cabin_type || "—"} · {r.guests ?? "—"}</td>
                        <td className="px-2 py-2 max-w-xs">{r.note || ""}{r.newsletter_opt_in ? <div className="text-muted-foreground">Wants the newsletter</div> : null}</td>
                        <td className="px-2 py-2 whitespace-nowrap">{new Date(r.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                        <td className="px-2 py-2">
                          <select className="px-2 py-1 rounded border bg-card" value={r.status}
                            onChange={async (e) => { await api(`/groups/${groupId}/interests/${r.id}`, "PATCH", { status: e.target.value }); qc.invalidateQueries({ queryKey: ["group-interests", groupId] }); }}>
                            {["new", "contacted", "booked", "declined", "spam"].map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </CardContent>
    </Card>
  );
}
