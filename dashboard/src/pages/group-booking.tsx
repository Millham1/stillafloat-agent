import React, { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Send, Trash2, CheckCircle2, AlertTriangle, Upload, Download } from "lucide-react";
import { api } from "@/lib/group-api";
import { useToast } from "@/hooks/use-toast";

// Booking confirmation (Mark 2026-11-04, reshaped 2026-11-05). The guest sent their choices; Mark re-quotes them in the cruise line's system and
// uploads that quote here: it fills the form. He checks it, adds the confirmations and any change, sees what the paperwork will now say, and sends
// it. When the signed documents are back he uploads them and closes the booking. The cabin numbers live on the cabin row, the flights, hotels and
// transfers on the lead's file; the Cruise Booking Agreement and the room-number lines fill from them. Rules: server/src/routes/group-details.ts.
// Mark 2026-11-09: every price has a place. The cabin fare and the cruise line's extras (dining, drinks; read off the uploaded quote) add up
// to the total cruise price, shown against the quote's own total; each flight, hotel, transfer and package carries its quoted price.

type Guest = { id: string; name: string; category: string | null; party: number | null; paperwork: string; requested_at: string; completed_at: string | null };
type TripLine = { kind: string; direction: string | null; provider: string | null; from_place: string | null; to_place: string | null; starts_at: string | null; ends_at: string | null; label: string; confirmation: string | null; price: number | string | null; pkg?: Pkg | null };
// A package (air and hotel sold as one): the air and the hotel each have their own fields; the line's price is the package price.
type Pkg = { flights: string | null; return_flights: string | null; return_from: string | null; return_to: string | null; air_class: string | null; hotel: string | null; hotel_city: string | null; check_in: string | null; check_out: string | null; beds: "1" | "2" | null; breakfast: boolean | null };
const NO_PKG: Pkg = { flights: null, return_flights: null, return_from: null, return_to: null, air_class: null, hotel: null, hotel_city: null, check_in: null, check_out: null, beds: null, breakfast: null };
type Extra = { name: string; total: string };
type Cabin = { id: string; cabin_num: string | null; deck: string | null; category: string | null; status: string; booking_number: string | null; price_total: number | null; deposit_amount: number | null };
type Booking = {
  success: boolean; guest: { name: string; email: string | null }; quote: { category: string; party: number; total: string; deposit: string | null } | null;
  paperwork: string; cabin: Cabin | null; trip: TripLine[]; extras: Array<{ name: string; total: number }>; totals: { cabin: number | null; extras: number; cruise: number | null; travel: number | null; trip: number | null }; needs: Record<string, boolean>; missing: string[]; ready: boolean; fills: Array<{ label: string; value: string }>;
  carrier: null | {
    id: string; filename: string; status: string; error: string | null;
    read: null | { booking_number: string | null; cabin_num: string | null; category: string | null; price_total: number | null; booking_total: number | null; deposit_amount: number | null; addons: Array<{ name: string; total: number; includes: string[] }>; inclusions: string[]; warnings: string[] };
  };
  signed: null | { required: number; signed: number; complete: boolean; docs: Array<{ id: string; title: string; signer: string | null; has_pdf: boolean }> };
  completedAt: string | null; confirmWith: string[]; flexpay: null | { link: string | null; call: null | { start: string; whenText: string; meetLink: string | null } };
};
const READING = ["queued", "reading", "extracting"];
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

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
  // while the cruise line's quote is being read the form asks again every few seconds
  const { data, isLoading, error } = useQuery<Booking>({
    queryKey: key, queryFn: () => api(`/groups/${groupId}/interests/${guest.id}/booking`),
    refetchInterval: (q) => (q.state.data?.carrier && READING.includes(q.state.data.carrier.status) ? 3000 : false),
  });
  const filled = useRef<string | null>(null);   // the read this form was last filled from: a refresh never overwrites what Mark typed
  const fileRef = useRef<HTMLInputElement>(null);
  const [cabin, setCabin] = useState<Record<string, string>>({});
  const [trip, setTrip] = useState<TripLine[]>([]);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!data || dirty) return;   // a refresh never overwrites what is typed and not yet saved
    const c = data.cabin;
    setCabin({ booking_number: c?.booking_number ?? "", cabin_num: c?.cabin_num ?? "", deck: c?.deck ?? "", category: c?.category ?? "", fare: data.totals?.cabin != null ? String(data.totals.cabin) : "", deposit_amount: c?.deposit_amount != null ? String(c.deposit_amount) : "" });
    setTrip(data.trip);
    setExtras((data.extras ?? []).map((x) => ({ name: x.name, total: String(x.total) })));
    setDirty(false);
  }, [data?.cabin, data?.trip, data?.extras]);
  // The cruise line's quote has been read: its figures go into the form, unsaved, for Mark to check.
  useEffect(() => {
    const r = data?.carrier?.status === "ready" ? data.carrier.read : null;
    if (!r || !data?.carrier || filled.current !== `wait:${guest.id}`) return;
    filled.current = data.carrier.id;
    setCabin((c) => ({
      ...c,
      ...(r.booking_number ? { booking_number: r.booking_number } : {}), ...(r.cabin_num ? { cabin_num: r.cabin_num } : {}), ...(r.category ? { category: r.category } : {}),
      // the quote's Total Booking Amount includes its add-ons: the cabin fare is what is left after them
      ...(r.price_total != null ? { fare: String(Math.round(((r.booking_total != null ? r.booking_total - r.addons.reduce((n, a) => n + a.total, 0) : r.price_total)) * 100) / 100) } : {}),
      ...(r.deposit_amount != null ? { deposit_amount: String(r.deposit_amount) } : {}),
    }));
    if (r.addons.length) setExtras(r.addons.map((a) => ({ name: a.name, total: String(a.total) })));
    setDirty(true);
  }, [data?.carrier, guest.id]);

  if (isLoading) return <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>;
  if (error || !data) return <p className="px-4 py-3 text-sm text-destructive">Could not load this booking: {(error as Error)?.message}</p>;
  const sent = data.paperwork !== "booking";

  const setC = (k: string, v: string) => { setCabin((c) => ({ ...c, [k]: v })); setDirty(true); };
  const setT = (i: number, k: keyof TripLine, v: string) => { setTrip((t) => t.map((r, j) => (j === i ? { ...r, [k]: v || null } : r))); setDirty(true); };
  const addLine = (kind: string) => { setTrip((t) => [...t, { kind, direction: "pre", provider: null, from_place: null, to_place: null, starts_at: null, ends_at: null, label: kind === "flight" ? "Flight" : kind === "hotel" ? "Hotel" : kind === "package" ? "Package" : "Transfer", confirmation: null, price: null, ...(kind === "package" ? { pkg: { ...NO_PKG } } : {}) }]); setDirty(true); };
  const setP = (i: number, k: keyof Pkg, v: string | boolean | null) => { setTrip((t) => t.map((r, j) => (j === i ? { ...r, pkg: { ...NO_PKG, ...(r.pkg ?? {}), [k]: v === "" ? null : v } } : r))); setDirty(true); };
  const setX = (i: number, k: keyof Extra, v: string) => { setExtras((x) => x.map((r, j) => (j === i ? { ...r, [k]: v } : r))); setDirty(true); };
  // the sums as typed, before saving: cabin fare + cruise extras = total cruise price; + travel = trip total
  const amount = (v: unknown) => { const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : 0; };
  const round = (n: number) => Math.round(n * 100) / 100;
  const extrasSum = round(extras.reduce((n, x) => n + amount(x.total), 0));
  const cruiseSum = round(amount(cabin["fare"]) + extrasSum);
  const travelSum = round(trip.reduce((n, r) => n + amount(r.price), 0));
  const quoteTotal = data.carrier?.status === "ready" ? data.carrier.read?.booking_total ?? null : null;

  const save = async (): Promise<boolean> => {
    setBusy(true);
    try {
      const clean = (v: unknown) => (v === null || v === "" ? null : String(v).replace(/[$,\s]/g, ""));
      const body: Record<string, unknown> = { trip: trip.map((r) => ({ ...r, price: clean(r.price) })), extras: extras.filter((x) => x.name.trim() || x.total.trim()).map((x) => ({ name: x.name.trim(), total: clean(x.total) })) };
      // the cabin row keeps the whole cruise price: the cabin fare and the cruise line's extras together
      if (data.cabin) { const { fare, ...rest } = cabin; body["cabin"] = { ...rest, price_total: fare === "" && !extras.length ? "" : String(cruiseSum) }; }
      const next = await api<Booking>(`/groups/${groupId}/interests/${guest.id}/booking`, "PUT", body);
      qc.setQueryData(key, next);
      qc.invalidateQueries({ queryKey: ["group", groupId] });
      setDirty(false);
      toast({ title: "Booking confirmation saved" });
      return true;
    } catch (e) { toast({ variant: "destructive", title: "Not saved", description: (e as Error).message }); return false; }
    finally { setBusy(false); }
  };
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const b64 = await new Promise<string>((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result)); fr.onerror = () => no(new Error("The file could not be read")); fr.readAsDataURL(file); });
      await api(`/groups/${groupId}/interests/${guest.id}/carrier-quote`, "POST", { filename: file.name, data: b64 });
      filled.current = `wait:${guest.id}`;
      await qc.invalidateQueries({ queryKey: key });
      toast({ title: "Reading the cruise line's quote…" });
    } catch (e) { toast({ variant: "destructive", title: "Not uploaded", description: (e as Error).message }); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const openSigned = async (sid: string) => {
    const w = window.open("", "_blank"); // opened first so the browser does not treat it as a pop-up
    try { const r = await api<{ url: string }>(`/groups/${groupId}/signatures/${sid}/file`); if (w) w.location.href = r.url; }
    catch (e) { w?.close(); toast({ variant: "destructive", title: "Could not open it", description: (e as Error).message }); }
  };
  const complete = async () => {
    if (!window.confirm(`${data.guest.name}'s booking is confirmed with: ${data.confirmWith.join("; ")}?`)) return;
    setBusy(true);
    try {
      await api(`/groups/${groupId}/interests/${guest.id}/complete`, "POST");
      toast({ title: "Booking confirmed" });
      qc.invalidateQueries({ queryKey: ["group-bookings", groupId] });
      qc.invalidateQueries({ queryKey: key });
    } catch (e) { toast({ variant: "destructive", title: "Not completed", description: (e as Error).message }); }
    finally { setBusy(false); }
  };
  const flexpay = async () => {
    if (!window.confirm(`Email ${data.guest.name} the link to schedule the FlexPay appointment?`)) return;
    setBusy(true);
    try {
      const r = await api<{ link: string }>(`/groups/${groupId}/interests/${guest.id}/flexpay-link`, "POST");
      toast({ title: r.link === "sent" ? "FlexPay appointment link sent" : `Not sent: ${SENT[r.link] ?? r.link}` });
      qc.invalidateQueries({ queryKey: key });
    } catch (e) { toast({ variant: "destructive", title: "Not sent", description: (e as Error).message }); }
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
      {!sent && (
        <div className="rounded-md border p-3 space-y-2">
          <h4 className="text-sm font-semibold">1. The cruise line's quote</h4>
          <p className="text-sm text-muted-foreground">Re-quote this guest's choices in the cruise line's system, then upload the quote (PDF). It fills the booking confirmation below for you to check.</p>
          <input ref={fileRef} type="file" accept="application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          <button className={btn} disabled={busy || (!!data.carrier && READING.includes(data.carrier.status))} onClick={() => fileRef.current?.click()}><Upload className="w-3 h-3" /> {data.carrier ? "Upload a different quote" : "Upload the cruise line's quote"}</button>
          {data.carrier && READING.includes(data.carrier.status) && <p className="text-sm text-muted-foreground">Reading {data.carrier.filename}… about a minute.</p>}
          {data.carrier?.status === "failed" && <p className="text-sm text-destructive">{data.carrier.filename} could not be read: {data.carrier.error ?? "no reason given"}. Upload it again, or type the figures below.</p>}
          {data.carrier?.status === "ready" && data.carrier.read && (
            <div className="text-sm space-y-1">
              <p className="text-green-700 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Read {data.carrier.filename}. Check every figure below against the quote, then save.</p>
              {data.carrier.read.addons.length > 0 && <p><span className="text-muted-foreground">Paid add-ons on the quote:</span> {data.carrier.read.addons.map((a) => `${a.name} ${usd(a.total)}`).join(" · ")}</p>}
              {data.carrier.read.inclusions.length > 0 && <p><span className="text-muted-foreground">Included:</span> {data.carrier.read.inclusions.join(" · ")}</p>}
              {data.carrier.read.warnings.map((w) => <p key={w} className="text-amber-700 flex items-start gap-1"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {w}</p>)}
            </div>
          )}
        </div>
      )}
      {!data.cabin && <p className="text-sm text-amber-700 flex items-center gap-1"><AlertTriangle className="w-4 h-4" /> This guest is not on a cabin in the group file. Place them in the Cabins table below first.</p>}
      {data.cabin && (
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Cruise line booking #"><input className={input} value={cabin["booking_number"] ?? ""} onChange={(e) => setC("booking_number", e.target.value)} disabled={sent} /></Field>
          <Field label="Cabin #"><input className={input} value={cabin["cabin_num"] ?? ""} onChange={(e) => setC("cabin_num", e.target.value)} disabled={sent} /></Field>
          <Field label="Deck"><input className={input} value={cabin["deck"] ?? ""} onChange={(e) => setC("deck", e.target.value)} disabled={sent} /></Field>
          <Field label="Cabin type as booked"><input className={input} value={cabin["category"] ?? ""} onChange={(e) => setC("category", e.target.value)} disabled={sent} /></Field>
          <Field label="Cabin fare ($, without the extras)"><input className={input} inputMode="decimal" value={cabin["fare"] ?? ""} onChange={(e) => setC("fare", e.target.value)} disabled={sent} /></Field>
          <Field label="Deposit ($)"><input className={input} inputMode="decimal" value={cabin["deposit_amount"] ?? ""} onChange={(e) => setC("deposit_amount", e.target.value)} disabled={sent} /></Field>
        </div>
      )}

      {data.cabin && (
        <div>
          <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
            <h4 className="text-sm font-semibold">Cruise extras (dining package, drink package, anything the cruise line adds)</h4>
            {!sent && <button className={btn} onClick={() => { setExtras((x) => [...x, { name: "", total: "" }]); setDirty(true); }}><Plus className="w-3 h-3" /> cruise extra</button>}
          </div>
          {extras.length === 0 && <p className="text-sm text-muted-foreground">None on this booking. The uploaded quote's add-ons land here.</p>}
          <div className="space-y-2">
            {extras.map((x, i) => (
              <div key={i} className="grid grid-cols-[1fr_9rem_auto] gap-2 items-end">
                <Field label="Extra"><input className={input} value={x.name} onChange={(e) => setX(i, "name", e.target.value)} disabled={sent} /></Field>
                <Field label="Price ($, whole booking)"><input className={input} inputMode="decimal" value={x.total} onChange={(e) => setX(i, "total", e.target.value)} disabled={sent} /></Field>
                {!sent && <button className={btn} aria-label="Remove this extra" onClick={() => { setExtras((v) => v.filter((_, j) => j !== i)); setDirty(true); }}><Trash2 className="w-3 h-3" /></button>}
              </div>
            ))}
          </div>
          <p className="text-sm mt-2">Total cruise price: <b>{usd(cruiseSum)}</b> <span className="text-muted-foreground">(cabin fare {usd(amount(cabin["fare"]))} + extras {usd(extrasSum)})</span></p>
          {quoteTotal != null && (Math.abs(quoteTotal - cruiseSum) < 0.005
            ? <p className="text-sm text-green-700 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Matches the quote's Total Booking Amount, {usd(quoteTotal)}.</p>
            : <p className="text-sm text-amber-700 flex items-center gap-1"><AlertTriangle className="w-4 h-4" /> The quote's Total Booking Amount is {usd(quoteTotal)}: this is {usd(Math.abs(round(quoteTotal - cruiseSum)))} {cruiseSum > quoteTotal ? "over" : "under"}.</p>)}
        </div>
      )}

      <div>
        <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
          <h4 className="text-sm font-semibold">Flights, hotels, transfers and packages</h4>
          {!sent && <div className="flex gap-2">{["flight", "hotel", "transfer", "package"].map((k) => <button key={k} className={btn} onClick={() => addLine(k)}><Plus className="w-3 h-3" /> {k}</button>)}</div>}
        </div>
        {Object.entries(data.needs).filter(([, v]) => v).length > 0 && <p className="text-xs text-muted-foreground mb-1">The guest asked you to quote: {Object.entries(data.needs).filter(([, v]) => v).map(([k]) => k).join(", ")}.</p>}
        {trip.length === 0 && <p className="text-sm text-muted-foreground">None on this booking.</p>}
        <div className="space-y-2">
          {trip.map((r, i) => r.kind === "package" ? (
            <div key={i} className="border rounded-md p-4 space-y-5">
              {/* Mark 2026-11-09: a package is a form of its own, in sections (the air, the hotel, the price), never one row of boxes */}
              <div className="flex items-center justify-between">
                <p className="text-base font-semibold">Package (air and hotel)</p>
                {!sent && <button className={btn} aria-label="Remove this package" onClick={() => { setTrip((t) => t.filter((_, j) => j !== i)); setDirty(true); }}><Trash2 className="w-3 h-3" /> Remove</button>}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Field label="Before or after the cruise"><select className={input} value={r.direction ?? "pre"} onChange={(e) => setT(i, "direction", e.target.value)} disabled={sent}><option value="pre">Before the cruise</option><option value="post">After the cruise</option></select></Field>
              </div>
              <div className="space-y-3">
                <p className="text-sm font-semibold border-b pb-1">Air</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Carrier"><input className={input} value={r.provider ?? ""} onChange={(e) => setT(i, "provider", e.target.value)} disabled={sent} /></Field>
                  <Field label="Class"><input className={input} value={r.pkg?.air_class ?? ""} onChange={(e) => setP(i, "air_class", e.target.value)} disabled={sent} /></Field>
                </div>
                <p className="text-xs text-muted-foreground">Going</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Field label="Flight #"><input className={input} value={r.pkg?.flights ?? ""} onChange={(e) => setP(i, "flights", e.target.value)} disabled={sent} /></Field>
                  <Field label="From"><input className={input} value={r.from_place ?? ""} onChange={(e) => setT(i, "from_place", e.target.value)} disabled={sent} /></Field>
                  <Field label="To"><input className={input} value={r.to_place ?? ""} onChange={(e) => setT(i, "to_place", e.target.value)} disabled={sent} /></Field>
                  <Field label="Date"><input type="date" className={input} value={day(r.starts_at)} onChange={(e) => setT(i, "starts_at", e.target.value)} disabled={sent} /></Field>
                </div>
                <p className="text-xs text-muted-foreground">Coming back</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Field label="Flight #"><input className={input} value={r.pkg?.return_flights ?? ""} onChange={(e) => setP(i, "return_flights", e.target.value)} disabled={sent} /></Field>
                  <Field label="From"><input className={input} value={r.pkg?.return_from ?? ""} onChange={(e) => setP(i, "return_from", e.target.value)} disabled={sent} /></Field>
                  <Field label="To"><input className={input} value={r.pkg?.return_to ?? ""} onChange={(e) => setP(i, "return_to", e.target.value)} disabled={sent} /></Field>
                  <Field label="Date"><input type="date" className={input} value={day(r.ends_at)} onChange={(e) => setT(i, "ends_at", e.target.value)} disabled={sent} /></Field>
                </div>
              </div>
              <div className="space-y-3">
                <p className="text-sm font-semibold border-b pb-1">Hotel</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Hotel"><input className={input} value={r.pkg?.hotel ?? ""} onChange={(e) => setP(i, "hotel", e.target.value)} disabled={sent} /></Field>
                  <Field label="City"><input className={input} value={r.pkg?.hotel_city ?? ""} onChange={(e) => setP(i, "hotel_city", e.target.value)} disabled={sent} /></Field>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Field label="Check in"><input type="date" className={input} value={day(r.pkg?.check_in ?? null)} onChange={(e) => setP(i, "check_in", e.target.value)} disabled={sent} /></Field>
                  <Field label="Check out"><input type="date" className={input} value={day(r.pkg?.check_out ?? null)} onChange={(e) => setP(i, "check_out", e.target.value)} disabled={sent} /></Field>
                  <Field label="Beds"><select className={input} value={r.pkg?.beds ?? ""} onChange={(e) => setP(i, "beds", e.target.value)} disabled={sent}><option value="">Not set</option><option value="1">1 bed</option><option value="2">2 beds</option></select></Field>
                  <Field label="Breakfast"><select className={input} value={r.pkg?.breakfast == null ? "" : r.pkg.breakfast ? "yes" : "no"} onChange={(e) => setP(i, "breakfast", e.target.value === "" ? null : e.target.value === "yes")} disabled={sent}><option value="">Not set</option><option value="yes">Included</option><option value="no">Not included</option></select></Field>
                </div>
              </div>
              <div className="space-y-3">
                <p className="text-sm font-semibold border-b pb-1">Package price</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Confirmation #"><input className={input} value={r.confirmation ?? ""} onChange={(e) => setT(i, "confirmation", e.target.value)} disabled={sent} /></Field>
                  <Field label="Quoted package price ($)"><input className={input} inputMode="decimal" value={r.price ?? ""} onChange={(e) => setT(i, "price", e.target.value)} disabled={sent} /></Field>
                </div>
              </div>
            </div>
          ) : (
            <div key={i} className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-9 gap-2 items-end border rounded-md p-2">
              <Field label={`${r.kind} · ${r.label}`}>
                <select className={input} value={r.direction ?? "pre"} onChange={(e) => setT(i, "direction", e.target.value)} disabled={sent}><option value="pre">Before the cruise</option><option value="post">After the cruise</option></select>
              </Field>
              <Field label={r.kind === "hotel" ? "Hotel" : r.kind === "flight" ? "Airline" : "Company"}><input className={input} value={r.provider ?? ""} onChange={(e) => setT(i, "provider", e.target.value)} disabled={sent} /></Field>
              <Field label={r.kind === "hotel" ? "City" : "From"}><input className={input} value={r.from_place ?? ""} onChange={(e) => setT(i, "from_place", e.target.value)} disabled={sent} /></Field>
              <Field label="To"><input className={input} value={r.to_place ?? ""} onChange={(e) => setT(i, "to_place", e.target.value)} disabled={sent} /></Field>
              <Field label={r.kind === "hotel" ? "Check in" : "Date"}><input type="date" className={input} value={day(r.starts_at)} onChange={(e) => setT(i, "starts_at", e.target.value)} disabled={sent} /></Field>
              <Field label={r.kind === "hotel" ? "Check out" : "Arrives"}><input type="date" className={input} value={day(r.ends_at)} onChange={(e) => setT(i, "ends_at", e.target.value)} disabled={sent} /></Field>
              <Field label="Confirmation #"><input className={input} value={r.confirmation ?? ""} onChange={(e) => setT(i, "confirmation", e.target.value)} disabled={sent} /></Field>
              <Field label="Quoted price ($)"><input className={input} inputMode="decimal" value={r.price ?? ""} onChange={(e) => setT(i, "price", e.target.value)} disabled={sent} /></Field>
              {!sent && <button className={btn} aria-label="Remove this line" onClick={() => { setTrip((t) => t.filter((_, j) => j !== i)); setDirty(true); }}><Trash2 className="w-3 h-3" /></button>}
            </div>
          ))}
        </div>
        {trip.length > 0 && <p className="text-sm mt-2">Travel total: <b>{usd(travelSum)}</b> · Trip total (cruise and travel): <b>{usd(round(cruiseSum + travelSum))}</b></p>}
      </div>

      {!sent && <div><button className={btn} disabled={busy || !dirty} onClick={save}>{dirty ? "Save the confirmation" : "Saved"}</button></div>}

      <div className="rounded-md border p-3 space-y-1">
        <h4 className="text-sm font-semibold">What the paperwork will say</h4>
        {data.fills.map((f, i) => <p key={i} className="text-sm"><span className="text-muted-foreground">{f.label}:</span> {f.value || <em className="text-amber-700">not entered yet</em>}</p>)}
      </div>

      {sent ? (
        <div className="space-y-3">
          <p className="text-sm flex items-center gap-1 text-green-700"><CheckCircle2 className="w-4 h-4" /> {SENT[data.paperwork] ?? "Paperwork sent"}.</p>
          {data.signed && (
            <div className="rounded-md border p-3 space-y-2">
              <h4 className="text-sm font-semibold">2. Signed documents: {data.signed.signed} of {data.signed.required} back</h4>
              <p className="text-sm text-muted-foreground">Each signed copy is stored on this file the moment it is signed (private storage; passport details encrypted).</p>
              {data.signed.docs.length === 0 && <p className="text-sm text-muted-foreground">Nothing signed yet.</p>}
              {data.signed.docs.map((d) => (
                <p key={d.id} className="text-sm flex items-center gap-2 flex-wrap">{d.title}{d.signer ? ` · ${d.signer}` : ""}
                  {d.has_pdf && <button className={btn} onClick={() => openSigned(d.id)}><Download className="w-3 h-3" /> Signed copy</button>}</p>
              ))}
              {data.completedAt ? (
                <p className="text-sm flex items-center gap-1 text-green-700"><CheckCircle2 className="w-4 h-4" /> Booking confirmed with the cruise line and vendors · {new Date(data.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.</p>
              ) : (
                <div className="space-y-1">
                  <h4 className="text-sm font-semibold">3. Confirm the booking</h4>
                  <p className="text-sm text-muted-foreground">Confirm with: {data.confirmWith.join(" · ")}.</p>
                  <button className={`${btn} bg-primary text-primary-foreground`} disabled={busy || !data.signed.complete} onClick={complete} title={data.signed.complete ? "" : "Waiting on the guest's signatures"}><CheckCircle2 className="w-3 h-3" /> Confirmed with the cruise line and vendors</button>
                </div>
              )}
              {data.flexpay ? (
                <div className="space-y-1">
                  <h4 className="text-sm font-semibold">4. FlexPay</h4>
                  <p className="text-sm text-muted-foreground">This guest asked for FlexPay. The scheduler pops up on their quote page the moment they say yes: they pick a video call from your open times (Monday to Saturday, 10 AM to 8 PM Eastern, never over a meeting on your calendar). You schedule nothing. If they closed it without a time, send them the link to it. Then you make the payments.</p>
                  <button className={btn} disabled={busy || !data.completedAt} onClick={flexpay} title={data.completedAt ? "" : "Confirm the booking first"}><Send className="w-3 h-3" /> {data.flexpay.link ? "Send the appointment link again" : "Send the FlexPay appointment link"}</button>
                  {data.flexpay.link && <span className="text-xs text-muted-foreground ml-2">{data.flexpay.link === "sent" ? "Sent" : SENT[data.flexpay.link] ?? data.flexpay.link}.</span>}
                  {data.flexpay.call ? (
                    <p className="text-sm mt-2">Video call: <b>{data.flexpay.call.whenText}</b>. It is on your calendar.{" "}
                      {data.flexpay.call.meetLink && <a className="underline" href={data.flexpay.call.meetLink} target="_blank" rel="noreferrer">Join the video call</a>}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground mt-2">The guest has not picked a time yet. They choose from your open times, Monday to Saturday, 10 AM to 8 PM Eastern.</p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">4. No FlexPay on this booking: the card authorization and the payment schedule on this file apply.</p>
              )}
            </div>
          )}
        </div>
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
          {list.map((g) => <button key={g.id} className={`${btn} ${g.id === open ? "border-foreground" : ""}`} onClick={() => setOpen(g.id)}>{g.name}{g.completed_at ? " · confirmed" : g.paperwork === "booking" ? " · quote it" : " · sent"}</button>)}
        </div>
      </div>
      {current && <BookingForm key={current.id} groupId={groupId} guest={current} />}
    </Card>
  );
}
