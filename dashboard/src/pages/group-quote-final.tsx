import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Send, Trash2, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/group-api";
import { useToast } from "@/hooks/use-toast";

// Quotes to finalize (Mark 2026-11-05: "the price they see is the unqualified price and doesnt account for extras or upgrades, so they need to
// commit to the updated quote. that means it should come to me first"). The guest sent their choices; Mark prices what the group file could not,
// adds the extras and upgrades, and sends the final quote. Only that one can be agreed. Rules: server/src/routes/group-details.ts.

type Guest = { id: string; name: string; category: string | null; party: number | null; state: "finalize" | "sent" | "agreed"; requested_at: string };
type Line = { key: string; label: string; detail: string | null; amount: number | null };
type EstLine = { key: string; label: string; detail: string | null; amountText: string | null; toQuote: boolean };
type View = {
  success: boolean; guest: { name: string; email: string | null; phone: string | null; party: number; travelers: string[] };
  choices: string; estimate: { lines: EstLine[]; totalText: string; category: string };
  draft: { cabin: string; lines: Line[]; deposit: number | null; note: string | null };
  toPrice: string[]; cabins: Array<{ key: string; label: string }>; finalPaymentText: string | null;
  finalAt: string | null; agreedAt: string | null; sent: { total: string; email: string | null } | null;
};
type Row = { key: string; label: string; detail: string; amount: string };

const input = "w-full border rounded px-2 py-1 text-sm bg-card";
const btn = "text-xs px-3 py-1.5 rounded-md border bg-card hover:bg-muted/40 disabled:opacity-50 inline-flex items-center gap-1 whitespace-nowrap";
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const amountOf = (s: string): number | null => { const n = Number(s.replace(/[$,\s]/g, "")); return s.trim() && Number.isFinite(n) ? n : null; };
const STATE: Record<Guest["state"], string> = { finalize: "finalize", sent: "sent, waiting on the guest", agreed: "agreed" };

function QuoteForm({ groupId, guest }: { groupId: string; guest: Guest }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = ["group-quote", groupId, guest.id];
  const { data, isLoading, error } = useQuery<View>({ queryKey: key, queryFn: () => api(`/groups/${groupId}/interests/${guest.id}/quote`) });
  const [cabin, setCabin] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [deposit, setDeposit] = useState("");
  const [note, setNote] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!data) return;
    setCabin(data.draft.cabin);
    setRows(data.draft.lines.map((l) => ({ key: l.key, label: l.label, detail: l.detail ?? "", amount: l.amount != null ? String(l.amount) : "" })));
    setDeposit(data.draft.deposit != null ? String(data.draft.deposit) : "");
    setNote(data.draft.note ?? "");
    setDirty(false);
  }, [data]);

  if (isLoading) return <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>;
  if (error || !data) return <p className="px-4 py-3 text-sm text-destructive">Could not load this quote: {(error as Error)?.message}</p>;
  const agreed = !!data.agreedAt;
  const asked = new Set(data.estimate.lines.filter((l) => l.toQuote).map((l) => l.key));
  const setR = (i: number, k: keyof Row, v: string) => { setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x))); setDirty(true); };
  const total = rows.reduce((s, r) => s + (amountOf(r.amount) ?? 0), 0);
  const dep = amountOf(deposit);
  const toPrice = rows.filter((r) => asked.has(r.key) && amountOf(r.amount) === null).map((r) => r.label);

  const save = async (): Promise<boolean> => {
    setBusy(true);
    try {
      const body = { cabin, deposit: deposit.trim() ? deposit : null, note, lines: rows.map((r) => ({ key: r.key, label: r.label, detail: r.detail, amount: r.amount.trim() ? r.amount : null })) };
      qc.setQueryData(key, await api<View>(`/groups/${groupId}/interests/${guest.id}/quote`, "PUT", body));
      toast({ title: "Quote saved (not sent yet)" });
      return true;
    } catch (e) { toast({ variant: "destructive", title: "Not saved", description: (e as Error).message }); return false; }
    finally { setBusy(false); }
  };
  const send = async () => {
    if (!window.confirm(`Send the final quote (${usd(total)}) to ${data.guest.name}${data.guest.email ? ` (${data.guest.email})` : ""}? They can agree to it as soon as it arrives.`)) return;
    setBusy(true);
    try {
      qc.setQueryData(key, await api<View>(`/groups/${groupId}/interests/${guest.id}/quote/send`, "POST"));
      toast({ title: "Final quote sent" });
      qc.invalidateQueries({ queryKey: ["group-quotes", groupId] });
      qc.invalidateQueries({ queryKey: ["group", groupId] });
    } catch (e) { toast({ variant: "destructive", title: "Not sent", description: (e as Error).message }); }
    finally { setBusy(false); }
  };

  return (
    <div className="p-4 space-y-4">
      <p className="text-sm">{data.guest.name} · party of {data.guest.party}{data.guest.travelers.length ? ` (${data.guest.travelers.join(", ")})` : ""}{data.guest.email ? ` · ${data.guest.email}` : ""}{data.guest.phone ? ` · ${data.guest.phone}` : ""}</p>

      <div className="rounded-md border p-3 space-y-1">
        <h4 className="text-sm font-semibold">What the guest chose, and the starting price they saw ({data.estimate.totalText})</h4>
        <p className="text-sm text-muted-foreground">{data.choices}</p>
        {data.estimate.lines.map((l) => <p key={l.key} className="text-sm"><span className="text-muted-foreground">{l.label}:</span> {l.amountText ?? (l.toQuote ? <em className="text-amber-700">asked you to price it</em> : "no amount")}</p>)}
      </div>

      <div>
        <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
          <h4 className="text-sm font-semibold">The final quote</h4>
          {!agreed && <button className={btn} onClick={() => { setRows((r) => [...r, { key: `extra-${Date.now()}`, label: "", detail: "", amount: "" }]); setDirty(true); }}><Plus className="w-3 h-3" /> Add an extra or upgrade</button>}
        </div>
        <div className="mb-2 max-w-md">
          <label className="text-xs text-muted-foreground block">Cabin type on this quote
            <select className={`${input} mt-1`} value={cabin} onChange={(e) => { setCabin(e.target.value); setDirty(true); }} disabled={agreed}>
              {data.cabins.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
        </div>
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={r.key} className="grid grid-cols-12 gap-2 items-end border rounded-md p-2">
              <label className="text-xs text-muted-foreground col-span-12 sm:col-span-4">Line<input className={`${input} mt-1`} value={r.label} onChange={(e) => setR(i, "label", e.target.value)} disabled={agreed} /></label>
              <label className="text-xs text-muted-foreground col-span-12 sm:col-span-5">What the guest reads under it (optional)<input className={`${input} mt-1`} value={r.detail} onChange={(e) => setR(i, "detail", e.target.value)} disabled={agreed} /></label>
              <label className="text-xs text-muted-foreground col-span-8 sm:col-span-2">Amount ($){asked.has(r.key) && amountOf(r.amount) === null ? <span className="text-amber-700"> · price it</span> : null}<input className={`${input} mt-1`} inputMode="decimal" value={r.amount} onChange={(e) => setR(i, "amount", e.target.value)} disabled={agreed} /></label>
              {!agreed && <button className={`${btn} col-span-4 sm:col-span-1`} aria-label="Remove this line" onClick={() => { setRows((x) => x.filter((_, j) => j !== i)); setDirty(true); }}><Trash2 className="w-3 h-3" /></button>}
            </div>
          ))}
        </div>
        <div className="grid sm:grid-cols-3 gap-3 mt-3">
          <label className="text-xs text-muted-foreground block">Deposit to hold the cabin ($)<input className={`${input} mt-1`} inputMode="decimal" value={deposit} onChange={(e) => { setDeposit(e.target.value); setDirty(true); }} disabled={agreed} /></label>
          <p className="text-sm self-end"><span className="text-muted-foreground">Total:</span> <b>{usd(total)}</b></p>
          <p className="text-sm self-end"><span className="text-muted-foreground">Balance{data.finalPaymentText ? `, due ${data.finalPaymentText}` : ""}:</span> {dep != null ? usd(Math.max(total - dep, 0)) : "set the deposit"}</p>
        </div>
        <label className="text-xs text-muted-foreground block mt-3">Your note to the guest, shown above the quote and in the email (optional)
          <textarea className={`${input} mt-1`} rows={2} value={note} onChange={(e) => { setNote(e.target.value); setDirty(true); }} disabled={agreed} />
        </label>
      </div>

      {agreed ? (
        <p className="text-sm flex items-center gap-1 text-green-700"><CheckCircle2 className="w-4 h-4" /> The guest agreed this quote. It is in Booking confirmations below.</p>
      ) : (
        <div className="space-y-2">
          {data.sent && !dirty && <p className="text-sm flex items-center gap-1 text-green-700"><CheckCircle2 className="w-4 h-4" /> Final quote sent ({data.sent.total}). Waiting on the guest to agree. Change a line and send again to correct it.</p>}
          {toPrice.length > 0 && <p className="text-sm text-amber-700">Price these, or take them off the quote, before it can go: {toPrice.join("; ")}.</p>}
          <div className="flex items-center gap-2 flex-wrap">
            <button className={btn} disabled={busy || !dirty} onClick={save}>{dirty ? "Save (not sent)" : "Saved"}</button>
            <button className={`${btn} bg-primary text-primary-foreground`} disabled={busy || dirty || toPrice.length > 0} onClick={send} title={dirty ? "Save first" : ""}><Send className="w-3 h-3" /> {data.sent ? "Send the corrected quote" : "Send the final quote"} to {data.guest.name}</button>
            {dirty && <span className="text-xs text-muted-foreground">Save first.</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export function GroupQuotes({ groupId }: { groupId: string }) {
  const { data } = useQuery<{ success: boolean; quotes: Guest[] }>({ queryKey: ["group-quotes", groupId], queryFn: () => api(`/groups/${groupId}/quotes`) });
  const wanted = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("quote") : null;
  const [open, setOpen] = useState<string | null>(wanted);
  const list = data?.quotes ?? [];
  useEffect(() => { if (!open && list[0]?.state === "finalize") setOpen(list[0].id); }, [list, open]);
  if (!list.length) return null;
  const waiting = list.filter((g) => g.state === "finalize").length;
  const current = list.find((g) => g.id === open) ?? null;
  return (
    <Card id="quotes" className="scroll-mt-4">
      <div className="px-4 py-3 border-b flex items-center gap-2 flex-wrap">
        <h3 className="font-semibold">Quotes to finalize</h3>
        {waiting > 0 && <Badge variant="outline" className="bg-amber-50 text-amber-800">{waiting} waiting on you</Badge>}
        <div className="flex gap-2 flex-wrap ml-auto">
          {list.map((g) => <button key={g.id} className={`${btn} ${g.id === open ? "border-foreground" : ""}`} onClick={() => setOpen(g.id)}>{g.name} · {STATE[g.state]}</button>)}
        </div>
      </div>
      {current && <QuoteForm key={current.id} groupId={groupId} guest={current} />}
    </Card>
  );
}
