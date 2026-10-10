import React, { useState } from "react";
import { Link, useRoute } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Ship, Plus, Trash2, ArrowLeft, AlertTriangle, CalendarClock, FileText } from "lucide-react";
import { authHeaders } from "@/lib/auth-token";
import { useToast } from "@/hooks/use-toast";
import { GroupMarketing } from "./group-marketing";
import { GroupTerms } from "./group-terms";

// Group bookings — one file per group (cabins, travelers, paperwork, payments,
// travel, checklist). Every cell saves when you leave it. Card numbers are
// refused by the server; passport numbers arrive only through the traveler's
// own private form and show here as the last 4.

type Row = Record<string, any>;

type Attention = { kind: string; label: string; due: string | null; overdue: boolean; daysOut: number | null };
type Summary = {
  cabins: { total: number; held: number; offered: number; booked: number; released: number };
  travelers: { total: number; formsIn: number; signed: number };
  payments: { dueTotal: number; paidTotal: number; openCount: number; overdueCount: number };
  deposits: { total: number; paid: number };
  emails: { sent: number };
  documents: { open: number; overdue: number };
  checklist: { open: number; overdue: number };
  daysToSail: number | null;
  attention: Attention[];
};
type GroupFile = {
  group: Row; cabins: Row[]; travelers: Row[]; documents: Row[]; payments: Row[];
  travel: Row[]; checklist: Row[]; messages: Row[]; summary: Summary;
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

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d.slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

function dueText(a: Attention): string {
  if (a.daysOut === null) return "no date set";
  if (a.daysOut < 0) return `${-a.daysOut} day${a.daysOut === -1 ? "" : "s"} overdue`;
  if (a.daysOut === 0) return "due today";
  return `due in ${a.daysOut} day${a.daysOut === 1 ? "" : "s"}`;
}

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700 border-slate-200",
  marketing: "bg-blue-100 text-blue-800 border-blue-200",
  booking: "bg-amber-100 text-amber-800 border-amber-200",
  "final-paid": "bg-green-100 text-green-800 border-green-200",
  sailed: "bg-teal-100 text-teal-800 border-teal-200",
  closed: "bg-gray-100 text-gray-600 border-gray-200",
  cancelled: "bg-red-100 text-red-700 border-red-200",
};

// ── Editable cell ─────────────────────────────────────────────────────────────

type Col = {
  key: string;
  label: string;
  type?: "text" | "number" | "date" | "datetime" | "check" | "select" | "stamp" | "readonly";
  options?: Array<{ value: string; label: string }>;
  width?: string;
};

const inputCls =
  "w-full px-2 py-1 text-sm rounded border border-transparent bg-transparent hover:border-border focus:border-ring focus:bg-card focus:outline-none";

function toInput(col: Col, v: unknown): string {
  if (v === null || v === undefined) return "";
  if (col.type === "date") return String(v).slice(0, 10);
  if (col.type === "datetime") return String(v).slice(0, 16);
  return String(v);
}

function Cell({ col, value, onSave }: { col: Col; value: unknown; onSave: (v: unknown) => void }) {
  const [draft, setDraft] = useState(toInput(col, value));
  React.useEffect(() => setDraft(toInput(col, value)), [col, value]);

  if (col.type === "readonly") return <span className="px-2 text-sm text-muted-foreground">{toInput(col, value) || "—"}</span>;
  if (col.type === "check") {
    return <input type="checkbox" className="ml-2 h-4 w-4" checked={!!value} onChange={(e) => onSave(e.target.checked)} />;
  }
  // A "stamp" is a done/not-done box backed by a timestamp column (paid_at, done_at).
  if (col.type === "stamp") {
    return (
      <label className="flex items-center gap-2 px-2 text-sm">
        <input type="checkbox" className="h-4 w-4" checked={!!value} onChange={(e) => onSave(e.target.checked ? new Date().toISOString() : null)} />
        <span className="text-muted-foreground">{value ? fmtDate(String(value)) : ""}</span>
      </label>
    );
  }
  if (col.type === "select") {
    return (
      <select className={inputCls} value={draft} onChange={(e) => { setDraft(e.target.value); onSave(e.target.value === "" ? null : e.target.value); }}>
        {col.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  const commit = () => {
    if (draft === toInput(col, value)) return;
    if (col.type === "number") onSave(draft === "" ? null : Number(draft));
    else if (col.type === "datetime") onSave(draft === "" ? null : new Date(draft).toISOString());
    else onSave(draft);
  };
  return (
    <input
      className={inputCls}
      type={col.type === "number" ? "number" : col.type === "date" ? "date" : col.type === "datetime" ? "datetime-local" : "text"}
      step={col.type === "number" ? "0.01" : undefined}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

function Section({
  title, hint, groupId, child, cols, rows, newRow, onChanged, extra,
}: {
  title: string; hint?: string; groupId: string; child: string; cols: Col[]; rows: Row[];
  newRow: Row; onChanged: () => void; extra?: React.ReactNode;
}) {
  const { toast } = useToast();
  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); onChanged(); }
    catch (e) { toast({ variant: "destructive", title: "Not saved", description: (e as Error).message }); onChanged(); }
  };
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b flex-wrap">
        <div>
          <h3 className="font-semibold">{title} <span className="text-muted-foreground font-normal">({rows.length})</span></h3>
          {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
        </div>
        <div className="flex items-center gap-2">
          {extra}
          <button
            onClick={() => run(() => api(`/groups/${groupId}/${child}`, "POST", newRow))}
            className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground"
          >
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30">
              {cols.map((c) => (
                <th key={c.key} className="text-left px-2 py-2 font-semibold text-muted-foreground whitespace-nowrap" style={{ minWidth: c.width ?? "7rem" }}>{c.label}</th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 && (
              <tr><td colSpan={cols.length + 1} className="px-4 py-6 text-center text-muted-foreground">Nothing here yet.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-muted/20">
                {cols.map((c) => (
                  <td key={c.key} className="py-1">
                    <Cell col={c} value={r[c.key]} onSave={(v) => run(() => api(`/groups/${groupId}/${child}/${r.id}`, "PATCH", { [c.key]: v }))} />
                  </td>
                ))}
                <td className="pr-2">
                  <button
                    title="Remove this row"
                    onClick={() => { if (window.confirm("Remove this row?")) run(() => api(`/groups/${groupId}/${child}/${r.id}`, "DELETE")); }}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── List ──────────────────────────────────────────────────────────────────────

function GroupList() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [cabins, setCabins] = useState("");
  const { data, isLoading, error } = useQuery<{ groups: Array<Row & { summary: Summary }> }>({
    queryKey: ["groups"],
    queryFn: () => api("/groups"),
  });

  const create = async () => {
    try {
      await api("/groups", "POST", { name, cabins_held: Number(cabins) || 0 });
      setName("");
      qc.invalidateQueries({ queryKey: ["groups"] });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not open the group", description: (e as Error).message });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Group Bookings</h2>
          <p className="text-sm text-muted-foreground mt-0.5">One file per group: cabins, travelers, paperwork, payments, travel and checklist.</p>
        </div>
        <Link href="/groups/new">
          <span className="flex items-center gap-1 text-sm px-4 py-1.5 rounded-md bg-primary text-primary-foreground cursor-pointer"><FileText className="w-4 h-4" /> Enter a booking (drop a PDF)</span>
        </Link>
      </div>

      <Card className="p-4">
        <CardContent className="p-0 flex items-end gap-3 flex-wrap">
          <label className="flex-1 min-w-[14rem] text-xs text-muted-foreground">
            Or open an empty group file by name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Type a name for the group"
              className="mt-1 w-full px-3 py-1.5 text-sm rounded-md border bg-card text-foreground" />
          </label>
          <label className="w-28 text-xs text-muted-foreground">
            Cabins held
            <input value={cabins} onChange={(e) => setCabins(e.target.value)} type="number" min={0} placeholder="0"
              className="mt-1 w-full px-3 py-1.5 text-sm rounded-md border bg-card text-foreground" />
          </label>
          <button onClick={create} disabled={!name.trim()}
            className="flex items-center gap-1 text-sm px-4 py-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-50">
            <Plus className="w-4 h-4" /> Open group file
          </button>
        </CardContent>
      </Card>

      {/* The empty state shows ONLY when the server answered with an empty list —
          a refused or stalled request must never read as "no groups". */}
      {!data && !error && <p className="text-muted-foreground">Loading…</p>}
      {error && <p className="text-destructive">Could not load your groups: {(error as Error).message}</p>}
      {data && data.groups.length === 0 && <p className="text-muted-foreground">No groups yet. Open the first one above.</p>}

      <div className="grid gap-4 md:grid-cols-2">
        {data?.groups.map((g) => {
          const s = g.summary;
          const overdue = s.attention.filter((a) => a.overdue).length;
          return (
            <Link key={g.id} href={`/groups/${g.id}`}>
              <Card className="p-4 cursor-pointer hover:border-foreground/30 transition-colors">
                <CardContent className="p-0 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold flex items-center gap-2"><Ship className="w-4 h-4" />{g.name}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {[g.cruise_line, g.ship_name].filter(Boolean).join(" · ") || "Ship not set"} · sails {fmtDate(g.sail_date)}
                        {s.daysToSail !== null && s.daysToSail >= 0 ? ` (${s.daysToSail} days)` : ""}
                      </div>
                    </div>
                    <Badge variant="outline" className={STATUS_STYLE[g.status] ?? ""}>{g.status}</Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div><div className="font-bold">{s.cabins.booked} of {s.cabins.total - s.cabins.released}</div><div className="text-xs text-muted-foreground">cabins booked</div></div>
                    <div><div className="font-bold">{money(s.payments.paidTotal)}</div><div className="text-xs text-muted-foreground">paid · {money(s.payments.dueTotal)} still due</div></div>
                    <div><div className="font-bold">{s.documents.open}</div><div className="text-xs text-muted-foreground">open paperwork items</div></div>
                  </div>
                  {overdue > 0 && (
                    <div className="flex items-center gap-1.5 text-sm text-red-700"><AlertTriangle className="w-4 h-4" />{overdue} overdue item{overdue === 1 ? "" : "s"}</div>
                  )}
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ── Detail ────────────────────────────────────────────────────────────────────

const opt = (values: string[]) => values.map((v) => ({ value: v, label: v }));

const GROUP_FIELDS: Col[] = [
  { key: "name", label: "Group name" },
  { key: "status", label: "Stage", type: "select", options: opt(["draft", "marketing", "booking", "final-paid", "sailed", "closed", "cancelled"]) },
  { key: "lang", label: "Language", type: "select", options: [{ value: "en", label: "English" }, { value: "es", label: "Spanish" }, { value: "both", label: "Both" }] },
  { key: "organizer_name", label: "Organizer" },
  { key: "organizer_email", label: "Organizer email" },
  { key: "organizer_phone", label: "Organizer phone" },
  { key: "cruise_line", label: "Cruise line" },
  { key: "ship_name", label: "Ship" },
  { key: "group_number", label: "Line's group number" },
  { key: "embark_port", label: "Sails from" },
  { key: "sail_date", label: "Sail date", type: "date" },
  { key: "return_date", label: "Return date", type: "date" },
  { key: "nights", label: "Nights", type: "number" },
  { key: "deposit_per_person", label: "Deposit per person ($)", type: "number" },
  { key: "deposit_due", label: "Deposit deadline", type: "date" },
  { key: "names_due", label: "Names due to the line", type: "date" },
  { key: "final_payment_due", label: "Final payment deadline", type: "date" },
  { key: "recall_date", label: "Unsold cabins go back", type: "date" },
  { key: "notes", label: "Notes" },
];

function GroupDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, error } = useQuery<GroupFile>({ queryKey: ["group", id], queryFn: () => api(`/groups/${id}?horizon=3650`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["group", id] }); qc.invalidateQueries({ queryKey: ["groups"] }); };

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (error || !data) return <p className="text-destructive">Could not load this group: {(error as Error)?.message}</p>;

  const { group: g, summary: s } = data;
  const cabinOptions = [{ value: "", label: "—" }, ...data.cabins.map((c, i) => ({ value: c.id, label: c.cabin_num ? `Cabin ${c.cabin_num}` : `Unassigned #${i + 1}` }))];
  const travelerOptions = [{ value: "", label: "—" }, ...data.travelers.map((t) => ({ value: t.id, label: [t.first_name, t.last_name].filter(Boolean).join(" ") || "Unnamed traveler" }))];
  const cabinCol: Col = { key: "cabin_id", label: "Cabin", type: "select", options: cabinOptions };

  const saveGroup = async (key: string, v: unknown) => {
    try { await api(`/groups/${id}`, "PATCH", { [key]: v }); }
    catch (e) { toast({ variant: "destructive", title: "Not saved", description: (e as Error).message }); }
    refresh();
  };
  const buildSchedule = async () => {
    try {
      const r = await api<{ added: number }>(`/groups/${id}/payment-schedule`, "POST", {});
      toast({ title: r.added ? `Added ${r.added} payment line${r.added === 1 ? "" : "s"}` : "Every cabin already has its deposit and final payment lines" });
    } catch (e) { toast({ variant: "destructive", title: "Could not build the schedule", description: (e as Error).message }); }
    refresh();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Link href="/groups"><span className="text-xs text-muted-foreground flex items-center gap-1 cursor-pointer hover:text-foreground"><ArrowLeft className="w-3.5 h-3.5" /> All groups</span></Link>
          <h2 className="text-xl font-bold tracking-tight mt-1">{g.name}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {[g.cruise_line, g.ship_name].filter(Boolean).join(" · ") || "Ship not set"} · sails {fmtDate(g.sail_date)}
            {s.daysToSail !== null && s.daysToSail >= 0 ? ` · ${s.daysToSail} days to go` : ""}
          </p>
        </div>
        <Badge variant="outline" className={STATUS_STYLE[g.status] ?? ""}>{g.status}</Badge>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "cabins booked", value: `${s.cabins.booked} of ${s.cabins.total - s.cabins.released}` },
          { label: s.deposits.total > 0 ? "deposits paid" : `paid · ${money(s.payments.dueTotal)} still due`, value: s.deposits.total > 0 ? `${money(s.deposits.paid)} of ${money(s.deposits.total)}` : money(s.payments.paidTotal) },
          { label: "traveler forms returned", value: `${s.travelers.formsIn} of ${s.travelers.total}` },
          { label: "open paperwork items", value: String(s.documents.open) },
        ].map((x) => (
          <Card key={x.label} className="p-4"><CardContent className="p-0"><div className="text-xl font-bold">{x.value}</div><div className="text-xs text-muted-foreground">{x.label}</div></CardContent></Card>
        ))}
      </div>

      <Card>
        <div className="px-4 py-3 border-b flex items-center gap-2"><CalendarClock className="w-4 h-4" /><h3 className="font-semibold">Needs attention</h3></div>
        <div className="divide-y divide-border">
          {s.attention.length === 0 && <p className="px-4 py-4 text-sm text-muted-foreground">Nothing open.</p>}
          {s.attention.map((a, i) => (
            <div key={i} className="px-4 py-2 flex items-center justify-between gap-3 text-sm">
              <span>{a.label}</span>
              <span className={a.overdue ? "text-red-700 font-semibold whitespace-nowrap" : "text-muted-foreground whitespace-nowrap"}>
                {a.due ? `${fmtDate(a.due)} · ` : ""}{dueText(a)}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <div className="px-4 py-3 border-b"><h3 className="font-semibold">Group details</h3></div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-2 p-4">
          {GROUP_FIELDS.map((f) => (
            <label key={f.key} className="text-xs text-muted-foreground">
              {f.label}
              <div className="border rounded-md mt-1 bg-card text-foreground"><Cell col={f} value={g[f.key]} onSave={(v) => saveGroup(f.key, v)} /></div>
            </label>
          ))}
        </div>
      </Card>

      <GroupTerms terms={g.terms} sailDate={g.sail_date} />

      <GroupMarketing groupId={id} />

      <Section title="Cabins" groupId={id} child="cabins" rows={data.cabins} newRow={{}} onChanged={refresh}
        cols={[
          { key: "cabin_num", label: "Cabin #" },
          { key: "deck", label: "Deck", width: "4rem" },
          { key: "category", label: "Type" },
          { key: "category_code", label: "Code", width: "4rem" },
          { key: "status", label: "Status", type: "select", options: opt(["held", "offered", "booked", "released", "cancelled"]) },
          { key: "booking_number", label: "Booking #" },
          { key: "price_total", label: "Cabin total ($)", type: "number" },
          { key: "deposit_amount", label: "Deposit ($)", type: "number" },
          { key: "insurance", label: "Insurance", type: "select", options: opt(["not-offered", "offered", "accepted", "declined"]) },
          { key: "dining", label: "Dining" },
          { key: "notes", label: "Notes", width: "12rem" },
        ]} />

      <Section title="Travelers" hint="Passport numbers are entered only by the traveler on their private form; the last 4 show here." groupId={id} child="travelers" rows={data.travelers} newRow={{}} onChanged={refresh}
        cols={[
          cabinCol,
          { key: "is_lead", label: "Lead", type: "check", width: "3rem" },
          { key: "first_name", label: "First name" },
          { key: "middle_name", label: "Middle" },
          { key: "last_name", label: "Last name" },
          { key: "dob", label: "Date of birth", type: "date" },
          { key: "citizenship", label: "Citizenship" },
          { key: "email", label: "Email", width: "12rem" },
          { key: "phone", label: "Phone" },
          { key: "lang", label: "Language", type: "select", options: [{ value: "en", label: "English" }, { value: "es", label: "Spanish" }] },
          { key: "loyalty_number", label: "Loyalty #" },
          { key: "passport_last4", label: "Passport (last 4)", type: "readonly" },
          { key: "form_submitted_at", label: "Form returned", type: "readonly" },
          { key: "special_needs", label: "Special needs", width: "12rem" },
        ]} />

      <Section title="Payments" hint="Record what was paid and the cruise line's receipt reference. Never a card number — the server refuses them." groupId={id} child="payments" rows={data.payments} newRow={{ kind: "deposit" }} onChanged={refresh}
        extra={<button onClick={buildSchedule} className="text-xs px-3 py-1.5 rounded-md border bg-card">Build schedule from group dates</button>}
        cols={[
          cabinCol,
          { key: "kind", label: "Kind", type: "select", options: opt(["deposit", "final", "other"]) },
          { key: "amount", label: "Amount ($)", type: "number" },
          { key: "due_date", label: "Due", type: "date" },
          { key: "paid_at", label: "Paid", type: "stamp" },
          { key: "confirmation_ref", label: "Receipt reference" },
          { key: "method_note", label: "How it was paid", width: "12rem" },
        ]} />

      <Section title="Paperwork" groupId={id} child="documents" rows={data.documents} newRow={{ title: "New item" }} onChanged={refresh}
        cols={[
          { key: "title", label: "Item", width: "14rem" },
          { key: "kind", label: "Kind", type: "select", options: opt(["group-contract", "host-agency", "client-terms", "insurance-waiver", "card-auth-reference", "invoice", "confirmation", "other"]) },
          { key: "owner", label: "Who does it", type: "select", options: [{ value: "mark", label: "Mark" }, { value: "client", label: "Client" }] },
          cabinCol,
          { key: "status", label: "Status", type: "select", options: opt(["needed", "sent", "signed", "received", "filed", "not-required"]) },
          { key: "due_date", label: "Due", type: "date" },
          { key: "external_ref", label: "Where it lives", width: "12rem" },
          { key: "notes", label: "Notes", width: "12rem" },
        ]} />

      <Section title="Flights, hotels and transfers" groupId={id} child="travel" rows={data.travel} newRow={{ kind: "flight" }} onChanged={refresh}
        cols={[
          { key: "kind", label: "Kind", type: "select", options: opt(["flight", "hotel", "transfer"]) },
          { key: "direction", label: "When", type: "select", options: [{ value: "pre", label: "Before the cruise" }, { value: "post", label: "After the cruise" }] },
          cabinCol,
          { key: "traveler_id", label: "Traveler", type: "select", options: travelerOptions },
          { key: "provider", label: "Airline / hotel / company" },
          { key: "reference", label: "Flight # / room" },
          { key: "from_place", label: "From" },
          { key: "to_place", label: "To" },
          { key: "starts_at", label: "Starts", type: "datetime", width: "12rem" },
          { key: "ends_at", label: "Ends", type: "datetime", width: "12rem" },
          { key: "confirmation", label: "Confirmation" },
          { key: "price_per_person", label: "Price pp ($)" },
          { key: "included", label: "Included", type: "select", options: [{ value: "false", label: "No" }, { value: "true", label: "Yes" }] },
        ]} />

      <Section title="Checklist" hint="Your own to-dos, plus the product links and excursion ideas clients will see in the checklist phase." groupId={id} child="checklist" rows={data.checklist} newRow={{ title: "New item" }} onChanged={refresh}
        cols={[
          { key: "title", label: "Item", width: "14rem" },
          { key: "audience", label: "For", type: "select", options: [{ value: "mark", label: "Mark" }, { value: "client", label: "Clients" }] },
          { key: "kind", label: "Kind", type: "select", options: [{ value: "task", label: "To-do" }, { value: "product", label: "Product link" }, { value: "excursion", label: "Excursion" }] },
          { key: "due_date", label: "Due", type: "date" },
          { key: "done_at", label: "Done", type: "stamp" },
          { key: "link_url", label: "Link", width: "12rem" },
          { key: "detail", label: "Detail", width: "14rem" },
        ]} />

      <Card>
        <div className="px-4 py-3 border-b"><h3 className="font-semibold">Email log <span className="text-muted-foreground font-normal">({data.messages.length})</span></h3></div>
        <div className="divide-y divide-border">
          {data.messages.length === 0 && <p className="px-4 py-4 text-sm text-muted-foreground">No emails yet. Reminders and invitations will be listed here once they are switched on.</p>}
          {data.messages.map((m) => (
            <div key={m.id} className="px-4 py-2 flex items-center justify-between gap-3 text-sm">
              <span>{m.subject || m.template} <span className="text-muted-foreground">→ {m.to_email || "—"}</span></span>
              <span className="text-muted-foreground whitespace-nowrap">{m.status}{m.sent_at ? ` · ${fmtDate(m.sent_at)}` : ""}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

export default function Groups() {
  const [match, params] = useRoute("/groups/:id");
  return match && params?.id && params.id !== "new" ? <GroupDetail id={params.id} /> : <GroupList />;
}
