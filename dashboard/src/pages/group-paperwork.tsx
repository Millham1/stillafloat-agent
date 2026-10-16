import React, { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Copy, Mail, Link2, ExternalLink, Trash2, FileSignature } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Client paperwork (migrations 0044 and 0052): each traveler signs their documents on their own private
// link, the organizer signs the group contract, and a signed PDF of every document is kept privately.
// This is Mark's side of it: make or email a link, see who has signed what, open a signed copy, and
// enter a fee when (and only when) he wants one on the documents. The page the traveler sees is
// server/public/forms.html; the rules are in server/src/lib/group-forms.ts.

type Row = Record<string, any>;
export type ApiFn = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export type PacketStatus = { required: string[]; signed: string[]; complete: boolean };
export type PaperworkData = {
  signatures: Row[];
  packets: Record<string, PacketStatus>;
  organizer: PacketStatus & { link_sent_at: string | null };
};

const when = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

const btn = "text-xs px-2 py-1 rounded border bg-card hover:bg-muted/40 disabled:opacity-50 inline-flex items-center gap-1 whitespace-nowrap";

/** Select-and-copy fallback for browsers that refuse the clipboard API. */
async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return; } catch { /* fall through */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
}

// ── One traveler's row: status chip and the two link buttons ─────────────────

function LinkBox({ url, blanks }: { url: string; blanks?: string[] }) {
  const { toast } = useToast();
  return (
    <div className="mt-1 p-2 border rounded bg-muted/30 space-y-1 text-xs min-w-[16rem]">
      <div className="flex gap-1">
        <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="flex-1 min-w-0 px-2 py-1 rounded border bg-card" aria-label="Private link" />
        <button className={btn} onClick={async () => { await copyText(url); toast({ title: "Link copied" }); }}><Copy className="w-3 h-3" /> Copy</button>
      </div>
      <p className="text-muted-foreground">Shown once. Making another link replaces this one.</p>
      {blanks && blanks.length > 0 && (
        <p className="text-amber-700">These lines of the contract are blank because the file does not hold them: {blanks.join(", ")}.</p>
      )}
    </div>
  );
}

export function TravelerPaperwork({ api, groupId, row, status, onChanged }: { api: ApiFn; groupId: string; row: Row; status: PacketStatus | undefined; onChanged: () => void }) {
  const { toast } = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signed = status?.signed.length ?? 0;
  const total = status?.required.length ?? 0;

  const chip = row.form_submitted_at
    ? { text: `Returned · ${signed} of ${total}`, cls: "bg-green-100 text-green-800 border-green-200" }
    : signed > 0
      ? { text: `${signed} of ${total} signed`, cls: "bg-amber-100 text-amber-800 border-amber-200" }
      : row.form_sent_at
        ? { text: total ? `Sent · 0 of ${total}` : "Sent", cls: "bg-blue-100 text-blue-800 border-blue-200" }
        : { text: "Not sent", cls: "bg-slate-100 text-slate-700 border-slate-200" };

  const run = async (fn: () => Promise<void>, failTitle: string) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast({ variant: "destructive", title: failTitle, description: (e as Error).message }); }
    setBusy(false);
    onChanged();
  };
  const makeLink = () => run(async () => {
    const r = await api<{ url: string }>(`/groups/${groupId}/travelers/${row.id}/form-link`, "POST", {});
    setUrl(r.url);
    toast({ title: "Link made", description: "Copy it now: it is shown only this once." });
  }, "Could not make the link");
  const emailLink = () => {
    if (!window.confirm(`Email a new paperwork link to ${row.email}? Any earlier link for this traveler stops working.`)) return;
    return run(async () => {
      const r = await api<{ sentTo: string }>(`/groups/${groupId}/travelers/${row.id}/form-link/send`, "POST", {});
      setUrl(null);
      toast({ title: "Link emailed", description: `Sent to ${r.sentTo}` });
    }, "The email did not go out");
  };

  return (
    <div className="px-2 py-1 space-y-1">
      <Badge variant="outline" className={chip.cls}>{chip.text}</Badge>
      <div className="flex gap-1 flex-wrap">
        <button className={btn} disabled={busy} onClick={makeLink}><Link2 className="w-3 h-3" /> Form link</button>
        <button className={btn} disabled={busy || !row.email} onClick={emailLink} title={row.email ? `Email the link to ${row.email}` : "Add an email address to this traveler first"}><Mail className="w-3 h-3" /> Email link</button>
      </div>
      {url && <LinkBox url={url} />}
    </div>
  );
}

// ── The paperwork card ───────────────────────────────────────────────────────

const FEE_KINDS: Array<{ key: string; label: string }> = [
  { key: "planning_fee", label: "Planning fee" },
  { key: "service_fee", label: "Service fee" },
  { key: "booking_fee", label: "Booking fee" },
  { key: "change_fee", label: "Change / rebooking fee" },
  { key: "cancellation_fee", label: "Cancellation / processing fee" },
  { key: "substitution_fee", label: "Substitution fee" },
  { key: "retainer_fee", label: "Group organizer retainer fee" },
];

function Fees({ api, groupId, fees, onChanged }: { api: ApiFn; groupId: string; fees: Row; onChanged: () => void }) {
  const { toast } = useToast();
  const [key, setKey] = useState(FEE_KINDS[0]!.key);
  const [amount, setAmount] = useState("");
  const [per, setPer] = useState("");
  const entries = Object.entries(fees ?? {}).filter(([, v]) => Number(typeof v === "object" && v ? (v as Row).amount : v) > 0);
  const save = async (next: Row) => {
    try { await api(`/groups/${groupId}`, "PATCH", { fees: next }); onChanged(); }
    catch (e) { toast({ variant: "destructive", title: "Not saved", description: (e as Error).message }); }
  };
  const label = (k: string) => FEE_KINDS.find((f) => f.key === k)?.label ?? k;
  return (
    <div className="px-4 py-3 border-b space-y-2">
      <p className="text-sm">
        <span className="font-semibold">Fees on this file:</span>{" "}
        {entries.length === 0
          ? <span className="text-muted-foreground">none. Travelers are not asked to sign the planning or service fee agreements, and no fee appears on their documents.</span>
          : <span className="text-muted-foreground">entered by you. The planning and service fee agreements are added to every traveler's paperwork, and these amounts print on the documents.</span>}
      </p>
      {entries.length > 0 && (
        <ul className="text-sm space-y-1">
          {entries.map(([k, v]) => {
            const o = typeof v === "object" && v ? (v as Row) : { amount: v };
            return (
              <li key={k} className="flex items-center gap-2">
                <span>{label(k)}: ${Number(o.amount).toLocaleString("en-US")}{o.per ? ` ${o.per}` : ""}</span>
                <button className="text-muted-foreground hover:text-destructive" title="Remove this fee" onClick={() => { if (window.confirm(`Remove the ${label(k).toLowerCase()}?`)) { const next = { ...fees }; delete next[k]; save(next); } }}><Trash2 className="w-3.5 h-3.5" /></button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select value={key} onChange={(e) => setKey(e.target.value)} className="px-2 py-1 rounded border bg-card">{FEE_KINDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
        <input type="number" min="0" step="0.01" placeholder="Amount ($)" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-28 px-2 py-1 rounded border bg-card" />
        <input placeholder="per … (optional)" value={per} onChange={(e) => setPer(e.target.value)} className="w-40 px-2 py-1 rounded border bg-card" />
        <button className={btn} disabled={!(Number(amount) > 0)} onClick={() => { save({ ...fees, [key]: { amount: Number(amount), ...(per.trim() ? { per: per.trim() } : {}) } }); setAmount(""); setPer(""); }}>Add fee</button>
      </div>
    </div>
  );
}

export function ClientPaperwork({ api, groupId, group, data, onChanged }: { api: ApiFn; groupId: string; group: Row; data: PaperworkData | undefined; onChanged: () => void }) {
  const { toast } = useToast();
  const [orgUrl, setOrgUrl] = useState<{ url: string; blanks: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const org = data?.organizer;
  const signatures = data?.signatures ?? [];

  const makeOrganizerLink = async () => {
    setBusy(true);
    try {
      const r = await api<{ url: string; blanks: string[] }>(`/groups/${groupId}/organizer-link`, "POST", {});
      setOrgUrl({ url: r.url, blanks: r.blanks ?? [] });
      toast({ title: "Organizer link made", description: "Copy it now: it is shown only this once." });
      onChanged();
    } catch (e) { toast({ variant: "destructive", title: "Could not make the link", description: (e as Error).message }); }
    setBusy(false);
  };

  const signedUrl = async (sid: string) => (await api<{ url: string }>(`/groups/${groupId}/signatures/${sid}/file`)).url;
  const open = async (sid: string) => {
    const w = window.open("", "_blank"); // opened first so the browser does not treat it as a pop-up
    try { const url = await signedUrl(sid); if (w) w.location.href = url; else window.location.href = url; }
    catch (e) { w?.close(); toast({ variant: "destructive", title: "Could not open the signed copy", description: (e as Error).message }); }
  };
  const copyLink = async (sid: string) => {
    try { await copyText(await signedUrl(sid)); toast({ title: "Link copied", description: "It opens the signed PDF for the next 10 minutes." }); }
    catch (e) { toast({ variant: "destructive", title: "Could not make the link", description: (e as Error).message }); }
  };
  const remove = async (s: Row) => {
    if (!window.confirm(`Remove ${s.signer_name}'s signature on "${s.doc_title}"? Use this only for a mistake: they will be asked to sign it again.`)) return;
    try { await api(`/groups/${groupId}/signatures/${s.id}`, "DELETE"); onChanged(); }
    catch (e) { toast({ variant: "destructive", title: "Not removed", description: (e as Error).message }); }
  };

  const orgState = org?.complete ? `Signed ${when(data!.signatures.find((s) => s.signer_role === "organizer")?.signed_at)}` : org?.link_sent_at ? `Link made ${when(org.link_sent_at)}` : "No link yet";

  return (
    <Card>
      <div className="px-4 py-3 border-b">
        <h3 className="font-semibold flex items-center gap-2"><FileSignature className="w-4 h-4" /> Client paperwork, signed online <span className="text-muted-foreground font-normal">({signatures.length})</span></h3>
        <p className="text-xs text-muted-foreground mt-0.5">Each traveler signs on their own private link (use the buttons in the Travelers table). A signed PDF of every document is kept privately; the link to open one works for 10 minutes.</p>
      </div>
      <Fees api={api} groupId={groupId} fees={group.fees ?? {}} onChanged={onChanged} />
      <div className="px-4 py-3 border-b space-y-1">
        <div className="flex items-center gap-3 flex-wrap text-sm">
          <span className="font-semibold">Group contract (organizer{group.organizer_name ? `: ${group.organizer_name}` : ""})</span>
          <span className={org?.complete ? "text-green-700" : "text-muted-foreground"}>{orgState}</span>
          {org?.complete && <span className="text-amber-700">Your countersignature is still to do.</span>}
          <button className={btn} disabled={busy || !group.organizer_name} title={group.organizer_name ? "" : "Add the organizer's name to the group first"} onClick={makeOrganizerLink}><Link2 className="w-3 h-3" /> Organizer link</button>
        </div>
        {orgUrl && <LinkBox url={orgUrl.url} blanks={orgUrl.blanks} />}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30">
              {["Document", "Signed by", "Signing as", "When", "Choice", ""].map((h) => <th key={h} className="text-left px-3 py-2 font-semibold text-muted-foreground whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {signatures.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">Nothing signed yet.</td></tr>}
            {signatures.map((s) => (
              <tr key={s.id} className="hover:bg-muted/20">
                <td className="px-3 py-2">{s.doc_title}</td>
                <td className="px-3 py-2">{s.signer_name}</td>
                <td className="px-3 py-2">{s.signer_role}</td>
                <td className="px-3 py-2 whitespace-nowrap">{when(s.signed_at)}</td>
                <td className="px-3 py-2">{s.choice === "quote" ? "Wants an Allianz quote" : s.choice === "decline" ? "Declined insurance" : ""}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-1 justify-end">
                    {s.has_pdf
                      ? <>
                        <button className={btn} onClick={() => open(s.id)}><ExternalLink className="w-3 h-3" /> Open</button>
                        <button className={btn} onClick={() => copyLink(s.id)}><Copy className="w-3 h-3" /> Copy link</button>
                      </>
                      : <span className="text-xs text-amber-700 self-center" title="The signature is recorded; its PDF copy could not be saved.">no PDF copy</span>}
                    <button className="text-muted-foreground hover:text-destructive px-1" title="Remove this signature (a mistake)" onClick={() => remove(s)}><Trash2 className="w-4 h-4" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
