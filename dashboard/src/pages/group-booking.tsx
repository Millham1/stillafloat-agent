import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Send, Trash2, CheckCircle2, AlertTriangle } from "lucide-react";
import { api } from "@/lib/group-api";
import { useToast } from "@/hooks/use-toast";

// Booking confirmation (Mark 2026-11-04). The guest agreed the quote; Mark books it with the supplier, types the confirmations and any change
// to the booking here, sees what the paperwork will now say, and sends it. The cabin numbers live on the cabin row, the flights, hotels and
// transfers on the lead's file; the Cruise Booking Agreement and the room-number lines fill from them. Rules: server/src/routes/group-details.ts.

type Guest = { id: string; name: string; category: string | null; party: number | null; paperwork: string; agreed_at: string };
type TripLine = { kind: string; direction: string | null; provider: string | null; from_place: string | null; to_place: string | null; starts_at: string | null; ends_at: string | null; label: string; confirmation: string | null };
type Cabin = { id: string; cabin_num: string | null; deck: string | null; category: string | null; status: string; booking_number: string | null; price_total: number | null; deposit_amount: number | null };
type Booking = {
  success: boolean; guest: { name: string; email: string | null }; quote: { category: string; party: number; total: string; deposit: string | null } | null;
  paperwork: string; cabin: Cabin | null; trip: TripLine[]; needs: Record<string, boolean>; missing: string[]; ready: boolean; fills: Array<{ label: string; value: string }>;
};

const input = "w-full border rounded px-2 py-1 text-sm bg-card";
const btn = "text-xs px-3 py-1.5 rounded-md border bg-card hover:bg-muted/40 disabled:opacity-50 inline-flex items-center gap-1 whitespace-nowrap";
const day = (v: string | null) => (v ? v.slice(0, 10) : "");
const SENT: Record<string, string> = { sent: "Paperwork sent", held: "Held: this box may not email", "no-email": "No email address", failed: "Send failed" };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="text-xs text-muted-foreground block">{label}<div className="mt-1">{children}</div></label>;
}

function BookingForm({ groupId, guest }: { groupId: string; guest: Guest }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = ["group-booking", groupId, guest.id];
  const { data, isLoading, error } = useQuery<Booking>({ queryKey: key, queryFn: () => api(`/groups/${groupId}/interests/${guest.id}/booking`) });
  const [cabin, setCabin] = useState<Record<string, string>>({});
  const [trip, setTrip] = useState<TripLine[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!data) return;
    const c = data.cabin;
    setCabin({ booking_number: c?.booking_number ?? "", cabin_num: c?.cabin_num ?? "", deck: c?.deck ?? "", category: c?.category ?? "", price_total: c?.price_total != null ? String(c.price_total) : "", deposit_amount: c?.deposit_amount != null ? String(c.deposit_amount) : "" });
    setTrip(data.trip);
    setDirty(false);
  }, [data]);

  if (isLoading) return <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>;
  if (error || !data) return <p className="px-4 py-3 text-sm text-destructive">Could not load this booking: {(error as Error)?.message}</p>;
  const sent = data.paperwork !== "booking";

  const setC = (k: string, v: string) => { setCabin((c) => ({ ...c, [k]: v })); setDirty(true); };
  const setT = (i: number, k: keyof TripLine, v: string) => { setTrip((t) => t.map((r, j) => (j === i ? { ...r, [k]: v || null } : r))); setDirty(true); };
  const addLine = (kind: string) => { setTrip((t) => [...t, { kind, direction: "pre", provider: null, from_place: null, to_place: null, starts_at: null, ends_at: null, label: kind === "flight" ? "Flight" : kind === "hotel" ? "Hotel" : "Transfer", confirmation: null }]); setDirty(true); };

  const save = async (): Promise<boolean> => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { trip };
      if (data.cabin) body["cabin"] = cabin;
      const next = await api<Booking>(`/groups/${groupId}/interests/${guest.id}/booking`, "PUT", body);
      qc.setQueryData(key, next);
      qc.invalidateQueries({ queryKey: ["group", groupId] });
      toast({ title: "Booking confirmation saved" });
      return true;
    } catch (e) { toast({ variant: "destructive", title: "Not saved", description: (e as Error).message }); return false; }
    finally { setBusy(false); }
  };
  const send = async () => {
    if (!window.confirm(`Send the paperwork link to ${data.guest.name}${data.guest.email ? ` (${data.guest.email})` : ""}?`)) return;
    setBusy(true);
    try {
      await api(`/groups/${groupId}/interests/${guest.id}/booked`, "POST");
      toast({ title: "Paperwork sent" });
      qc.invalidateQueries({ queryKey: ["group-bookings", groupId] });
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["group", groupId] });
    } catch (e) { toast({ variant: "destructive", title: "Not sent", description: (e as Error).message }); }
    finally { setBusy(false); }
  };

  return (
    <div className="p-4 space-y-4">
      <p className="text-sm">{data.guest.name}{data.quote ? ` · ${data.quote.category} · party of ${data.quote.party} · ${data.quote.total}` : ""}{data.guest.email ? ` · ${data.guest.email}` : ""}</p>
      {!data.cabin && <p className="text-sm text-amber-700 flex items-center gap-1"><AlertTriangle className="w-4 h-4" /> This guest is not on a cabin in the group file. Place them in the Cabins table below first.</p>}
      {data.cabin && (
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Cruise line booking #"><input className={input} value={cabin["booking_number"] ?? ""} onChange={(e) => setC("booking_number", e.target.value)} disabled={sent} /></Field>
          <Field label="Cabin #"><input className={input} value={cabin["cabin_num"] ?? ""} onChange={(e) => setC("cabin_num", e.target.value)} disabled={sent} /></Field>
          <Field label="Deck"><input className={input} value={cabin["deck"] ?? ""} onChange={(e) => setC("deck", e.target.value)} disabled={sent} /></Field>
          <Field label="Cabin type as booked"><input className={input} value={cabin["category"] ?? ""} onChange={(e) => setC("category", e.target.value)} disabled={sent} /></Field>
          <Field label="Cabin total ($)"><input className={input} inputMode="decimal" value={cabin["price_total"] ?? ""} onChange={(e) => setC("price_total", e.target.value)} disabled={sent} /></Field>
          <Field label="Deposit ($)"><input className={input} inputMode="decimal" value={cabin["deposit_amount"] ?? ""} onChange={(e) => setC("deposit_amount", e.target.value)} disabled={sent} /></Field>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
          <h4 className="text-sm font-semibold">Flights, hotels and transfers</h4>
          {!sent && <div className="flex gap-2">{["flight", "hotel", "transfer"].map((k) => <button key={k} className={btn} onClick={() => addLine(k)}><Plus className="w-3 h-3" /> {k}</button>)}</div>}
        </div>
        {Object.entries(data.needs).filter(([, v]) => v).length > 0 && <p className="text-xs text-muted-foreground mb-1">The guest asked you to quote: {Object.entries(data.needs).filter(([, v]) => v).map(([k]) => k).join(", ")}.</p>}
        {trip.length === 0 && <p className="text-sm text-muted-foreground">None on this booking.</p>}
        <div className="space-y-2">
          {trip.map((r, i) => (
            <div key={i} className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 items-end border rounded-md p-2">
              <Field label={`${r.kind} · ${r.label}`}>
                <select className={input} value={r.direction ?? "pre"} onChange={(e) => setT(i, "direction", e.target.value)} disabled={sent}><option value="pre">Before the cruise</option><option value="post">After the cruise</option></select>
              </Field>
              <Field label={r.kind === "hotel" ? "Hotel" : r.kind === "flight" ? "Airline" : "Company"}><input className={input} value={r.provider ?? ""} onChange={(e) => setT(i, "provider", e.target.value)} disabled={sent} /></Field>
              <Field label={r.kind === "hotel" ? "City" : "From"}><input className={input} value={r.from_place ?? ""} onChange={(e) => setT(i, "from_place", e.target.value)} disabled={sent} /></Field>
              <Field label="To"><input className={input} value={r.to_place ?? ""} onChange={(e) => setT(i, "to_place", e.target.value)} disabled={sent} /></Field>
              <Field label={r.kind === "hotel" ? "Check in" : "Date"}><input type="date" className={input} value={day(r.starts_at)} onChange={(e) => setT(i, "starts_at", e.target.value)} disabled={sent} /></Field>
              <Field label={r.kind === "hotel" ? "Check out" : "Arrives"}><input type="date" className={input} value={day(r.ends_at)} onChange={(e) => setT(i, "ends_at", e.target.value)} disabled={sent} /></Field>
              <Field label="Confirmation #"><input className={input} value={r.confirmation ?? ""} onChange={(e) => setT(i, "confirmation", e.target.value)} disabled={sent} /></Field>
              {!sent && <button className={btn} aria-label="Remove this line" onClick={() => { setTrip((t) => t.filter((_, j) => j !== i)); setDirty(true); }}><Trash2 className="w-3 h-3" /></button>}
            </div>
          ))}
        </div>
      </div>

      {!sent && <div><button className={btn} disabled={busy || !dirty} onClick={save}>{dirty ? "Save the confirmation" : "Saved"}</button></div>}

      <div className="rounded-md border p-3 space-y-1">
        <h4 className="text-sm font-semibold">What the paperwork will say</h4>
        {data.fills.map((f, i) => <p key={i} className="text-sm"><span className="text-muted-foreground">{f.label}:</span> {f.value || <em className="text-amber-700">not entered yet</em>}</p>)}
      </div>

      {sent ? (
        <p className="text-sm flex items-center gap-1 text-green-700"><CheckCircle2 className="w-4 h-4" /> {SENT[data.paperwork] ?? "Paperwork sent"}.</p>
      ) : (
        <div className="space-y-2">
          {data.missing.length > 0 && <ul className="text-sm text-amber-700 list-disc pl-5">{data.missing.map((m) => <li key={m}>{m}</li>)}</ul>}
          <button className={`${btn} bg-primary text-primary-foreground`} disabled={busy || dirty || !data.ready} onClick={send} title={dirty ? "Save first" : data.ready ? "" : "Finish the list above"}><Send className="w-3 h-3" /> Send the paperwork to {data.guest.name}</button>
          {dirty && <span className="text-xs text-muted-foreground ml-2">Save first.</span>}
        </div>
      )}
    </div>
  );
}

export function GroupBooking({ groupId }: { groupId: string }) {
  const { data } = useQuery<{ success: boolean; bookings: Guest[] }>({ queryKey: ["group-bookings", groupId], queryFn: () => api(`/groups/${groupId}/bookings`) });
  const wanted = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("book") : null;
  const [open, setOpen] = useState<string | null>(wanted);
  const list = data?.bookings ?? [];
  useEffect(() => { if (!open && list[0]?.paperwork === "booking") setOpen(list[0].id); }, [list, open]);
  if (!list.length) return null;
  const waiting = list.filter((g) => g.paperwork === "booking").length;
  const current = list.find((g) => g.id === open) ?? null;
  return (
    <Card id="booking" className="scroll-mt-4">
      <div className="px-4 py-3 border-b flex items-center gap-2 flex-wrap">
        <h3 className="font-semibold">Booking confirmations</h3>
        {waiting > 0 && <Badge variant="outline" className="bg-amber-50 text-amber-800">{waiting} waiting on you</Badge>}
        <div className="flex gap-2 flex-wrap ml-auto">
          {list.map((g) => <button key={g.id} className={`${btn} ${g.id === open ? "border-foreground" : ""}`} onClick={() => setOpen(g.id)}>{g.name}{g.paperwork === "booking" ? " · book it" : " · sent"}</button>)}
        </div>
      </div>
      {current && <BookingForm key={current.id} groupId={groupId} guest={current} />}
    </Card>
  );
}
