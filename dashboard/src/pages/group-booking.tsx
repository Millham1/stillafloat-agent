import React, { useEffect, useRef, useState } from "react";
import { ask, askTyped } from "@/components/confirm";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Send, Trash2, CheckCircle2, AlertTriangle, Upload, Download, Eye, Loader2 } from "lucide-react";
import { api } from "@/lib/group-api";
import { authHeaders } from "@/lib/auth-token";
import { useToast } from "@/hooks/use-toast";

// Booking confirmation (Mark 2026-11-04, reshaped 2026-11-05). The guest sent their choices; Mark re-quotes them in the cruise line's system and
// uploads that quote here: it fills the form. He checks it, adds the confirmations and any change, sees what the paperwork will now say, and sends
// it. When the signed documents are back he uploads them and closes the booking. The cabin numbers live on the cabin row, the flights, hotels and
// transfers on the lead's file; the Cruise Booking Agreement and the room-number lines fill from them. Rules: server/src/routes/group-details.ts.
// Mark 2026-11-09: every price has a place. The cabin fare and the cruise line's extras (dining, drinks; read off the uploaded quote) add up
// to the total cruise price, shown against the quote's own total; each flight, hotel, transfer and package carries its quoted price.

type TripLine = { kind: string; direction: string | null; provider: string | null; from_place: string | null; to_place: string | null; starts_at: string | null; ends_at: string | null; label: string; confirmation: string | null; price: number | string | null; pkg?: Pkg | null;
  // Mark 2026-11-12: a vendor quotes most travel per person. "person": the box holds the price for one traveler and the booking pays it once each;
  // "booking": one figure for everybody. The server keeps both the price as quoted and the booking's amount.
  per?: "person" | "booking"; unit_price?: number | null };
// Mark 2026-11-12 ("I need information at my fingertips"): everything about the customer in one block, for the booking's first screen
type Review = {
  travelers: Array<{ name: string; dob: string | null; age: number | null; lead: boolean }>; email: string | null; phone: string | null; lang: "en" | "es"; home: string | null; note: string | null;
  chose: Array<{ label: string; detail: string | null; amount?: string | null; toPrice?: boolean }>; flexpay: boolean;
  asked?: Array<{ q: string; a: string }>; pick?: { category: string; where: string; why: string } | null; toPrice: string[]; happened: Array<{ at: string; label: string }>;
};
/** Where this person stands, from the group's levels (GET /groups/:id/pipeline). */
export type BookingStage = { key: string; status: string; next: string; on: "mark" | "guest" | "done"; since: string | null };
// A package (air and hotel sold as one): the air and the hotel each have their own fields; the line's price is the package price.
type Pkg = { flights: string | null; return_flights: string | null; return_from: string | null; return_to: string | null; depart_time: string | null; arrive_time: string | null; return_depart_time: string | null; return_arrive_time: string | null; air_class: string | null; hotel: string | null; hotel_city: string | null; check_in: string | null; check_out: string | null; beds: "1" | "2" | null; breakfast: boolean | null };
const NO_PKG: Pkg = { flights: null, return_flights: null, return_from: null, return_to: null, depart_time: null, arrive_time: null, return_depart_time: null, return_arrive_time: null, air_class: null, hotel: null, hotel_city: null, check_in: null, check_out: null, beds: null, breakfast: null };
type Extra = { name: string; total: string };
// Mark 2026-11-10: travel protection priced for THIS booking (the cruise line's plan, Allianz plans): a price per person each. The guest picks one on the quote.
// A price is per person (the cruise line's plan, one typed by hand) or ONE figure for the whole party (the way Allianz prices a trip).
type Plan = { name: string; price: string; party: boolean; line: boolean };
// one guest's price lines exactly as the cruise line's quote prints them (Mark 2026-11-09: read the quote, assume nothing)
type GuestPrice = { name: string; cruise: number; packaging: number; addons: number; insurance: number; taxes: number; total: number | null; items: string[] };
type Cabin = { id: string; cabin_num: string | null; deck: string | null; category: string | null; status: string; booking_number: string | null; price_total: number | null; deposit_amount: number | null };
export type Booking = {
  success: boolean; guest: { name: string; email: string | null }; review?: Review; guestPage?: string | null;
  // the booking's facts as the cruise line's confirmation lays them out, and the money as the guest's quote prints it (Mark 2026-11-12)
  sheet?: { bookingNumber: string | null; optionUntil: { day: string; text: string } | null;
    trip: { line: string | null; ship: string | null; from: string | null; nights: number | null; departs: string | null; returns: string | null; stops: Array<{ weekday: string; date: string; port: string; arrive: string | null; depart: string | null }> };
    cabin: { number: string | null; deck: string | null; type: string | null }; travelers: Array<{ name: string; lead: boolean; items: string[] }> };
  doc?: { matrix: null | { names: string[]; rows: Array<{ label: string; values: string[]; strong?: boolean }> }; cruise: Array<{ label: string; value: string }>; cruiseTotal: { label: string; value: string } | null;
    travel: Array<{ title: string; value: string; details: string[] }>; tripTotal: { label: string; value: string } | null };
  // the price the guest approves before the paperwork goes out (Mark 2026-11-09)
  guestPrices?: GuestPrice[];
  protection?: Array<{ name: string; per_person: number | null; total: number | null; line: boolean }>;
  // the Allianz quote the agent fetched for this trip: each plan with its one price for the party
  allianz?: null | { status: "pending" | "ready" | "unavailable"; requested_at: string; quoted_at: string | null; plans: Array<{ name: string; total: number }>; hidden?: number; reason: string | null; travelers: number | null; trip_cost: number | null };
  protectionOnFile?: Array<{ name: string; per_person: number; line: boolean }>;
  price?: { protection?: { key: string; label: string } | null; sent: string | null; sent_at: string | null; approved_at: string | null; approved_how: "guest" | "mark" | null; changes: Array<{ at: string; text: string }>; changes_open: boolean };
  quote: { category: string; party: number; total: string; deposit: string | null } | null;
  paperwork: string; cabin: Cabin | null; trip: TripLine[]; extras: Array<{ name: string; total: number }>; totals: { cabin: number | null; extras: number; cruise: number | null; travel: number | null; trip: number | null }; needs: Record<string, boolean>; missing: string[]; ready: boolean; fills: Array<{ label: string; value: string }>;
  carrier: null | {
    id: string; filename: string; status: string; error: string | null;
    read: null | { booking_number: string | null; cabin_num: string | null; category: string | null; price_total: number | null; booking_total: number | null; deposit_amount: number | null; addons: Array<{ name: string; total: number; includes: string[] }>; inclusions: string[]; warnings: string[]; guests?: GuestPrice[]; option_until?: string | null; option_until_time?: string | null };
  };
  signed: null | { required: number; signed: number; complete: boolean; docs: Array<{ id: string; title: string; signer: string | null; has_pdf: boolean }> };
  completedAt: string | null; confirmWith: string[]; flexpay: null | { call: null | { start: string; whenText: string; meetLink: string | null } };
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

// Mark 2026-11-11: "the page is now so cluttered I could not find the save button … this is now becoming a booking platform and should act like one."
// The booking is one page of its own with a tab per piece of work (one piece on screen at a time), and the save bar never leaves the bottom of the screen.
export type BookingTab = "summary" | "cruise" | "travel" | "protection" | "quote" | "paperwork";

export function BookingForm({ groupId, iid, initialTab, stage }: { groupId: string; iid: string; initialTab?: BookingTab; stage?: BookingStage | null }) {
  const guest = { id: iid };
  const [, go] = useLocation();
  // Mark 2026-11-13: "the summary should be closed. If I want to see it I will select it": a booking opens with every tab closed (status, steps and
  // buttons only); pressing a tab opens it, pressing the open tab closes it
  const [tab, setTab] = useState<BookingTab | null>(initialTab ?? null);
  // Mark 2026-11-13 (opening the Cruise tab into a form of boxes: "the presentation is wrong. we fixed this yesterday"): every detail tab opens as a
  // clean read page in the confirmation layout, like the Summary. The boxes appear only after "Edit" on that tab.
  const [editing, setEditing] = useState<BookingTab | null>(null);
  const openEdit = (t: BookingTab) => { setTab(t); setEditing(t); };
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = ["group-booking", groupId, guest.id];
  // while the cruise line's quote is being read the form asks again every few seconds
  const { data, isLoading, error } = useQuery<Booking>({
    queryKey: key, queryFn: () => api(`/groups/${groupId}/interests/${guest.id}/booking`),
    refetchInterval: (q) => ((q.state.data?.carrier && READING.includes(q.state.data.carrier.status)) || q.state.data?.allianz?.status === "pending" ? 3000 : false),
  });
  const filled = useRef<string | null>(null);   // the read this form was last filled from: a refresh never overwrites what Mark typed
  const fileRef = useRef<HTMLInputElement>(null);
  const [cabin, setCabin] = useState<Record<string, string>>({});
  const [trip, setTrip] = useState<TripLine[]>([]);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [guestPrices, setGuestPrices] = useState<GuestPrice[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [allianzStop, setAllianzStop] = useState<string | null>(null);   // every hook sits above the early returns below
  // Mark 2026-11-10: a button that cannot go ahead SAYS what has to be done first, in red beside it, when it is pressed. No silent grey buttons.
  const [stop, setStop] = useState<{ at: "price" | "paperwork"; text: string } | null>(null);
  const UNSAVED = 'The current quote has not been saved. Press "Save the confirmation" at the bottom of the screen, then press this again.';
  const [preview, setPreview] = useState<{ html: string; subject: string; to: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!data || dirty) return;   // a refresh never overwrites what is typed and not yet saved
    const c = data.cabin;
    setCabin({ booking_number: c?.booking_number ?? "", cabin_num: c?.cabin_num ?? "", deck: c?.deck ?? "", category: c?.category ?? "", fare: data.totals?.cabin != null ? String(data.totals.cabin) : "", deposit_amount: c?.deposit_amount != null ? String(c.deposit_amount) : "" });
    setTrip(data.trip.map((r) => (r.per === "person" ? { ...r, price: r.unit_price ?? r.price } : r)));   // a per-person line shows the price for one traveler
    setExtras((data.extras ?? []).map((x) => ({ name: x.name, total: String(x.total) })));
    setGuestPrices(data.guestPrices ?? []);
    setPlans((data.protection ?? []).map((x) => ({ name: x.name, price: String(x.total ?? x.per_person ?? ""), party: x.total != null, line: x.line })));
    setDirty(false);
    // Mark 2026-11-10: the quote's add-ons (the dining and drink packages) belong in the Cruise extras section. When the quote has been read with
    // add-ons and this booking has no extras saved yet, the section fills from the quote by itself (unsaved, for Mark to check), with no button to press.
    const read = data.carrier?.status === "ready" ? data.carrier.read : null;
    if (data.paperwork === "booking" && (data.extras ?? []).length === 0 && read && read.addons.length > 0) fillFromRead(true);
  }, [data?.cabin, data?.trip, data?.extras, data?.carrier, data?.protection]);
  // The cruise line's quote has been read: its figures go into the form, unsaved, for Mark to check.
  const fillFromRead = (force = false) => {
    const r = data?.carrier?.status === "ready" ? data.carrier.read : null;
    if (!r || !data?.carrier || (!force && filled.current !== `wait:${guest.id}`)) return;
    filled.current = data.carrier.id;
    setCabin((c) => ({
      ...c,
      ...(r.booking_number ? { booking_number: r.booking_number } : {}), ...(r.cabin_num ? { cabin_num: r.cabin_num } : {}), ...(r.category ? { category: r.category } : {}),
      // the quote's Total Booking Amount includes its add-ons: the cabin fare is what is left after them
      ...(r.price_total != null ? { fare: String(Math.round(((r.booking_total != null ? r.booking_total - r.addons.reduce((n, a) => n + a.total, 0) : r.price_total)) * 100) / 100) } : {}),
      ...(r.deposit_amount != null ? { deposit_amount: String(r.deposit_amount) } : {}),
    }));
    if (r.addons.length) setExtras(r.addons.map((a) => ({ name: a.name, total: String(a.total) })));
    setGuestPrices(r.guests ?? []);   // the quote's own per-guest lines go on the file with the save
    setDirty(true);
  };
  useEffect(() => { fillFromRead(); }, [data?.carrier, guest.id]);

  if (isLoading) return <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>;
  if (error || !data) return <p className="px-4 py-3 text-sm text-destructive">Could not load this booking: {(error as Error)?.message}</p>;
  const sent = data.paperwork !== "booking";

  const setC = (k: string, v: string) => { setCabin((c) => ({ ...c, [k]: v })); setDirty(true); };
  const setT = (i: number, k: keyof TripLine, v: string) => { setTrip((t) => t.map((r, j) => (j === i ? { ...r, [k]: v || null } : r))); setDirty(true); };
  const addLine = (kind: string) => { setTrip((t) => [...t, { kind, direction: "pre", provider: null, from_place: null, to_place: null, starts_at: null, ends_at: null, label: kind === "flight" ? "Flight" : kind === "hotel" ? "Hotel" : kind === "package" ? "Package" : "Transfer", confirmation: null, price: null, per: kind === "hotel" ? "booking" : "person", ...(kind === "package" ? { pkg: { ...NO_PKG } } : {}) }]); setDirty(true); };
  const setP = (i: number, k: keyof Pkg, v: string | boolean | null) => { setTrip((t) => t.map((r, j) => (j === i ? { ...r, pkg: { ...NO_PKG, ...(r.pkg ?? {}), [k]: v === "" ? null : v } } : r))); setDirty(true); };
  const setPl = (i: number, patch: Partial<Plan>) => { setPlans((x) => x.map((r, j) => (j === i ? { ...r, ...patch } : r))); setDirty(true); };
  const setX = (i: number, k: keyof Extra, v: string) => { setExtras((x) => x.map((r, j) => (j === i ? { ...r, [k]: v } : r))); setDirty(true); };
  // the sums as typed, before saving: cabin fare + cruise extras = total cruise price; + travel = trip total
  const amount = (v: unknown) => { const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : 0; };
  const round = (n: number) => Math.round(n * 100) / 100;
  const extrasSum = round(extras.reduce((n, x) => n + amount(x.total), 0));
  const cruiseSum = round(amount(cabin["fare"]) + extrasSum);
  // everyone on the booking: a per-person price counts once for each of them
  const party = data.quote?.party && data.quote.party > 0 ? data.quote.party : 1;
  const lineAmount = (r: TripLine) => round(amount(r.price) * (r.per === "person" ? party : 1));
  const travelSum = round(trip.reduce((n, r) => n + lineAmount(r), 0));
  const perField = (r: TripLine, i: number) => (
    <Field label="The price is">
      <select className={input} value={r.per === "person" ? "person" : "booking"} onChange={(e) => { setTrip((t) => t.map((x, j) => (j === i ? { ...x, per: e.target.value === "person" ? "person" : "booking" } : x))); setDirty(true); }} disabled={sent}>
        <option value="person">per person</option><option value="booking">for the whole booking</option>
      </select>
    </Field>
  );
  const perMath = (r: TripLine) => (String(r.price ?? "").trim() === "" ? null
    : <p className="text-sm">{r.per === "person" ? <>{usd(amount(r.price))} per person × {party} traveler{party === 1 ? "" : "s"} = <b>{usd(lineAmount(r))} for the booking</b></> : <><b>{usd(lineAmount(r))} for the booking</b> ({party} traveler{party === 1 ? "" : "s"} together)</>}</p>);
  const quoteTotal = data.carrier?.status === "ready" ? data.carrier.read?.booking_total ?? null : null;
  const price = data.price, approved = !!price?.approved_at;
  const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

  // Mark 2026-11-12: "we need to build it into a PDF for download"
  const downloadPdf = async () => {
    const why = priceStop(); setStop(why ? { at: "price", text: why } : null); if (why) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/groups/${groupId}/interests/${guest.id}/quote-pdf`, { headers: authHeaders() });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j?.error || `The PDF could not be made (${r.status})`); }
      const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "quote.pdf";
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { setStop({ at: "price", text: (e as Error).message }); }
    finally { setBusy(false); }
  };
  // Mark 2026-11-12: "i need to be able to delete a group, quotes, and individuals"
  const removeBooking = async () => {
    if (!await ask(`Delete ${data.guest.name}'s quote and everything on it (their travelers, the uploaded cruise line quote, your open items)? The cabin goes back to held. This cannot be undone.`)) return;
    setBusy(true);
    try {
      const r = await api<{ cabin: string | null }>(`/groups/${groupId}/interests/${guest.id}/delete`, "POST", {});
      toast({ title: `${data.guest.name} deleted`, ...(r.cabin ? { description: r.cabin } : {}) });
      qc.invalidateQueries({ queryKey: ["group-pipeline", groupId] }); qc.invalidateQueries({ queryKey: ["group", groupId] }); qc.invalidateQueries({ queryKey: ["groups"] });
      go(`/groups/${groupId}/quotes`);
    } catch (e) { setStop({ at: "price", text: (e as Error).message }); setBusy(false); }
  };
  // Mark 2026-11-12 ("there are too many steps here"): the Next step card IS the button. Where the step is a press, it does it; where it is work
  // (re-quote, enter the confirmation numbers), it opens the tab that work is on.
  const NEXT: Record<string, { label: string; run: () => void }> = {
    "choices-in": { label: "Upload the cruise line's quote", run: () => openEdit("cruise") },
    changes: { label: "Re-price the cruise", run: () => openEdit("cruise") },
    "quote-not-sent": { label: "Email the quote now", run: () => void emailPrice() },
    "book-it": { label: "Send the paperwork now", run: () => void send() },
    "paperwork-not-sent": { label: "Send the paperwork now", run: () => void send() },
    signed: { label: "Mark it confirmed now", run: () => void complete() },
  };
  const next = stage ? NEXT[stage.key] ?? null : null;
  const STEPS = ["Price the quote", "Guest answers", "Book it, send paperwork", "Guest signs", "Confirmed"];
  const STEP_OF: Record<string, number> = { "choices-in": 0, changes: 0, "quote-not-sent": 0, "quote-sent": 1, "book-it": 2, "paperwork-not-sent": 2, signing: 3, signed: 3, confirmed: 5 };
  const step = stage ? STEP_OF[stage.key] ?? 0 : 0;

  // the group file's plans to show: all of them, or only the cruise line's own once Allianz's real quote for this trip is in
  const onFile = (data.protectionOnFile ?? []).filter((q) => q.line || data.allianz?.status !== "ready");
  const actBtn = "text-base px-4 py-2.5 rounded-md border bg-card hover:bg-muted/40 disabled:opacity-50 inline-flex items-center gap-2";
  const TABS: Array<{ key: BookingTab; label: string }> = [
    { key: "summary", label: "Summary" }, { key: "cruise", label: "Cruise" }, { key: "travel", label: "Flights, hotels, transfers" }, { key: "protection", label: "Travel protection" },
    { key: "paperwork", label: "Paperwork" },
  ];
  // what each tab still needs, in a word beside its name (red when it stops the quote)
  const tabNote = (k: BookingTab): { text: string; bad?: boolean } | null => {
    if (k === "summary") return null;
    if (k === "cruise") return cruiseSum > 0 ? { text: usd(cruiseSum) } : { text: "no price yet", bad: true };
    if (k === "travel") {
      const unpriced = trip.filter((r) => r.price === null || String(r.price).trim() === "").length;
      return unpriced > 0 ? { text: `${unpriced} with no price`, bad: true } : trip.length ? { text: usd(travelSum) } : { text: "none" };
    }
    if (k === "protection") return { text: price?.protection?.label ? "chosen" : plans.length ? `${plans.length} on the quote` : "none on the quote" };
    if (k === "quote") return { text: sent || approved ? "approved" : price?.changes_open ? "changes asked" : price?.sent_at ? (price.sent === "sent" ? "emailed" : "not sent") : "not sent", bad: !sent && !approved && (!!price?.changes_open || (!!price?.sent_at && price.sent !== "sent")) };
    return { text: data.completedAt ? "confirmed" : data.signed ? `${data.signed.signed} of ${data.signed.required} signed` : "not sent" };
  };

  const askAllianz = async (again: boolean) => {
    try {
      await api(`/groups/${groupId}/interests/${guest.id}/protection-quote`, "POST", again ? { again: true } : {});
      setAllianzStop(null);
      qc.invalidateQueries({ queryKey: key });
    } catch (e) { setAllianzStop((e as Error).message); }
  };
  const save = async (): Promise<boolean> => {
    setBusy(true);
    try {
      const clean = (v: unknown) => (v === null || v === "" ? null : String(v).replace(/[$,\s]/g, ""));
      const body: Record<string, unknown> = { guest_prices: guestPrices, trip: trip.map((r) => ({ ...r, price: clean(r.price) })), extras: extras.filter((x) => x.name.trim() || x.total.trim()).map((x) => ({ name: x.name.trim(), total: clean(x.total) })),
        protection: plans.filter((x) => x.name.trim() || x.price.trim()).map((x) => ({ name: x.name.trim(), ...(x.party ? { total: clean(x.price) } : { per_person: clean(x.price) }), line: x.line })) };
      // the cabin row keeps the whole cruise price: the cabin fare and the cruise line's extras together
      if (data.cabin) { const { fare, ...rest } = cabin; body["cabin"] = { ...rest, price_total: fare === "" && !extras.length ? "" : String(cruiseSum) }; }
      const next = await api<Booking>(`/groups/${groupId}/interests/${guest.id}/booking`, "PUT", body);
      qc.setQueryData(key, next);
      qc.invalidateQueries({ queryKey: ["group", groupId] });
      qc.invalidateQueries({ queryKey: ["group-pipeline", groupId] });
      setDirty(false); setStop(null);
      toast({ title: "Booking confirmation saved" });
      // Mark 2026-11-10: once the costs are saved the agent goes to Allianz with the whole trip and brings the plans back (the same trip is not asked twice)
      if ((next.totals?.trip ?? 0) > 0 && next.paperwork === "booking") void askAllianz(false);
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
  // Mark 2026-11-14 ("the paperwork tab only gives you the choice to download. there should be a view option as well"): View reads the
  // stored PDF and shows it in a new tab as a PDF, whatever the storage says about saving it; Download saves the file under its own name.
  const viewSigned = async (sid: string) => {
    const w = window.open("", "_blank"); // opened first so the browser does not treat it as a pop-up
    try {
      const r = await api<{ url: string }>(`/groups/${groupId}/signatures/${sid}/file`);
      const got = await fetch(r.url);
      if (!got.ok) throw new Error("The stored copy could not be read. Try again in a minute.");
      const page = URL.createObjectURL(new Blob([await got.arrayBuffer()], { type: "application/pdf" }));
      if (w) w.location.href = page; else window.location.href = page;
    } catch (e) { w?.close(); toast({ variant: "destructive", title: "Could not open it", description: (e as Error).message }); }
  };
  const downloadSigned = async (sid: string, title: string) => {
    try {
      const r = await api<{ url: string }>(`/groups/${groupId}/signatures/${sid}/file`);
      const got = await fetch(r.url);
      if (!got.ok) throw new Error("The stored copy could not be read. Try again in a minute.");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([await got.arrayBuffer()], { type: "application/pdf" }));
      a.download = `${title.replace(/[^\w .-]/g, "").trim() || "Signed document"} signed.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { toast({ variant: "destructive", title: "Could not download it", description: (e as Error).message }); }
  };
  const complete = async () => {
    if (!await ask(`${data.guest.name}'s booking is confirmed with: ${data.confirmWith.join("; ")}?`)) return;
    setBusy(true);
    try {
      await api(`/groups/${groupId}/interests/${guest.id}/complete`, "POST");
      toast({ title: "Booking confirmed" });
      qc.invalidateQueries({ queryKey: ["group-pipeline", groupId] });
      qc.invalidateQueries({ queryKey: key });
    } catch (e) { toast({ variant: "destructive", title: "Not completed", description: (e as Error).message }); }
    finally { setBusy(false); }
  };
  // Mark 2026-11-09: the price goes to the guest first ("Book It" / "I need changes"); the paperwork waits for their yes
  // what stops a price button, in words; null when it can go ahead
  const priceStop = (): string | null => (dirty ? UNSAVED : cruiseSum <= 0 ? "There is no price to send yet. Enter the cabin fare, then save the confirmation." : null);
  const emailPrice = async () => {
    const why = priceStop(); setStop(why ? { at: "price", text: why } : null); if (why) return;
    if (!await ask(`Send this quote to ${data.guest.name}${data.guest.email ? ` at ${data.guest.email}` : ""} now? It is a real email. They answer with "Book It" or "I need changes".`)) return;
    setBusy(true);
    try {
      const r = await api<{ price: { sent: string } }>(`/groups/${groupId}/interests/${guest.id}/price-email`, "POST");
      // a send that did not go out says why, and what to do, in red beside the button
      const WHY: Record<string, string> = {
        failed: "The quote was NOT sent: the mail service refused it. Nothing went to the guest. Press the button again; if it fails twice, the mail service is down.",
        held: "The quote was NOT sent: this is the test site, and it only emails its test addresses. This guest's address is not one of them.",
        "no-email": "The quote was NOT sent: this guest has no email address on file. Add one to the reply, then send again.",
      };
      if (r.price.sent === "sent") { setStop(null); toast({ title: "Quote emailed to the guest" }); }
      else { setStop({ at: "price", text: WHY[r.price.sent] ?? `The quote was NOT sent (${r.price.sent}).` }); toast({ variant: "destructive", title: "Quote not sent" }); }
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["group-pipeline", groupId] });
    } catch (e) { toast({ variant: "destructive", title: "Not sent", description: (e as Error).message }); }
    finally { setBusy(false); }
  };
  // Mark 2026-11-13: "there is also no way for me to send the email that I see": the preview opens on this page with its own Send button
  const previewPrice = async () => {
    const why = priceStop(); setStop(why ? { at: "price", text: why } : null); if (why) return;
    setBusy(true);
    try { setPreview(await api<{ html: string; subject: string; to: string }>(`/groups/${groupId}/interests/${guest.id}/price-preview`)); }
    catch (e) { setStop({ at: "price", text: (e as Error).message }); }   // the reason stays in red (it names what to fix)
    finally { setBusy(false); }
  };
  const recordYes = async () => {
    const why = dirty ? UNSAVED : null; setStop(why ? { at: "price", text: why } : null); if (why) return;
    if (!await ask(`Record that ${data.guest.name} approved this price another way (a call, a text)?`)) return;
    setBusy(true);
    try {
      await api(`/groups/${groupId}/interests/${guest.id}/price-approved`, "POST");
      toast({ title: "Price approval recorded" });
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["group-pipeline", groupId] });
    } catch (e) { toast({ variant: "destructive", title: "Not recorded", description: (e as Error).message }); }
    finally { setBusy(false); }
  };
  const send = async () => {
    const why = dirty ? UNSAVED : !data.ready ? `Finish the booking confirmation first: ${data.missing.join("; ")}.` : !approved ? "The guest has not approved the price yet. Email the price to them (or record their yes), then send the paperwork." : null;
    setStop(why ? { at: "paperwork", text: why } : null); if (why) return;
    // Mark 2026-11-14: the advisor signs before the documents go to the client; the name typed here goes on the agent's signature lines
    const advisor = await askTyped(`Sign the documents as the advisor and send them to ${data.guest.name}${data.guest.email ? ` (${data.guest.email})` : ""}? Your name and today's date go on the advisor's signature lines of every document. Type your full name to sign.`);
    if (advisor === null) return;
    setBusy(true);
    try {
      await api(`/groups/${groupId}/interests/${guest.id}/booked`, "POST", { advisor_name: advisor });
      toast({ title: "Paperwork sent" });
      qc.invalidateQueries({ queryKey: ["group-pipeline", groupId] });
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["group", groupId] });
    } catch (e) { toast({ variant: "destructive", title: "Not sent", description: (e as Error).message }); }
    finally { setBusy(false); }
  };

    const H = ({ children, edit }: { children: React.ReactNode; edit?: BookingTab }) => (
      <div className="mt-8 mb-3 flex items-end justify-between gap-3 border-b-2 border-[#c5cfdf] pb-1.5">
        <h4 className="text-lg font-extrabold uppercase tracking-wider">{children}</h4>
        {edit && !sent && <button className="text-sm font-semibold underline text-[#0b4fa8]" onClick={() => openEdit(edit)}>Edit</button>}
      </div>
    );
    const kv = (k: string, v: React.ReactNode) => (v ? <p className="text-base leading-7"><span className="text-[#4a5a7a]">{k}:</span> <b>{v}</b></p> : null);
    const pay = (label: React.ReactNode, value: React.ReactNode, kind?: "sub" | "total") => (
      <div className={`flex justify-between gap-6 tabular-nums ${kind === "total" ? "mt-3 border-t-[3px] border-[#07183f] py-3 text-2xl font-extrabold" : kind === "sub" ? "my-2 border-y-2 border-[#07183f] py-2.5 text-base font-extrabold" : "py-1 text-base"}`}><span className="min-w-0">{label}</span><span className="whitespace-nowrap">{value}</span></div>
    );
    const missing = <span className="font-bold text-red-600">not entered yet</span>;
  // the white page every tab of a booking is read on, and the one button that opens its boxes
  const PAPER = "rounded-md bg-white text-[#07183f] px-6 py-7 sm:px-10";
  const editBtn = (t: BookingTab, label: string) => (sent ? null : (
    <div className="flex justify-end"><button className="text-base font-semibold px-4 py-2 rounded-md border-2 border-[#07183f] hover:bg-[#eef2f8]" onClick={() => setEditing(t)}>{label}</button></div>
  ));
  const backBtn = (label: string) => (
    <button className="text-base font-semibold underline" onClick={() => setEditing(null)}>← {label}</button>
  );
  const top = (label: string, value: React.ReactNode, under?: React.ReactNode) => (
    <div className="border-t-[3px] border-[#07183f] pt-2"><p className="text-base text-[#4a5a7a]">{label}</p><p className="text-3xl font-extrabold leading-tight">{value}</p>{under}</div>
  );

  return (
    <div>
      {/* Mark 2026-11-12 ("I look at this mess and see nothing, it all blurs together into a blob"): the top of a booking is ONE line of where it
          stands, the steps of a booking with the current one lit, and ONE button for the next step. No row of cards. */}
      {stage && (
        <div className="px-5 pt-5 pb-4 space-y-4 border-b">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="text-lg font-bold">{stage.status}{stage.since ? <span className="font-normal text-muted-foreground text-base"> · since {when(stage.since)}</span> : null}</p>
              <p className={`text-base ${stage.on === "mark" ? "text-red-500 font-semibold" : "text-muted-foreground"}`}>{stage.on === "mark" ? "Your move: " : stage.on === "guest" ? "" : ""}{stage.next}</p>
            </div>
            {next && <button className="text-base font-semibold px-6 py-3 rounded-md bg-primary text-primary-foreground disabled:opacity-50" disabled={busy} onClick={next.run}>{next.label}</button>}
          </div>
          <ol className="grid grid-cols-5 gap-2" aria-label="The steps of a booking">
            {STEPS.map((label, n) => (
              <li key={label} className={`rounded-md px-3 py-2 text-sm font-semibold text-center border ${n < step ? "bg-green-600/20 border-green-600/40 text-green-500" : n === step ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground"}`}>{n < step ? "✓ " : `${n + 1}. `}{label}</li>
            ))}
          </ol>
          {stop && <p className="text-base font-semibold text-red-500 flex items-start gap-2" role="alert"><AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" /> {stop.text}</p>}
        </div>
      )}
      {/* Mark 2026-11-13: what can be done with the quote is on EVERY tab, not only the first: after adding plans there was no button to send from */}
      <div className="px-5 py-3 border-b space-y-2">
        <div className="flex flex-wrap gap-3 items-center">
          {!sent && <button className="text-base font-semibold px-5 py-2.5 rounded-md bg-primary text-primary-foreground disabled:opacity-50 inline-flex items-center gap-2" disabled={busy} onClick={emailPrice}><Send className="w-4 h-4" /> {price?.sent_at ? "Email the quote again" : "Email the quote"}</button>}
          <button className={actBtn} disabled={busy} onClick={previewPrice}>Preview the email</button>
          {data.guestPage && <a className={actBtn} href={data.guestPage} target="_blank" rel="noopener noreferrer">See the guest's page</a>}
          <button className={actBtn} disabled={busy} onClick={downloadPdf}><Download className="w-4 h-4" /> Download the PDF</button>
          {!sent && !approved && <button className={actBtn} disabled={busy} onClick={recordYes}>They said yes another way</button>}
          {!sent && approved && <button className="text-base font-semibold px-5 py-2.5 rounded-md bg-primary text-primary-foreground disabled:opacity-50 inline-flex items-center gap-2" disabled={busy} onClick={send}><Send className="w-4 h-4" /> Send the paperwork</button>}
        </div>
        {dirty && <p className="text-base font-semibold text-amber-500">You have changes that are not saved. Save them first: the email and the guest's page show the saved booking.</p>}
        {!stage && stop && <p className="text-base font-semibold text-red-500" role="alert">{stop.text}</p>}
      </div>
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Preview of the quote email">
          <div className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-lg bg-card">
            <div className="border-b px-5 py-3">
              <p className="text-lg font-bold">Preview of the quote email</p>
              <p className="text-base text-muted-foreground">To: {preview.to || "no email address on file"} · Subject: {preview.subject}</p>
            </div>
            <iframe title="The quote email" srcDoc={preview.html} className="min-h-[50vh] flex-1 bg-[#eef2f8]" />
            <div className="flex flex-wrap items-center justify-end gap-3 border-t px-5 py-3">
              <button className={actBtn} onClick={() => setPreview(null)}>Close</button>
              {!sent && <button className="text-base font-semibold px-5 py-2.5 rounded-md bg-primary text-primary-foreground disabled:opacity-50 inline-flex items-center gap-2" disabled={busy} onClick={async () => { setPreview(null); await emailPrice(); }}><Send className="w-4 h-4" /> Send this email now</button>}
            </div>
          </div>
        </div>
      )}
      <div role="tablist" aria-label="The parts of this booking" className="flex flex-wrap gap-x-1 border-b px-2">
        {TABS.map((t) => {
          const note = tabNote(t.key);
          return (
            <button key={t.key} role="tab" aria-selected={tab === t.key} aria-expanded={tab === t.key} onClick={() => setTab((cur) => (cur === t.key ? null : t.key))}
              className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap ${tab === t.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
              {t.label}{note && <span className={`ml-2 text-xs font-normal ${note.bad ? "text-red-500 font-semibold" : "text-muted-foreground"}`}>{note.text}</span>}
            </button>
          );
        })}
      </div>
      <div className="p-4 space-y-4">
      {tab === "summary" && (() => {
        // Mark 2026-11-12, of the cruise line's own confirmation page: "it is clean, easy to understand and the info is at my fingertips." The
        // booking's first screen is laid out the same way: ONE page read top to bottom; the booking number and the status on top; plainly named
        // sections (trip, booking, getting there, travel protection, payment); label and value; all the money in one right-hand column that ends in
        // one total. No typing and no warnings among the facts: each section has an Edit that opens its detail, and the actions sit above the page.
        const rv = data.review, sh = data.sheet, doc = data.doc;
        const unpriced = data.trip.filter((r) => r.price === null);
        const complete = (data.totals.cruise ?? 0) > 0 && unpriced.length === 0;
        const today = new Date().toISOString().slice(0, 10);
        const lapsed = !!sh?.optionUntil && sh.optionUntil.day < today && !sent;
        const picked = price?.protection?.label ?? null;
        // Mark 2026-11-13: "the summary page doesn't show the insurance": the plan the guest chose is a line in the money and part of the trip total.
        const pkey = price?.protection?.key ?? "";
        const pplan = /^p\d+$/.test(pkey) ? (data.protection ?? [])[Number(pkey.slice(1))] : undefined;
        const pcost = pplan ? (pplan.total != null ? Number(pplan.total) : pplan.per_person != null ? Number(pplan.per_person) * party : null) : null;
        const act = "text-base px-4 py-2.5 rounded-md border bg-card hover:bg-muted/40 disabled:opacity-50 inline-flex items-center gap-2";
        return (
          <div className="space-y-4">
            <div className="rounded-md bg-white text-[#07183f] px-6 py-7 sm:px-10">
              <div className="grid gap-6 sm:grid-cols-2">
                <div className="border-t-[3px] border-[#07183f] pt-2">
                  <p className="text-base text-[#4a5a7a]">Booking number</p>
                  <p className="text-3xl font-extrabold leading-tight">{sh?.bookingNumber ?? <span className="text-xl text-red-600">not entered yet</span>}</p>
                </div>
                <div className="border-t-[3px] border-[#07183f] pt-2">
                  <p className="text-base text-[#4a5a7a]">Status</p>
                  <p className="text-3xl font-extrabold leading-tight">{stage?.status ?? (sent ? "Paperwork sent" : approved ? "Said Book It" : price?.sent_at ? "Quote emailed" : "Choices are in")}</p>
                  {sh?.optionUntil && <p className={`text-base font-bold ${lapsed ? "text-red-600" : "text-[#8a5f00]"}`}>{lapsed ? "The cruise line's hold ended " : "The cruise line holds the cabin until "}{sh.optionUntil.text}</p>}
                </div>
              </div>

              <H>Trip details</H>
              {kv("Ship", [sh?.trip.ship, sh?.trip.line].filter(Boolean).join(" · "))}
              {kv("Departure", [sh?.trip.from, sh?.trip.departs].filter(Boolean).join(", "))}
              {kv("Return", sh?.trip.returns)}
              {kv("Duration", sh?.trip.nights ? `${sh.trip.nights} nights` : null)}
              {(sh?.trip.stops ?? []).length > 0 && (
                <table className="mt-3 w-full text-base">
                  <thead><tr className="border-b-2 border-[#c5cfdf] text-left"><th className="py-2 pr-3 font-extrabold">Day</th><th className="py-2 pr-3 font-extrabold">Date</th><th className="py-2 pr-3 font-extrabold">Port</th><th className="py-2 pr-3 font-extrabold whitespace-nowrap">Arrival</th><th className="py-2 font-extrabold whitespace-nowrap">Departure</th></tr></thead>
                  <tbody>{sh!.trip.stops.map((x, n) => <tr key={n} className="border-b border-[#dde5f1]"><td className="py-2 pr-3">{x.weekday}</td><td className="py-2 pr-3 whitespace-nowrap">{x.date}</td><td className="py-2 pr-3">{x.port}</td><td className="py-2 pr-3 whitespace-nowrap">{x.arrive ?? "-"}</td><td className="py-2 whitespace-nowrap">{x.depart ?? "-"}</td></tr>)}</tbody>
                </table>
              )}

              <H edit="cruise">Booking details</H>
              {kv("Stateroom", [sh?.cabin.number, sh?.cabin.type, sh?.cabin.deck ? `deck ${sh.cabin.deck}` : null].filter(Boolean).join(" · ") || missing)}
              {(sh?.travelers ?? []).map((t, n) => {
                const age = rv?.travelers.find((x) => x.name === t.name)?.age;
                return (
                  <div key={n} className="grid gap-4 border-b border-[#dde5f1] py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                    <p className="text-lg font-extrabold">{t.name}{age != null ? <span className="font-normal text-[#4a5a7a]">, {age}</span> : null}</p>
                    {t.items.length > 0 && <div><p className="text-base text-[#4a5a7a]">Additional items:</p>{t.items.map((x, k) => <p key={k} className="text-base font-bold leading-7">{x}</p>)}</div>}
                  </div>
                );
              })}
              <div className="mt-3">
                {kv("Email", rv?.email)}{kv("Phone", rv?.phone ?? <span className="font-normal text-[#4a5a7a]">not on file</span>)}{kv("Home", rv?.home)}{rv?.flexpay ? kv("FlexPay", "they asked for it") : null}
              </div>

              {/* Mark 2026-11-14 ("i dont see any choices. how do I see what she actually checked on the form"): every answer the guest gave, in one list */}
              {((rv?.chose ?? []).length > 0 || (rv?.asked ?? []).length > 0) && (
                <div data-testid="guest-chose">
                  <H>What the guest chose</H>
                  {(rv?.chose ?? []).map((c, n) => (
                    <div key={n} className="grid gap-4 border-b border-[#dde5f1] py-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                      <p className="text-lg font-extrabold">{c.label}</p>
                      <p className="text-base">{c.toPrice ? <b className="text-[#8a5f00]">Asked for it. Waiting for your price.</b> : <><span className="text-[#4a5a7a]">Price they saw:</span> <b>{c.amount ?? "none shown"}</b></>}</p>
                    </div>
                  ))}
                  <div className="mt-3">{kv("FlexPay", rv?.flexpay ? "Yes, they asked for it" : "No")}</div>
                  {(rv?.asked ?? []).length > 0 && (
                    <div className="mt-4">
                      <p className="text-base font-extrabold">Their answers to the four cabin questions</p>
                      {(rv?.asked ?? []).map((x, n) => <p key={n} className="text-base leading-7"><span className="text-[#4a5a7a]">{x.q}</span> <b>{x.a}</b></p>)}
                      {rv?.pick ? <p className="text-base leading-7"><span className="text-[#4a5a7a]">Our pick for them:</span> <b>{rv.pick.category}, {rv.pick.where}</b> <span className="text-[#4a5a7a]">({rv.pick.why})</span></p> : null}
                    </div>
                  )}
                </div>
              )}

              <H edit="travel">Getting there</H>
              {data.trip.length === 0 && <p className="text-base text-[#4a5a7a]">No flights, hotels or transfers on this booking.</p>}
              {data.trip.map((r, n) => (
                <div key={n} className="grid gap-4 border-b border-[#dde5f1] py-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                  <div><p className="text-lg font-extrabold">{r.kind === "package" ? `Air and hotel package, ${r.direction === "post" ? "after" : "before"} the cruise` : r.label}</p>{r.provider && <p className="text-base text-[#4a5a7a]">{r.provider}</p>}</div>
                  <p className="text-base"><span className="text-[#4a5a7a]">Confirmation:</span> <b>{r.confirmation ?? missing}</b></p>
                </div>
              ))}

              <H edit="protection">Travel protection</H>
              <p className="text-base">{picked ? <>The guest chose: <b>{picked}</b></> : (data.protection ?? []).length ? <><b>{(data.protection ?? []).length} plan{(data.protection ?? []).length === 1 ? "" : "s"}</b> offered on the quote. The guest has not chosen yet.</> : <span className="font-bold text-red-600">No plans are offered on this quote yet.</span>}</p>

              <H>Payment details</H>
              {doc?.matrix ? doc.matrix.names.map((name, n) => (
                <React.Fragment key={n}>
                  <div className="grid gap-4 pt-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                    <p className="text-lg font-extrabold">{name}</p>
                    <div>{doc.matrix!.rows.filter((r) => !r.strong).map((r, k) => <React.Fragment key={k}>{pay(r.label, r.values[n])}</React.Fragment>)}</div>
                  </div>
                  {doc.matrix!.rows.filter((r) => r.strong).map((r, k) => <React.Fragment key={k}>{pay(`${r.label} · ${name}`, r.values[n], "sub")}</React.Fragment>)}
                </React.Fragment>
              )) : (doc?.cruise ?? []).map((l, n) => <React.Fragment key={n}>{pay(l.label, l.value)}</React.Fragment>)}
              {pay("Cruise total", doc?.cruiseTotal?.value ?? <span className="text-red-600">no price yet</span>, "sub")}
              {data.trip.map((r, n) => <React.Fragment key={n}>{pay(<>{r.kind === "package" ? "Air and hotel package" : r.label}{r.per === "person" && r.unit_price != null ? <span className="text-[#4a5a7a]"> · {usd(Number(r.unit_price))} per person × {party}</span> : null}</>, r.price != null ? usd(Number(r.price)) : <span className="font-bold text-red-600">no price yet</span>)}</React.Fragment>)}
              {picked && pplan && pay(<>Travel protection · {pplan.name}</>, pcost != null ? usd(pcost) : <span className="font-bold text-red-600">no price yet</span>)}
              {picked && !pplan && pay("Travel protection", pkey === "included" ? "in the cruise total" : picked)}
              {pay(`Trip total · ${pcost != null ? "cruise, travel and travel protection" : "cruise and travel"}, ${party} traveler${party === 1 ? "" : "s"}`, complete && data.totals.trip != null && !(pplan && pcost == null) ? usd(data.totals.trip + (pcost ?? 0)) : <span className="text-red-600">not finished</span>, "total")}
              {data.cabin?.deposit_amount != null && <p className="mt-2 text-base text-[#4a5a7a]">Deposit: <b className="text-[#07183f]">{usd(Number(data.cabin.deposit_amount))}</b></p>}
            </div>
            {dirty && <p className="text-base text-amber-500">You have changes that are not saved: this page shows the saved booking.</p>}
            {!sent && <div className="flex justify-end"><button className="text-sm px-3 py-1.5 rounded-md border border-red-500/50 text-red-500 hover:bg-red-500/10 inline-flex items-center gap-1 disabled:opacity-50" disabled={busy} onClick={removeBooking}><Trash2 className="w-4 h-4" /> Delete this quote</button></div>}
          </div>
        );
      })()}
      {tab === "cruise" && editing !== "cruise" && (() => {
        const sh = data.sheet, doc = data.doc, read = data.carrier?.read ?? null;
        const saved = data.totals.cruise ?? 0, printed = read?.booking_total ?? null;
        const off = printed != null && saved > 0 ? Math.round((saved - printed) * 100) / 100 : null;
        return (
          <div className={PAPER}>
            {editBtn("cruise", "Edit the cruise details")}
            <div className="mt-3 grid gap-6 sm:grid-cols-2">
              {top("Cruise line booking number", sh?.bookingNumber ?? <span className="text-xl text-red-600">not entered yet</span>)}
              {top("Total cruise price", doc?.cruiseTotal?.value ?? <span className="text-xl text-red-600">no price yet</span>,
                off === null ? null : Math.abs(off) < 0.005
                  ? <p className="text-base font-bold text-green-700">Matches the cruise line's quote</p>
                  : <p className="text-base font-bold text-red-600">{usd(Math.abs(off))} {off > 0 ? "over" : "under"} the cruise line's quote of {usd(printed!)}</p>)}
            </div>

            <H>Stateroom</H>
            {kv("Cabin", sh?.cabin.number ?? missing)}
            {kv("Deck", sh?.cabin.deck)}
            {kv("Cabin type", sh?.cabin.type ?? missing)}
            {sh?.optionUntil && kv("The cruise line holds it until", sh.optionUntil.text)}

            <H>Guests and prices</H>
            {doc?.matrix ? doc.matrix.names.map((name, n) => (
              <React.Fragment key={n}>
                <div className="grid gap-4 pt-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                  <div>
                    <p className="text-lg font-extrabold">{name}</p>
                    {(sh?.travelers.find((t) => t.name === name)?.items ?? []).map((x, k) => <p key={k} className="text-base text-[#4a5a7a] leading-6">{x}</p>)}
                  </div>
                  <div>{doc.matrix!.rows.filter((r) => !r.strong).map((r, k) => <React.Fragment key={k}>{pay(r.label, r.values[n])}</React.Fragment>)}</div>
                </div>
                {doc.matrix!.rows.filter((r) => r.strong).map((r, k) => <React.Fragment key={k}>{pay(`${r.label} · ${name}`, r.values[n], "sub")}</React.Fragment>)}
              </React.Fragment>
            )) : (doc?.cruise ?? []).map((l, n) => <React.Fragment key={n}>{pay(l.label, l.value)}</React.Fragment>)}
            {pay("Cruise total", doc?.cruiseTotal?.value ?? <span className="text-red-600">no price yet</span>, "total")}
            {data.cabin?.deposit_amount != null && <p className="mt-2 text-base text-[#4a5a7a]">Deposit: <b className="text-[#07183f]">{usd(Number(data.cabin.deposit_amount))}</b></p>}

            <H>The cruise line's quote</H>
            {kv("File", data.carrier ? data.carrier.filename : <span className="font-bold text-red-600">not uploaded yet</span>)}
            {read && read.inclusions.length > 0 && kv("Included", read.inclusions.join(" · "))}
            {(read?.warnings ?? []).map((w) => <p key={w} className="text-base font-bold text-[#8a5f00]">{w}</p>)}
          </div>
        );
      })()}
      {tab === "cruise" && editing === "cruise" && (<>
      {backBtn("Back to the cruise details")}
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
              {(data.carrier.read.guests ?? []).length > 0 ? (
                <div className="mt-2">
                  <p className="font-semibold flex items-center gap-3 flex-wrap">The quote, guest by guest, exactly as printed: {!sent && <button className={btn} onClick={() => fillFromRead(true)}>Fill the form below from these figures</button>}</p>
                  <table className="w-full text-sm mt-1">
                    <thead><tr className="text-left text-muted-foreground"><th className="font-normal py-1">Guest</th><th className="font-normal">Cruise</th><th className="font-normal">Add-ons</th><th className="font-normal">Taxes</th><th className="font-normal">Guest total</th></tr></thead>
                    <tbody>
                      {(data.carrier.read.guests ?? []).map((g) => (
                        <tr key={g.name} className="border-t align-top"><td className="py-1 pr-2">{g.name}</td><td>{usd(g.cruise)}</td><td className="pr-2">{usd(g.addons)}{g.items.length > 0 && <span className="block text-xs text-muted-foreground">{g.items.join(", ")}</span>}</td><td>{usd(g.taxes)}</td><td className="font-semibold">{g.total != null ? usd(g.total) : ""}</td></tr>
                      ))}
                      {data.carrier.read.booking_total != null && <tr className="border-t"><td className="py-1 font-semibold" colSpan={4}>Total booking price</td><td className="font-semibold">{usd(data.carrier.read.booking_total)}</td></tr>}
                    </tbody>
                  </table>
                </div>
              ) : data.carrier.read.addons.length > 0 && <p><span className="text-muted-foreground">Paid add-ons on the quote:</span> {data.carrier.read.addons.map((a) => `${a.name} ${usd(a.total)}`).join(" · ")}</p>}
              {data.carrier.read.inclusions.length > 0 && <p><span className="text-muted-foreground">Included:</span> {data.carrier.read.inclusions.join(" · ")}</p>}
              {data.carrier.read.option_until && <p><span className="text-muted-foreground">Option held until:</span> <b>{new Date(`${data.carrier.read.option_until}T12:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}{data.carrier.read.option_until_time ? `, ${data.carrier.read.option_until_time}` : ""}</b>. The deposit is due by then, or the cruise line releases the cabin.</p>}
              {data.carrier.read.warnings.map((w) => <p key={w} className="text-amber-700 flex items-start gap-1"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {w}</p>)}
            </div>
          )}
        </div>
      )}
      {!data.cabin && <p className="text-sm text-amber-700 flex items-center gap-1"><AlertTriangle className="w-4 h-4" /> This guest is not on a cabin in the group file. Place them on one first: <Link href={`/groups/${groupId}/details/travelers`} className="underline">the group's travelers</Link>.</p>}
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
                <Field label="Price ($, as the quote prints it)"><input className={input} inputMode="decimal" value={x.total} onChange={(e) => setX(i, "total", e.target.value)} disabled={sent} /></Field>
                {!sent && <button className={btn} aria-label="Remove this extra" onClick={() => { setExtras((v) => v.filter((_, j) => j !== i)); setDirty(true); }}><Trash2 className="w-3 h-3" /></button>}
              </div>
            ))}
          </div>
          <p className="text-sm mt-2">Total cruise price: <b>{usd(cruiseSum)}</b> <span className="text-muted-foreground">{guestPrices.length > 0
            ? `(${guestPrices.map((g) => `${g.name}: cruise ${usd(g.cruise)} + add-ons ${usd(g.addons)} + taxes ${usd(g.taxes)}${g.total != null ? ` = ${usd(g.total)}` : ""}`).join("; ")})`
            : `(cabin fare ${usd(amount(cabin["fare"]))} + extras ${usd(extrasSum)})`}</span></p>
          {quoteTotal != null && (Math.abs(quoteTotal - cruiseSum) < 0.005
            ? <p className="text-sm text-green-700 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Matches the quote's Total Booking Amount, {usd(quoteTotal)}.</p>
            : <p className="text-sm text-amber-700 flex items-center gap-1"><AlertTriangle className="w-4 h-4" /> The quote's Total Booking Amount is {usd(quoteTotal)}: this is {usd(Math.abs(round(quoteTotal - cruiseSum)))} {cruiseSum > quoteTotal ? "over" : "under"}.</p>)}
        </div>
      )}

      {/* Mark 2026-11-10: insurance is priced on the QUOTE, not asked on the guest's choices page: each plan and its price per person go here, and the
          guest picks one (or their own policy, or none) on the quote page before "Book It". */}
      </>)}
      {tab === "protection" && editing !== "protection" && (
        <div className={PAPER}>
          {editBtn("protection", "Edit the plans offered")}
          <H>Travel protection</H>
          <p className="text-base leading-7">{price?.protection?.label ? <>The guest chose: <b>{price.protection.label}</b></> : <span className="text-[#4a5a7a]">The guest has not chosen yet. They choose on their quote page.</span>}</p>

          {/* Mark 2026-11-13: once the guest has chosen, this page shows the chosen plan only; the list of plans offered is for before the choice. */}
          {!price?.protection?.label && (<>
          <H>Plans offered on the quote</H>
          {(data.protection ?? []).length === 0 && <p className="text-base font-bold text-red-600">No plans are offered on this quote yet.</p>}
          {(data.protection ?? []).map((p, n) => (
            <React.Fragment key={n}>{pay(
              <><b>{p.name}</b>{p.line ? <span className="text-[#4a5a7a]"> · the cruise line's plan</span> : /allianz/i.test(p.name) ? null : <span className="text-[#4a5a7a]"> · Allianz</span>}</>,
              p.total != null ? `${usd(p.total)} for the whole party` : p.per_person != null ? `${usd(p.per_person)} per person` : <span className="font-bold text-red-600">no price yet</span>,
            )}</React.Fragment>
          ))}
          {data.allianz?.status === "pending" && <p className="mt-3 text-base text-[#4a5a7a]">Allianz is being asked for this trip's prices.</p>}
          {data.allianz?.status === "unavailable" && <p className="mt-3 text-base font-bold text-[#8a5f00]">Allianz's prices could not be fetched{data.allianz.reason ? `: ${data.allianz.reason}` : ""}.</p>}
          </>)}
        </div>
      )}
      {tab === "protection" && editing === "protection" && (
      <div>
      <div className="mb-3">{backBtn("Back to travel protection")}</div>
        <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
          <h4 className="text-sm font-semibold">Travel protection (the guest picks one on the quote)</h4>
          {!sent && <button className={btn} onClick={() => { setPlans((x) => [...x, { name: "", price: "", party: false, line: false }]); setDirty(true); }}><Plus className="w-3 h-3" /> plan</button>}
        </div>
        {guestPrices.some((g) => g.insurance > 0) && <p className="text-sm text-muted-foreground">The cruise line's quote already has its protection plan in the price ({guestPrices.map((g) => `${g.name}: ${usd(g.insurance)}`).join("; ")}). It shows on the quote as printed; do not add it again here.</p>}
        {/* Mark 2026-11-13: "i do not need to see this twice. use the bottom lines and add a check box to select it. and it is still missing the
            ships policy choices." ONE list: every plan Allianz returned for this trip, the cruise line's own plan, and any typed by hand, each on
            one line with a tick box. Ticked = offered on the guest's quote. The agent still asks Allianz by itself after a save. */}
        <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
          <p className="text-sm text-muted-foreground">
            {data.allianz?.status === "ready" ? <>Allianz priced this trip {when(data.allianz.quoted_at)}: {usd(data.allianz.trip_cost ?? 0)}, {data.allianz.travelers} traveler{data.allianz.travelers === 1 ? "" : "s"}. Tick the plans to offer.</>
              : data.allianz?.status === "pending" ? <span className="inline-flex items-center gap-1"><Loader2 className="w-4 h-4 animate-spin" /> Getting the Allianz prices… (about a minute)</span>
              : data.allianz?.status === "unavailable" ? <span className="font-semibold text-red-600">Allianz could not be priced: {data.allianz.reason ?? "no reason given"}. Nothing was made up.</span>
              : "Allianz has not been asked yet. Save the booking with the cruise and travel costs in, and the agent asks."}
          </p>
          {!sent && <button className={btn} disabled={busy || data.allianz?.status === "pending"} onClick={() => { if (dirty) { setAllianzStop(UNSAVED); return; } void askAllianz(true); }}>{data.allianz ? "Ask Allianz again" : "Ask Allianz now"}</button>}
        </div>
        {allianzStop && <p className="text-sm font-semibold text-red-600 mb-2">{allianzStop}</p>}
        {(() => {
          const same = (a: Plan, b: Plan) => a.name.trim().toLowerCase() === b.name.trim().toLowerCase() && a.line === b.line;
          const offered: Plan[] = (data.allianz?.status === "ready" ? data.allianz.plans : []).map((q) => ({ name: `${q.name} (Allianz)`, price: String(q.total), party: true, line: false }));
          const onFileRows: Plan[] = (data.protectionOnFile ?? []).filter((q) => q.line).map((q) => ({ name: q.name, price: String(q.per_person), party: false, line: true }));
          // the cruise line's own plan always has a line: its price is the cruise line's, typed in once it is ticked
          const lineRow: Plan[] = plans.some((x) => x.line) || onFileRows.length ? [] : [{ name: `${data.sheet?.trip.line ?? "The cruise line"} travel protection`, price: "", party: false, line: true }];
          const notOffered = [...offered, ...onFileRows, ...lineRow].filter((c) => !plans.some((x) => same(x, c)));
          const grid = "grid grid-cols-[2rem_1fr_8rem_11rem_10rem] gap-2 items-end";
          const tick = "h-5 w-5 mb-2";
          return (
            <div className="space-y-2">
              <div className={`${grid} text-xs text-muted-foreground`}><span>Offer</span><span>Plan</span><span>Quoted price ($)</span><span>The price is</span><span>This plan is from</span></div>
              {plans.map((x, i) => (
                <div key={`on${i}`} className={grid}>
                  <input type="checkbox" className={tick} checked aria-label={`${x.name || "This plan"} is offered on the quote`} disabled={sent} onChange={() => { setPlans((v) => v.filter((_, j) => j !== i)); setDirty(true); }} />
                  <input className={input} placeholder="Plan name" value={x.name} onChange={(e) => setPl(i, { name: e.target.value })} disabled={sent} />
                  <input className={`${input} ${x.price.trim() ? "" : "border-red-500"}`} inputMode="decimal" placeholder={x.line ? "the cruise line's price" : ""} value={x.price} onChange={(e) => setPl(i, { price: e.target.value })} disabled={sent} />
                  <select className={input} value={x.party ? "party" : "person"} onChange={(e) => setPl(i, { party: e.target.value === "party" })} disabled={sent}><option value="person">per person</option><option value="party">for the whole party</option></select>
                  <select className={input} value={x.line ? "line" : "allianz"} onChange={(e) => setPl(i, { line: e.target.value === "line" })} disabled={sent}><option value="allianz">Allianz</option><option value="line">the cruise line</option></select>
                </div>
              ))}
              {notOffered.map((c, i) => (
                <div key={`off${i}`} className={`${grid} opacity-80`}>
                  <input type="checkbox" className={tick} checked={false} aria-label={`Offer ${c.name} on the quote`} disabled={sent} onChange={() => { setPlans((v) => [...v.filter((r) => r.name.trim() || r.price.trim()), c]); setDirty(true); }} />
                  <p className="px-2 py-1 text-sm">{c.name}</p>
                  <p className="px-2 py-1 text-sm">{c.price ? usd(amount(c.price)) : <span className="text-muted-foreground">tick, then type it</span>}</p>
                  <p className="px-2 py-1 text-sm text-muted-foreground">{c.party ? "for the whole party" : "per person"}</p>
                  <p className="px-2 py-1 text-sm text-muted-foreground">{c.line ? "the cruise line" : "Allianz"}</p>
                </div>
              ))}
              <p className="text-sm text-muted-foreground">{plans.length === 0 ? "Nothing is ticked: the guest's quote has no travel protection to choose from." : `${plans.length} ticked: the guest chooses one of them, their own policy, or none, on their quote page.`}{(data.allianz?.hidden ?? 0) > 0 ? ` Not listed: ${data.allianz!.hidden} Allianz plans that are not for a single trip (annual, rental car, Professional Travel Program).` : ""}</p>
            </div>
          );
        })()}
      </div>
      )}
      {tab === "travel" && editing !== "travel" && (() => {
        const lines = data.doc?.travel ?? [], same = lines.length === data.trip.length;
        const unpriced = data.trip.filter((r) => r.price === null).length;
        return (
          <div className={PAPER}>
            {editBtn("travel", "Edit flights, hotels, transfers")}
            <H>Flights, hotels and transfers</H>
            {data.trip.length === 0 && <p className="text-base text-[#4a5a7a]">None on this booking.</p>}
            {data.trip.map((r, n) => (
              <div key={n} className="border-b border-[#dde5f1] py-3">
                {pay(<span className="text-lg font-extrabold">{r.kind === "package" ? `Air and hotel package, ${r.direction === "post" ? "after" : "before"} the cruise` : r.label}</span>,
                  r.price != null ? <b>{usd(Number(r.price))}</b> : <span className="font-bold text-red-600">no price yet</span>)}
                {r.provider && !(same && lines[n]!.details.some((x) => x.includes(r.provider!))) && <p className="text-base text-[#4a5a7a]">{r.provider}</p>}
                {same && lines[n]!.details.map((x, k) => <p key={k} className="text-base leading-7">{x}</p>)}
                {r.per === "person" && r.unit_price != null && <p className="text-base text-[#4a5a7a]">{usd(Number(r.unit_price))} per person × {party}</p>}
                <p className="text-base leading-7"><span className="text-[#4a5a7a]">Confirmation:</span> <b>{r.confirmation ?? missing}</b></p>
              </div>
            ))}
            {data.trip.length > 0 && pay("Travel total", unpriced === 0 && data.totals.travel != null ? usd(data.totals.travel) : <span className="text-red-600">not finished</span>, "total")}
          </div>
        );
      })()}
      {tab === "travel" && editing === "travel" && (
      <div>
      <div className="mb-3">{backBtn("Back to flights, hotels, transfers")}</div>
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
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  <Field label="Flight #"><input className={input} value={r.pkg?.flights ?? ""} onChange={(e) => setP(i, "flights", e.target.value)} disabled={sent} /></Field>
                  <Field label="From"><input className={input} value={r.from_place ?? ""} onChange={(e) => setT(i, "from_place", e.target.value)} disabled={sent} /></Field>
                  <Field label="To"><input className={input} value={r.to_place ?? ""} onChange={(e) => setT(i, "to_place", e.target.value)} disabled={sent} /></Field>
                  <Field label="Date"><input type="date" className={input} value={day(r.starts_at)} onChange={(e) => setT(i, "starts_at", e.target.value)} disabled={sent} /></Field>
                  <Field label="Departs (time)"><input type="time" className={input} value={r.pkg?.depart_time ?? ""} onChange={(e) => setP(i, "depart_time", e.target.value)} disabled={sent} /></Field>
                  <Field label="Arrives (time)"><input type="time" className={input} value={r.pkg?.arrive_time ?? ""} onChange={(e) => setP(i, "arrive_time", e.target.value)} disabled={sent} /></Field>
                </div>
                <p className="text-xs text-muted-foreground">Coming back</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  <Field label="Flight #"><input className={input} value={r.pkg?.return_flights ?? ""} onChange={(e) => setP(i, "return_flights", e.target.value)} disabled={sent} /></Field>
                  <Field label="From"><input className={input} value={r.pkg?.return_from ?? ""} onChange={(e) => setP(i, "return_from", e.target.value)} disabled={sent} /></Field>
                  <Field label="To"><input className={input} value={r.pkg?.return_to ?? ""} onChange={(e) => setP(i, "return_to", e.target.value)} disabled={sent} /></Field>
                  <Field label="Date"><input type="date" className={input} value={day(r.ends_at)} onChange={(e) => setT(i, "ends_at", e.target.value)} disabled={sent} /></Field>
                  <Field label="Departs (time)"><input type="time" className={input} value={r.pkg?.return_depart_time ?? ""} onChange={(e) => setP(i, "return_depart_time", e.target.value)} disabled={sent} /></Field>
                  <Field label="Arrives (time)"><input type="time" className={input} value={r.pkg?.return_arrive_time ?? ""} onChange={(e) => setP(i, "return_arrive_time", e.target.value)} disabled={sent} /></Field>
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
                  {perField(r, i)}
                </div>
                {perMath(r)}
              </div>
            </div>
          ) : (
            <div key={i} className="border rounded-md p-3 space-y-2">
              {/* Mark 2026-11-11 ("the page is now so cluttered"): each line is its own small card with its name on top, and a line with no price says so */}
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold">{r.kind === "flight" ? "Flight" : r.kind === "hotel" ? "Hotel" : "Transfer"}{r.label && !["Flight", "Hotel", "Transfer"].includes(r.label) ? `: ${r.label}` : ""}
                  {(r.price === null || String(r.price).trim() === "") && <span className="ml-2 text-xs font-semibold text-red-500">no quoted price yet</span>}</p>
                {!sent && <button className={btn} aria-label="Remove this line" onClick={() => { setTrip((t) => t.filter((_, j) => j !== i)); setDirty(true); }}><Trash2 className="w-3 h-3" /> Remove</button>}
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Field label="Before or after the cruise">
                <select className={input} value={r.direction ?? "pre"} onChange={(e) => setT(i, "direction", e.target.value)} disabled={sent}><option value="pre">Before the cruise</option><option value="post">After the cruise</option></select>
              </Field>
              <Field label={r.kind === "hotel" ? "Hotel" : r.kind === "flight" ? "Airline" : "Company"}><input className={input} value={r.provider ?? ""} onChange={(e) => setT(i, "provider", e.target.value)} disabled={sent} /></Field>
              <Field label={r.kind === "hotel" ? "City" : "From"}><input className={input} value={r.from_place ?? ""} onChange={(e) => setT(i, "from_place", e.target.value)} disabled={sent} /></Field>
              <Field label="To"><input className={input} value={r.to_place ?? ""} onChange={(e) => setT(i, "to_place", e.target.value)} disabled={sent} /></Field>
              <Field label={r.kind === "hotel" ? "Check in" : "Date"}><input type="date" className={input} value={day(r.starts_at)} onChange={(e) => setT(i, "starts_at", e.target.value)} disabled={sent} /></Field>
              <Field label={r.kind === "hotel" ? "Check out" : "Arrives"}><input type="date" className={input} value={day(r.ends_at)} onChange={(e) => setT(i, "ends_at", e.target.value)} disabled={sent} /></Field>
              <Field label="Confirmation #"><input className={input} value={r.confirmation ?? ""} onChange={(e) => setT(i, "confirmation", e.target.value)} disabled={sent} /></Field>
              <Field label="Quoted price ($)"><input className={`${input} ${r.price === null || String(r.price).trim() === "" ? "border-red-500" : ""}`} inputMode="decimal" value={r.price ?? ""} onChange={(e) => setT(i, "price", e.target.value)} disabled={sent} /></Field>
              {perField(r, i)}
              </div>
              {perMath(r)}
            </div>
          ))}
        </div>
        {trip.length > 0 && <p className="text-sm mt-2">Travel total for the booking: <b>{usd(travelSum)}</b> · Trip total for the booking (cruise and travel, {party} traveler{party === 1 ? "" : "s"}): <b>{usd(round(cruiseSum + travelSum))}</b></p>}
      </div>

      )}

      {tab === "paperwork" && (
      <div className="rounded-md border p-3 space-y-1">
        <h4 className="text-sm font-semibold">What the paperwork will say</h4>
        {data.fills.map((f, i) => <p key={i} className="text-sm"><span className="text-muted-foreground">{f.label}:</span> {f.value || <em className="text-amber-700">not entered yet</em>}</p>)}
      </div>
      )}

      {sent && tab === "quote" && <p className="text-sm flex items-center gap-1 text-green-700"><CheckCircle2 className="w-4 h-4" /> The guest approved the quote and the paperwork is out. Nothing more to send from here.</p>}
      {sent && tab === "paperwork" && (
        <div className="space-y-3">
          <p className="text-sm flex items-center gap-1 text-green-700"><CheckCircle2 className="w-4 h-4" /> {SENT[data.paperwork] ?? "Paperwork sent"}.</p>
          {data.signed && (
            <div className="rounded-md border p-3 space-y-2">
              <h4 className="text-sm font-semibold">2. Signed documents: {data.signed.signed} of {data.signed.required} back</h4>
              <p className="text-sm text-muted-foreground">Each signed copy is stored on this file the moment it is signed (private storage; passport details encrypted).</p>
              {data.signed.docs.length === 0 && <p className="text-sm text-muted-foreground">Nothing signed yet.</p>}
              {data.signed.docs.map((d) => (
                <p key={d.id} className="text-sm flex items-center gap-2 flex-wrap">{d.title}{d.signer ? ` · ${d.signer}` : ""}
                  {d.has_pdf && <button className={btn} onClick={() => viewSigned(d.id)}><Eye className="w-3 h-3" /> View</button>}
                  {d.has_pdf && <button className={btn} onClick={() => downloadSigned(d.id, d.title)}><Download className="w-3 h-3" /> Download</button>}</p>
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
                  <p className="text-sm text-muted-foreground">This guest asked for FlexPay. The scheduler pops up on their quote page the moment they say yes: they pick a video call from your open times (Monday to Saturday, 10 AM to 8 PM Eastern, never over a meeting on your calendar). You schedule nothing, and no separate email is needed: their own quote link opens the scheduler again. Then you make the payments.</p>
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
      )}
      {/* Mark 2026-11-09: the guest confirms the price by email before the paperwork goes out */}
      {!sent && tab === "quote" && (
          <div className="rounded-md border p-3 space-y-2">
            <h4 className="text-sm font-semibold">Confirm the quote with {data.guest.name}</h4>
            <p className="text-sm text-muted-foreground">Email the quote to the guest. The email has two buttons: "Book It" and "I need changes" (a box opens for what they want changed). The paperwork waits for their yes.</p>
            {approved ? (
              <p className="text-sm flex items-center gap-1 text-green-700"><CheckCircle2 className="w-4 h-4" /> Price approved {price?.approved_how === "mark" ? "(you recorded their yes)" : "by the guest (Book It)"} · {when(price?.approved_at)}. Book it, enter the confirmation numbers, then send the paperwork.{price?.protection ? ` Travel protection they picked: ${price.protection.label}.` : ""}</p>
            ) : price?.changes_open ? (
              <div className="text-sm text-amber-700">
                <p className="font-semibold">The guest asked for changes · {when(price.changes[price.changes.length - 1]?.at)}:</p>
                <p className="whitespace-pre-wrap">"{price.changes[price.changes.length - 1]?.text}"</p>
                <p>Re-quote, update the confirmation above, save, then email the price again.</p>
              </div>
            ) : price?.sent_at ? (
              <p className="text-sm text-muted-foreground">{price.sent === "sent" ? `Quote emailed · ${when(price.sent_at)}. Waiting on the guest.` : `The last try did NOT go out (${SENT[price.sent ?? ""] ?? price.sent}) · ${when(price.sent_at)}. Send it again.`}</p>
            ) : (
              <p className="text-sm text-muted-foreground">Not sent yet.</p>
            )}
            <div className="flex flex-wrap gap-2 items-center">
              <button className={btn} disabled={busy} onClick={previewPrice}>Preview the quote email</button>
              <button className={`${btn} ${approved ? "" : "bg-primary text-primary-foreground"}`} disabled={busy} onClick={emailPrice}><Send className="w-3 h-3" /> {price?.sent_at ? "Email the quote again" : `Email the quote to ${data.guest.name}`}</button>
              {!approved && <button className={btn} disabled={busy} onClick={recordYes}><CheckCircle2 className="w-3 h-3" /> They said yes another way</button>}
            </div>
          </div>
      )}
      {!sent && tab === "paperwork" && (
          <div className="space-y-2">
            {data.missing.length > 0 && <ul className="text-sm text-amber-700 list-disc pl-5">{data.missing.map((m) => <li key={m}>{m}</li>)}</ul>}
            <button className={`${btn} ${approved ? "bg-primary text-primary-foreground" : ""}`} disabled={busy} onClick={send}><Send className="w-3 h-3" /> Send the paperwork to {data.guest.name}</button>
            {!approved && <span className="text-xs text-muted-foreground ml-2">Waits for the price approval.</span>}
          </div>
      )}
      </div>
      {/* The save bar stays at the bottom of the screen on every tab: one button, always in the same place. */}
      {!sent && (dirty || (editing !== null && editing === tab)) && (
        <div data-save-bar className="sticky -bottom-4 md:-bottom-6 z-10 flex items-center justify-between gap-3 flex-wrap border-t bg-card px-4 py-3 rounded-b-lg shadow-[0_-4px_12px_rgba(0,0,0,0.25)]">
          <p className={`text-sm font-medium ${dirty ? "text-amber-500" : "text-muted-foreground"}`}>{dirty ? "You have changes on this booking that are not saved." : "Everything on this booking is saved."}</p>
          <button className="text-base font-semibold px-6 py-2.5 rounded-md bg-primary text-primary-foreground disabled:opacity-50 inline-flex items-center gap-2" disabled={busy || !dirty} onClick={save}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} {dirty ? "Save the confirmation" : "Saved"}
          </button>
        </div>
      )}
    </div>
  );
}
