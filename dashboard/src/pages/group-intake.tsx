import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft, FileText, Loader2, CheckCircle2, AlertTriangle, RotateCw } from "lucide-react";
import { authHeaders } from "@/lib/auth-token";
import { useToast } from "@/hooks/use-toast";

// Enter a booking: drop the line's contract or quote → the server reads it →
// review what it read (each field says "from the document" or "not found") →
// Save opens the group file with cabins and the payment schedule built.

type Row = Record<string, any>;
type Intake = {
  id: string; booking_kind: "group" | "individual"; lang: "en" | "es" | "both"; filename: string;
  status: "queued" | "reading" | "extracting" | "ready" | "accepted" | "failed";
  text_chars: number | null; extracted: Row | null; error: string | null; group_id: string | null;
  model: string | null; created_at: string; updated_at: string;
};

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...authHeaders() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error("This browser's access token was not accepted. Open the sign-in link again.");
  if (!r.ok) throw new Error(json?.error || `Request failed (${r.status})`);
  return json as T;
}

const STATUS_TEXT: Record<Intake["status"], string> = {
  queued: "Waiting to start…",
  reading: "Reading the PDF…",
  extracting: "Picking out the booking details on the AI box. A full quote takes about two minutes; you can leave this page and come back.",
  ready: "Read. Check the details below.",
  accepted: "Saved to a group file.",
  failed: "Could not read this document.",
};

type Field = { key: string; label: string; type?: "text" | "date" | "number" };
const FIELDS: Field[] = [
  { key: "cruise_line", label: "Cruise line" },
  { key: "ship_name", label: "Ship" },
  { key: "sail_date", label: "Sail date", type: "date" },
  { key: "return_date", label: "Return date", type: "date" },
  { key: "nights", label: "Nights", type: "number" },
  { key: "embark_port", label: "Sails from" },
  { key: "group_number", label: "Line's group number" },
  { key: "cabins_held", label: "Cabins held", type: "number" },
  { key: "deposit_per_person", label: "Deposit per person ($)", type: "number" },
  { key: "deposit_due", label: "Deposit deadline", type: "date" },
  { key: "names_due", label: "Names due to the line", type: "date" },
  { key: "final_payment_due", label: "Final payment deadline", type: "date" },
  { key: "recall_date", label: "Unsold cabins go back", type: "date" },
  { key: "organizer_name", label: "Organizer" },
];

const inputCls = "mt-1 w-full px-3 py-1.5 text-sm rounded-md border bg-card text-foreground";

type TransferRoute = "airport_to_hotel" | "hotel_to_port" | "port_to_airport";
const TRANSFER_ROUTES: Array<{ route: TransferRoute; label: string; direction: "pre" | "post"; from: string; to: string }> = [
  { route: "airport_to_hotel", label: "Airport → hotel", direction: "pre", from: "Airport", to: "Hotel" },
  { route: "hotel_to_port", label: "Hotel → cruise port", direction: "pre", from: "Hotel", to: "Cruise port" },
  { route: "port_to_airport", label: "Cruise port → airport", direction: "post", from: "Cruise port", to: "Airport" },
];
type Tri = "" | "yes" | "no";
type TravelForm = {
  air: { offered: boolean; included: Tri; description: string; from_city: string; price_per_person: string };
  hotel_before: { offered: boolean; included: Tri; name: string; city: string; nights: string; price_per_person: string };
  transfers: Array<{ route: TransferRoute; offered: boolean; included: Tri; provider: string; price_per_person: string }>;
};
const tri = (v: unknown): Tri => (v === "yes" || v === "no" ? v : v === true ? "yes" : v === false ? "no" : "");
const txt = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
/** The reader's travel_package (or a half-edited form) → the form's shape. */
function normalizeTravelForm(v: unknown): TravelForm {
  const x = (v && typeof v === "object" ? v : {}) as Row;
  const a = (x.air && typeof x.air === "object" ? x.air : null) as Row | null;
  const h = (x.hotel_before && typeof x.hotel_before === "object" ? x.hotel_before : null) as Row | null;
  const ts = Array.isArray(x.transfers) ? (x.transfers as Row[]) : [];
  return {
    air: { offered: a ? (a.offered ?? true) : false, included: tri(a?.included), description: txt(a?.description), from_city: txt(a?.from_city), price_per_person: txt(a?.price_per_person) },
    hotel_before: { offered: h ? (h.offered ?? true) : false, included: tri(h?.included), name: txt(h?.name), city: txt(h?.city), nights: txt(h?.nights), price_per_person: txt(h?.price_per_person) },
    transfers: TRANSFER_ROUTES.map((r) => {
      const t = ts.find((y) => y.route === r.route);
      return { route: r.route, offered: t ? (t.offered ?? true) : false, included: tri(t?.included), provider: txt(t?.provider), price_per_person: txt(t?.price_per_person) };
    }),
  };
}
/** The form → group_travel rows (group-level: no traveler, no cabin). Only offers that are switched on. */
function travelRows(tp: TravelForm): Row[] {
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  const inc = (t: Tri) => t === "yes";
  const rows: Row[] = [];
  if (tp.air.offered) rows.push({ kind: "flight", direction: "pre", provider: tp.air.description || null, from_place: tp.air.from_city || null, price_per_person: num(tp.air.price_per_person), included: inc(tp.air.included), source: "quote" });
  if (tp.hotel_before.offered) rows.push({ kind: "hotel", direction: "pre", provider: tp.hotel_before.name || null, from_place: tp.hotel_before.city || null, reference: tp.hotel_before.nights ? `${tp.hotel_before.nights} night${tp.hotel_before.nights === "1" ? "" : "s"}` : null, price_per_person: num(tp.hotel_before.price_per_person), included: inc(tp.hotel_before.included), source: "quote" });
  for (const t of tp.transfers) {
    if (!t.offered) continue;
    const r = TRANSFER_ROUTES.find((x) => x.route === t.route)!;
    rows.push({ kind: "transfer", direction: r.direction, provider: t.provider || null, from_place: r.from, to_place: r.to, price_per_person: num(t.price_per_person), included: inc(t.included), source: "quote" });
  }
  return rows;
}

/** 2027-02-24 → Wed, Feb 24, 2027 */
function day(d: string | null | undefined): string {
  if (!d) return "—";
  const t = new Date(`${d}T12:00:00Z`);
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
const usd = (n: unknown) => (typeof n === "number" ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—");

export default function GroupIntake() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [kind, setKind] = useState<"group" | "individual">("group");
  const [lang, setLang] = useState<"en" | "es" | "both">("en");
  const [uploading, setUploading] = useState(false);
  // The read is kept in the address (?intake=…) so leaving the page, or a reload,
  // comes back to the same document instead of an empty drop zone.
  const [intakeId, setIntakeIdState] = useState<string | null>(() => new URLSearchParams(window.location.search).get("intake"));
  const setIntakeId = (id: string | null) => {
    setIntakeIdState(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("intake", id); else url.searchParams.delete("intake");
    window.history.replaceState(null, "", url);
  };
  const [form, setForm] = useState<Row>({});
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data } = useQuery<{ intake: Intake; found: string[] }>({
    queryKey: ["group-intake", intakeId],
    queryFn: () => api(`/groups/intake/${intakeId}`),
    enabled: !!intakeId,
    refetchInterval: (q) => {
      const s = q.state.data?.intake.status;
      return s === "ready" || s === "failed" || s === "accepted" ? false : 2500;
    },
    refetchIntervalInBackground: true,
  });
  const intake = data?.intake;
  const found = new Set(data?.found ?? []);
  const shownKeys = [...FIELDS.map((f) => f.key), "cabin_categories", "amenities", "itinerary", "allotment_reviews", "cancellation_schedule", "travel_package"];
  const foundShown = shownKeys.filter((k) => found.has(k)).length;

  // When the reader finishes, seed the form from what it read.
  useEffect(() => {
    if (intake?.status === "ready" && intake.extracted && Object.keys(form).length === 0) {
      const x = intake.extracted;
      const guess = [x.organizer_name, x.ship_name, x.sail_date ? String(x.sail_date).slice(0, 7) : null].filter(Boolean).join(" — ");
      setForm({ name: guess, ...x });
    }
  }, [intake?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) { toast({ variant: "destructive", title: "PDF only", description: "Drop the contract or quote as a PDF." }); return; }
    setUploading(true);
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error("Could not read the file"));
        r.readAsDataURL(file);
      });
      const res = await api<{ intake: Intake }>("/groups/intake", "POST", { booking_kind: kind, lang, filename: file.name, data: b64 });
      setForm({});
      setIntakeId(res.intake.id);
    } catch (e) {
      toast({ variant: "destructive", title: "Upload failed", description: (e as Error).message });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  // Air, hotel before and transfers (Mark 2026-10-10): prefilled from the quote when it prints them, typed in otherwise.
  const tp: TravelForm = normalizeTravelForm(form.travel_package);
  const setTp = (next: TravelForm) => set("travel_package", next);
  const setAir = (k: keyof TravelForm["air"], v: unknown) => setTp({ ...tp, air: { ...tp.air, [k]: v } });
  const setHotel = (k: keyof TravelForm["hotel_before"], v: unknown) => setTp({ ...tp, hotel_before: { ...tp.hotel_before, [k]: v } });
  const setTransfer = (route: TransferRoute, k: "included" | "provider" | "price_per_person", v: unknown) =>
    setTp({ ...tp, transfers: tp.transfers.map((t) => (t.route === route ? { ...t, [k]: v } : t)) });

  const save = async () => {
    if (!intakeId) return;
    setSaving(true);
    try {
      const group: Row = { name: form.name, lang: form.lang ?? lang };
      for (const f of FIELDS) {
        const v = form[f.key];
        group[f.key] = v === "" || v === undefined ? null : f.type === "number" ? Number(v) : v;
      }
      group.notes = form.notes ?? null;
      group.itinerary = form.itinerary ?? [];
      group.amenities = form.amenities ?? [];
      const travel = travelRows(tp);
      const r = await api<{ group: Row; cabins: number; payments: number; travel: number }>(`/groups/intake/${intakeId}/accept`, "POST", { group, travel });
      toast({ title: "Group file opened", description: `${r.cabins} cabin${r.cabins === 1 ? "" : "s"} and ${r.payments} payment line${r.payments === 1 ? "" : "s"} created.` });
      navigate(`/groups/${r.group.id}`);
    } catch (e) {
      toast({ variant: "destructive", title: "Not saved", description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const retry = async () => {
    if (!intakeId) return;
    try { await api(`/groups/intake/${intakeId}/retry`, "POST", {}); setForm({}); }
    catch (e) { toast({ variant: "destructive", title: "Could not retry", description: (e as Error).message }); }
  };

  const busy = intake && (intake.status === "queued" || intake.status === "reading" || intake.status === "extracting");
  // Minutes since the upload, so a long read shows progress instead of a bare spinner.
  const [, tick] = useState(0);
  useEffect(() => { if (!busy) return; const t = setInterval(() => tick((n) => n + 1), 15_000); return () => clearInterval(t); }, [busy]);
  const minutes = intake ? Math.floor((Date.now() - Date.parse(intake.created_at)) / 60_000) : 0;
  const cats: Row[] = Array.isArray(form.cabin_categories) ? form.cabin_categories : [];
  const list = (k: string): Row[] => (Array.isArray(form[k]) ? form[k] : []);
  const warnings: string[] = Array.isArray(form.warnings) ? form.warnings : [];
  const reviews = list("allotment_reviews");
  const penalties = list("cancellation_schedule");
  const deadlines = list("deadlines");
  const extraPrices = cats.some((c) => c.commissionable_fare != null || c.price_third_fourth_adult != null);
  // Why a date field is blank, when the document explains it.
  const hint = (key: string): string | null =>
    key === "deposit_due" && form.deposit_timing === "at_booking" ? "due when each cabin is booked; the document sets no calendar date"
      : key === "final_payment_due" && form.final_payment_days_before ? `${form.final_payment_days_before} days before sailing`
      : key === "recall_date" && reviews.length ? "the last review date below"
      : null;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <Link href="/groups"><span className="text-xs text-muted-foreground flex items-center gap-1 cursor-pointer hover:text-foreground"><ArrowLeft className="w-3.5 h-3.5" /> All groups</span></Link>
        <h2 className="text-xl font-bold tracking-tight mt-1">Enter a booking</h2>
        <p className="text-sm text-muted-foreground mt-0.5">Drop the cruise line's contract or quote. The details are read out of it for you to check before anything is saved.</p>
      </div>

      <Card className="p-4">
        <CardContent className="p-0 space-y-4">
          <div className="flex gap-6 flex-wrap">
            <div>
              <div className="text-xs text-muted-foreground mb-1">What is this?</div>
              <div className="flex rounded-md border overflow-hidden">
                {(["group", "individual"] as const).map((k) => (
                  <button key={k} onClick={() => setKind(k)} disabled={!!intakeId}
                    className={`px-4 py-1.5 text-sm capitalize ${kind === k ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground"}`}>
                    {k === "group" ? "Group booking" : "Individual booking"}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Client language</div>
              <div className="flex rounded-md border overflow-hidden">
                {([["en", "English"], ["es", "Spanish"], ["both", "Both"]] as const).map(([v, label]) => (
                  <button key={v} onClick={() => setLang(v)} disabled={!!intakeId}
                    className={`px-4 py-1.5 text-sm ${lang === v ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground"}`}>{label}</button>
                ))}
              </div>
            </div>
          </div>

          {!intakeId && (
            <label
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); void pick(e.dataTransfer.files?.[0]); }}
              className="flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-lg px-6 py-10 cursor-pointer hover:border-foreground/40"
            >
              {uploading ? <Loader2 className="w-6 h-6 animate-spin" /> : <FileText className="w-6 h-6 text-muted-foreground" />}
              <span className="text-sm">{uploading ? "Uploading…" : "Drop the PDF here, or click to choose it"}</span>
              <span className="text-xs text-muted-foreground">PDF only, up to 20 MB. It is stored privately and filed on the group.</span>
              <input ref={fileRef} type="file" accept="application/pdf" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
            </label>
          )}

          {intake && (
            <div className="flex items-center gap-2 text-sm">
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              {intake.status === "ready" && <CheckCircle2 className="w-4 h-4 text-green-500" />}
              {intake.status === "failed" && <AlertTriangle className="w-4 h-4 text-red-500" />}
              <span className="font-medium">{intake.filename}</span>
              <span className="text-muted-foreground">— {STATUS_TEXT[intake.status]}{busy && minutes >= 1 ? ` (${minutes} min so far)` : ""}</span>
              {intake.status === "ready" && intake.model && <span className="text-muted-foreground">Read by: {intake.model}</span>}
              {intake.status === "failed" && (
                <>
                  <span className="text-red-600">{intake.error}</span>
                  <button onClick={retry} className="ml-2 flex items-center gap-1 text-xs px-2 py-1 rounded border"><RotateCw className="w-3 h-3" /> Try again</button>
                </>
              )}
              {!busy && <button onClick={() => { setIntakeId(null); setForm({}); }} className="ml-auto text-xs px-2 py-1 rounded border">Start over</button>}
            </div>
          )}
        </CardContent>
      </Card>

      {intake?.status === "ready" && Object.keys(form).length > 0 && (
        <>
          {warnings.length > 0 && (
            <Card className="border-amber-500/60">
              <div className="px-4 py-3 border-b flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-500" /><h3 className="font-semibold">Check these against the PDF</h3></div>
              <ul className="list-disc pl-9 pr-4 py-3 text-sm space-y-1">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </Card>
          )}
          <Card>
            <div className="px-4 py-3 border-b flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h3 className="font-semibold">What the document says</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{foundShown} of {shownKeys.length} fields found. Anything marked "not found" is blank on purpose — fill it in if you know it.</p>
              </div>
              <button onClick={save} disabled={saving || !String(form.name ?? "").trim()}
                className="text-sm px-4 py-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-50">
                {saving ? "Saving…" : "Save and open the group file"}
              </button>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-3 p-4">
              <label className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">
                Group file name <span className="text-amber-600">(you choose)</span>
                <input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="Type a name for this file" />
              </label>
              {FIELDS.map((f) => (
                <label key={f.key} className="text-xs text-muted-foreground">
                  {f.label} {found.has(f.key) ? <span className="text-green-600">· from the document{hint(f.key) ? ` (${hint(f.key)})` : ""}</span>
                    : hint(f.key) ? <span className="text-sky-600">· {hint(f.key)}</span> : <span className="text-amber-600">· not found</span>}
                  <input className={inputCls} type={f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}
                    value={form[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} />
                </label>
              ))}
              <label className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">
                Notes {found.has("notes") ? <span className="text-green-600">· from the document</span> : <span>(yours; saved on the group file)</span>}
                <textarea className={inputCls} rows={3} value={form.notes ?? ""} onChange={(e) => set("notes", e.target.value)} />
              </label>
            </div>
          </Card>

          <Card>
            <div className="px-4 py-3 border-b"><h3 className="font-semibold">Cabin categories and prices {found.has("cabin_categories") ? <span className="text-xs text-green-600 font-normal">· from the document</span> : <span className="text-xs text-amber-600 font-normal">· not found</span>}</h3></div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-muted/30 text-muted-foreground">
                  <th className="text-left px-3 py-2">Type</th><th className="text-left px-3 py-2">Code</th><th className="text-right px-3 py-2">Cabins</th>
                  <th className="text-right px-3 py-2">Price per person</th>
                  {extraPrices && <><th className="text-right px-3 py-2">3rd/4th adult</th><th className="text-right px-3 py-2">3rd/4th child</th><th className="text-right px-3 py-2">Junior child</th>
                    <th className="text-right px-3 py-2">Commissionable fare</th><th className="text-right px-3 py-2">Non-comm. fare</th><th className="text-right px-3 py-2">Taxes</th></>}
                  <th className="text-right px-3 py-2">Deposit per person</th>
                </tr></thead>
                <tbody className="divide-y divide-border">
                  {cats.length === 0 && <tr><td colSpan={11} className="px-3 py-4 text-muted-foreground">None listed. {kind === "group" ? `${form.cabins_held || 0} held cabin(s) will be opened without a type.` : "One cabin will be opened."}</td></tr>}
                  {cats.map((c, i) => (
                    <tr key={i}><td className="px-3 py-2">{c.category ?? "—"}</td><td className="px-3 py-2">{c.code ?? "—"}</td><td className="px-3 py-2 text-right">{c.count ?? "—"}</td>
                      <td className="px-3 py-2 text-right font-medium">{usd(c.price_per_person)}</td>
                      {extraPrices && <><td className="px-3 py-2 text-right">{usd(c.price_third_fourth_adult)}</td><td className="px-3 py-2 text-right">{usd(c.price_child)}</td><td className="px-3 py-2 text-right">{usd(c.price_junior_child)}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{usd(c.commissionable_fare)}</td><td className="px-3 py-2 text-right text-muted-foreground">{usd(c.ncf)}</td><td className="px-3 py-2 text-right text-muted-foreground">{usd(c.taxes)}</td></>}
                      <td className="px-3 py-2 text-right">{usd(c.deposit_per_person)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-3 py-2 text-xs text-muted-foreground">Prices are per person with taxes and fees in. On the file each cabin is priced for two guests. Adjust any cabin afterward.</p>
          </Card>

          <Card>
            <div className="px-4 py-3 border-b"><h3 className="font-semibold">Air, hotel before and transfers {found.has("travel_package") ? <span className="text-xs text-green-600 font-normal">· from the document</span> : <span className="text-xs text-amber-600 font-normal">· not in the document — type what you offer the group</span>}</h3></div>
            <CardContent className="p-4 space-y-4 text-sm">
              <div className="grid md:grid-cols-2 gap-4">
                <div className="rounded-md border p-3 space-y-2">
                  <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={tp.air.offered} onChange={(e) => setAir("offered", e.target.checked)} /> Airfare</label>
                  {tp.air.offered && <>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-xs text-muted-foreground">From city<input className={inputCls} value={tp.air.from_city} onChange={(e) => setAir("from_city", e.target.value)} /></label>
                      <label className="text-xs text-muted-foreground">Price per person ($)<input className={inputCls} type="number" step="0.01" value={tp.air.price_per_person} onChange={(e) => setAir("price_per_person", e.target.value)} /></label>
                    </div>
                    <label className="text-xs text-muted-foreground">Airline / details<input className={inputCls} value={tp.air.description} onChange={(e) => setAir("description", e.target.value)} /></label>
                    <label className="text-xs text-muted-foreground">Included in the cruise price?<select className={inputCls} value={tp.air.included} onChange={(e) => setAir("included", e.target.value)}><option value="">—</option><option value="yes">Yes, included</option><option value="no">No, add-on</option></select></label>
                  </>}
                </div>
                <div className="rounded-md border p-3 space-y-2">
                  <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={tp.hotel_before.offered} onChange={(e) => setHotel("offered", e.target.checked)} /> Hotel the night before</label>
                  {tp.hotel_before.offered && <>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-xs text-muted-foreground">Hotel<input className={inputCls} value={tp.hotel_before.name} onChange={(e) => setHotel("name", e.target.value)} /></label>
                      <label className="text-xs text-muted-foreground">City<input className={inputCls} value={tp.hotel_before.city} onChange={(e) => setHotel("city", e.target.value)} /></label>
                      <label className="text-xs text-muted-foreground">Nights<input className={inputCls} type="number" min="1" value={tp.hotel_before.nights} onChange={(e) => setHotel("nights", e.target.value)} /></label>
                      <label className="text-xs text-muted-foreground">Price per person ($)<input className={inputCls} type="number" step="0.01" value={tp.hotel_before.price_per_person} onChange={(e) => setHotel("price_per_person", e.target.value)} /></label>
                    </div>
                    <label className="text-xs text-muted-foreground">Included in the cruise price?<select className={inputCls} value={tp.hotel_before.included} onChange={(e) => setHotel("included", e.target.value)}><option value="">—</option><option value="yes">Yes, included</option><option value="no">No, add-on</option></select></label>
                  </>}
                </div>
              </div>
              <div className="rounded-md border p-3 space-y-2">
                <div className="font-medium">Transfers</div>
                {tp.transfers.map((t) => {
                  const r = TRANSFER_ROUTES.find((x) => x.route === t.route)!;
                  return (
                    <div key={t.route} className="grid md:grid-cols-4 gap-2 items-end">
                      <label className="flex items-center gap-2"><input type="checkbox" checked={t.offered} onChange={(e) => setTp({ ...tp, transfers: tp.transfers.map((y) => (y.route === t.route ? { ...y, offered: e.target.checked } : y)) })} /> {r.label}</label>
                      {t.offered ? <>
                        <label className="text-xs text-muted-foreground">Company<input className={inputCls} value={t.provider} onChange={(e) => setTransfer(t.route, "provider", e.target.value)} /></label>
                        <label className="text-xs text-muted-foreground">Price per person ($)<input className={inputCls} type="number" step="0.01" value={t.price_per_person} onChange={(e) => setTransfer(t.route, "price_per_person", e.target.value)} /></label>
                        <label className="text-xs text-muted-foreground">Included?<select className={inputCls} value={t.included} onChange={(e) => setTransfer(t.route, "included", e.target.value)}><option value="">—</option><option value="yes">Yes, included</option><option value="no">No, add-on</option></select></label>
                      </> : <div className="md:col-span-3 text-xs text-muted-foreground">Not offered.</div>}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">Saved on the group file under Flights, hotels and transfers (as the group's offer, not per traveler) and shown on the group page and in the marketing package.</p>
            </CardContent>
          </Card>

          <div className="grid md:grid-cols-2 gap-4">
            <Card>
              <div className="px-4 py-3 border-b"><h3 className="font-semibold">When the line takes cabins back {reviews.length ? <span className="text-xs text-green-600 font-normal">· from the document</span> : <span className="text-xs text-amber-600 font-normal">· not found</span>}</h3></div>
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-muted/30 text-muted-foreground"><th className="text-left px-3 py-2">Date</th><th className="text-right px-3 py-2">Days before sailing</th><th className="text-right px-3 py-2">Unsold cabins taken back</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {reviews.length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-muted-foreground">The document lists no review dates.</td></tr>}
                  {reviews.map((r, i) => (
                    <React.Fragment key={i}>
                      <tr><td className="px-3 py-2">{day(r.date)}</td><td className="px-3 py-2 text-right">{r.days_before ?? "—"}</td><td className="px-3 py-2 text-right">{r.percent_retaken != null ? `${r.percent_retaken}%` : "—"}</td></tr>
                      {r.note && <tr><td colSpan={3} className="px-3 pb-2 text-xs text-muted-foreground">{r.note}</td></tr>}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card>
              <div className="px-4 py-3 border-b"><h3 className="font-semibold">Cancellation charges {penalties.length ? <span className="text-xs text-green-600 font-normal">· from the document</span> : <span className="text-xs text-amber-600 font-normal">· not found</span>}</h3></div>
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-muted/30 text-muted-foreground"><th className="text-left px-3 py-2">Cancel between</th><th className="text-right px-3 py-2">Days before sailing</th><th className="text-left px-3 py-2">Charge</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {penalties.length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-muted-foreground">The document lists no cancellation schedule.</td></tr>}
                  {penalties.length > 0 && penalties[0]!.from_date && <tr><td className="px-3 py-2">Before {day(penalties[0]!.from_date)}</td><td className="px-3 py-2 text-right">{penalties[0]!.from_days + 1} or more</td><td className="px-3 py-2">No charge stated</td></tr>}
                  {penalties.map((r, i) => (
                    <tr key={i}><td className="px-3 py-2">{day(r.from_date)} and {day(r.to_date)}</td><td className="px-3 py-2 text-right">{r.from_days} to {r.to_days}</td><td className="px-3 py-2">{r.penalty ?? (r.percent != null ? `${r.percent}%` : "—")}</td></tr>
                  ))}
                </tbody>
              </table>
              {form.cancellation_note && <p className="px-3 py-2 text-xs text-muted-foreground">{form.cancellation_note}</p>}
            </Card>
          </div>

          {deadlines.length > 0 && (
            <Card>
              <div className="px-4 py-3 border-b"><h3 className="font-semibold">Other deadlines in the document</h3></div>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-border">
                  {deadlines.map((d, i) => (
                    <tr key={i}><td className="px-3 py-2 whitespace-nowrap align-top">{day(d.date)}</td><td className="px-3 py-2 whitespace-nowrap align-top text-muted-foreground">{d.days_before} days before</td><td className="px-3 py-2">{d.text}</td></tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <div className="grid md:grid-cols-1 gap-4">
            <Card>
              <div className="px-4 py-3 border-b"><h3 className="font-semibold">Amenities and itinerary</h3></div>
              <CardContent className="p-4 space-y-3 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Amenities {found.has("amenities") ? "· from the document" : "· not found"}</div>
                  {(form.amenities ?? []).length === 0 ? <p className="text-muted-foreground">None listed.</p> : <ul className="list-disc pl-5">{(form.amenities as string[]).map((a, i) => <li key={i}>{a}</li>)}</ul>}
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Itinerary {found.has("itinerary") ? "· from the document" : "· not found"}</div>
                  {(form.itinerary ?? []).length === 0 ? <p className="text-muted-foreground">Not in the document; the sailings data can fill it later.</p> : (
                    <ol className="list-decimal pl-5">{(form.itinerary as Row[]).map((s, i) => <li key={i}>{s.port ?? "—"}{s.date ? ` · ${s.date}` : ""}{s.arrive || s.depart ? ` (${[s.arrive, s.depart].filter(Boolean).join("–")})` : ""}</li>)}</ol>
                  )}
                </div>
                {Array.isArray(form.travelers) && form.travelers.length > 0 && (
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Travelers named</div>
                    <ul className="list-disc pl-5">{(form.travelers as Row[]).map((t, i) => <li key={i}>{[t.first_name, t.last_name].filter(Boolean).join(" ")}</li>)}</ul>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
