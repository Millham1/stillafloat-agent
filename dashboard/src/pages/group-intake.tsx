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
};

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...authHeaders() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.error || `Request failed (${r.status})`);
  return json as T;
}

const STATUS_TEXT: Record<Intake["status"], string> = {
  queued: "Waiting to start…",
  reading: "Reading the PDF…",
  extracting: "Picking out the booking details…",
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

export default function GroupIntake() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [kind, setKind] = useState<"group" | "individual">("group");
  const [lang, setLang] = useState<"en" | "es" | "both">("en");
  const [uploading, setUploading] = useState(false);
  const [intakeId, setIntakeId] = useState<string | null>(null);
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
  });
  const intake = data?.intake;
  const found = new Set(data?.found ?? []);
  const shownKeys = [...FIELDS.map((f) => f.key), "notes", "cabin_categories", "amenities", "itinerary"];
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
      const r = await api<{ group: Row; cabins: number; payments: number }>(`/groups/intake/${intakeId}/accept`, "POST", { group });
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
  const cats: Row[] = Array.isArray(form.cabin_categories) ? form.cabin_categories : [];

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
              <span className="text-muted-foreground">— {STATUS_TEXT[intake.status]}</span>
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
                <input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="American Legion — Carnival Celebration, March 2027" />
              </label>
              {FIELDS.map((f) => (
                <label key={f.key} className="text-xs text-muted-foreground">
                  {f.label} {found.has(f.key) ? <span className="text-green-600">· from the document</span> : <span className="text-amber-600">· not found</span>}
                  <input className={inputCls} type={f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}
                    value={form[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} />
                </label>
              ))}
              <label className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">
                Notes from the document {found.has("notes") ? <span className="text-green-600">· from the document</span> : <span className="text-amber-600">· not found</span>}
                <textarea className={inputCls} rows={3} value={form.notes ?? ""} onChange={(e) => set("notes", e.target.value)} />
              </label>
            </div>
          </Card>

          <div className="grid md:grid-cols-2 gap-4">
            <Card>
              <div className="px-4 py-3 border-b"><h3 className="font-semibold">Cabin categories {found.has("cabin_categories") ? <span className="text-xs text-green-600 font-normal">· from the document</span> : <span className="text-xs text-amber-600 font-normal">· not found</span>}</h3></div>
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-muted/30 text-muted-foreground"><th className="text-left px-3 py-2">Type</th><th className="text-left px-3 py-2">Code</th><th className="text-right px-3 py-2">Cabins</th><th className="text-right px-3 py-2">Per person</th><th className="text-right px-3 py-2">Deposit pp</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {cats.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-muted-foreground">None listed. {kind === "group" ? `${form.cabins_held || 0} held cabin(s) will be opened without a type.` : "One cabin will be opened."}</td></tr>}
                  {cats.map((c, i) => (
                    <tr key={i}><td className="px-3 py-2">{c.category ?? "—"}</td><td className="px-3 py-2">{c.code ?? "—"}</td><td className="px-3 py-2 text-right">{c.count ?? "—"}</td><td className="px-3 py-2 text-right">{c.price_per_person ?? "—"}</td><td className="px-3 py-2 text-right">{c.deposit_per_person ?? "—"}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="px-3 py-2 text-xs text-muted-foreground">Per-person prices become per-cabin totals (two guests) on the file. Adjust any cabin afterward.</p>
            </Card>
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
