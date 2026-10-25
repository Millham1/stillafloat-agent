import React, { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight, Download, Search } from "lucide-react";
import {
  KIND_LABEL, longDate, missable, shortDate, toCsv, type CsvValue, type Tab, type WCabin, type WDeadline, type WGroup, type WInterest, type WMessage, type WPaperwork, type WPayment, type WTraveler,
} from "@/lib/group-workspace";
import { Pill, STATUS_STYLE, money } from "./group-workspace-parts";
import { Badge } from "@/components/ui/badge";
import { CopyButton, TravelerActions } from "./group-workspace-actions";

// The detail grids of the Group Bookings Workspace: one per kind of row, each with a quick filter, sortable columns, a row
// count, an export of exactly the rows on screen, and a click on a row that opens the group's file at the matching section.

export interface Column<T> {
  key: string;
  label: string;
  /** The raw value: what is sorted on (unless `sort` says otherwise), searched, and exported. */
  get: (r: T) => CsvValue;
  render?: (r: T) => React.ReactNode;
  sort?: (r: T) => string | number | null;
  align?: "right";
  min?: string;
  /** A column of buttons (Mark 2026-10-25): not searched, sorted or exported, and a click in it never opens the row. */
  action?: true;
}

type Tone = "slate" | "green" | "blue" | "red" | "amber" | "violet";
const tone = (map: Record<string, Tone>, v: string): Tone => map[v] ?? "slate";
const PAY_TONE: Record<string, Tone> = { paid: "green", due: "blue", overdue: "red", "no date": "slate" };
const CABIN_TONE: Record<string, Tone> = { booked: "green", held: "amber", offered: "blue", released: "slate", cancelled: "red" };
const MSG_TONE: Record<string, Tone> = { sent: "green", failed: "red", queued: "blue", approved: "blue", draft: "slate", skipped: "slate" };
const LEAD_TONE: Record<string, Tone> = { new: "blue", contacted: "amber", booked: "green", declined: "slate" };

/** A raw value as it reads in a cell. */
const plain = (v: CsvValue): string => (v === null || v === undefined || v === "" ? "—" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));

const when = (d: string | null | undefined) => (d ? longDate(d) : "—");
const dayWord = (n: number | null) => (n === null ? "—" : n === 0 ? "today" : n > 0 ? `in ${n} day${n === 1 ? "" : "s"}` : `${-n} day${n === -1 ? "" : "s"} ago`);

const GroupCell = (r: { groupName: string }) => <span className="font-medium">{r.groupName}</span>;

/** The grid's columns for each tab. */
export function columnsFor(tab: Tab): Column<any>[] {
  switch (tab) {
    case "groups": return [
      { key: "name", label: "Group", get: (g: WGroup) => g.name, render: (g: WGroup) => <span className="font-medium">{g.name}</span>, min: "11rem" },
      { key: "status", label: "Status", get: (g: WGroup) => g.status, render: (g: WGroup) => <Badge variant="outline" className={STATUS_STYLE[g.status] ?? ""}>{g.status}</Badge> },
      { key: "ship", label: "Ship", get: (g: WGroup) => [g.cruiseLine, g.shipName].filter(Boolean).join(" · ") || null },
      { key: "sail", label: "Sails", get: (g: WGroup) => g.sailDate, render: (g: WGroup) => when(g.sailDate), sort: (g: WGroup) => g.sailDate },
      { key: "days", label: "Days to sail", get: (g: WGroup) => g.daysToSail, align: "right" },
      { key: "booked", label: "Cabins booked", get: (g: WGroup) => g.cabinsBooked, render: (g: WGroup) => `${g.cabinsBooked} of ${g.cabinsTotal - g.cabinsReleased}`, align: "right" },
      { key: "held", label: "Held", get: (g: WGroup) => g.cabinsHeld, align: "right" },
      { key: "signed", label: "Travelers signed", get: (g: WGroup) => g.fullySigned, render: (g: WGroup) => `${g.fullySigned} of ${g.travelersExpected}`, align: "right" },
      { key: "due", label: "Still due ($)", get: (g: WGroup) => g.amountDue, render: (g: WGroup) => money(g.amountDue), align: "right" },
      { key: "overdue", label: "Overdue ($)", get: (g: WGroup) => g.amountOverdue, render: (g: WGroup) => <span className={g.amountOverdue > 0 ? "text-red-600 font-semibold" : ""}>{money(g.amountOverdue)}</span>, align: "right" },
      { key: "paid", label: "Paid ($)", get: (g: WGroup) => g.amountPaid, render: (g: WGroup) => money(g.amountPaid), align: "right" },
      { key: "leads", label: "New leads", get: (g: WGroup) => g.interestsNew, align: "right" },
      { key: "failed", label: "Emails failed", get: (g: WGroup) => g.journeyFailed, render: (g: WGroup) => <span className={g.journeyFailed > 0 ? "text-red-600 font-semibold" : ""}>{g.journeyFailed}</span>, align: "right" },
      { key: "next", label: "Next deadline", get: (g: WGroup) => (g.nextDeadlineLabel ? `${g.nextDeadlineLabel} — ${g.nextDeadlineDate}` : null), render: (g: WGroup) => g.nextDeadlineLabel ? <span>{g.nextDeadlineLabel} <span className="text-muted-foreground">· {shortDate(g.nextDeadlineDate)} ({dayWord(g.nextDeadlineDaysOut)})</span></span> : "—", sort: (g: WGroup) => g.nextDeadlineDaysOut, min: "16rem" },
      { key: "attention", label: "Needs attention", get: (g: WGroup) => g.attentionReasons.join("; ") || null, render: (g: WGroup) => g.needsAttention ? <span className="text-red-700">{g.attentionReasons.join(" · ")}</span> : <span className="text-muted-foreground">—</span>, sort: (g: WGroup) => g.attentionReasons.length, min: "14rem" },
    ];
    case "cabins": return [
      { key: "group", label: "Group", get: (r: WCabin) => r.groupName, render: GroupCell, min: "10rem" },
      { key: "cabin", label: "Cabin #", get: (r: WCabin) => r.cabinNum },
      { key: "type", label: "Type", get: (r: WCabin) => r.category },
      { key: "code", label: "Code", get: (r: WCabin) => r.categoryCode },
      { key: "status", label: "Status", get: (r: WCabin) => r.status, render: (r: WCabin) => <Pill tone={tone(CABIN_TONE, r.status)}>{r.status}</Pill> },
      { key: "booking", label: "Booking #", get: (r: WCabin) => r.bookingNumber },
      { key: "total", label: "Cabin total ($)", get: (r: WCabin) => r.priceTotal, render: (r: WCabin) => (r.priceTotal === null ? "—" : money(r.priceTotal)), align: "right" },
      { key: "deposit", label: "Deposit ($)", get: (r: WCabin) => r.depositAmount, render: (r: WCabin) => (r.depositAmount === null ? "—" : money(r.depositAmount)), align: "right" },
      { key: "n", label: "Travelers", get: (r: WCabin) => r.travelerCount, align: "right" },
      { key: "who", label: "Who", get: (r: WCabin) => r.travelers || null, min: "12rem" },
    ];
    case "travelers": return [
      { key: "group", label: "Group", get: (r: WTraveler) => r.groupName, render: GroupCell, min: "10rem" },
      { key: "name", label: "Traveler", get: (r: WTraveler) => r.name, render: (r: WTraveler) => <span>{r.name}{r.isLead && <span className="ml-1 text-[11px] text-muted-foreground">(lead)</span>}</span> },
      { key: "act", label: "Paperwork", get: () => null, render: (r: WTraveler) => <TravelerActions row={r} />, action: true, min: "19rem" },
      { key: "cabin", label: "Cabin", get: (r: WTraveler) => r.cabinNum },
      { key: "email", label: "Email", get: (r: WTraveler) => r.email },
      { key: "lang", label: "Language", get: (r: WTraveler) => (r.lang === "es" ? "Spanish" : "English") },
      { key: "form", label: "Form", get: (r: WTraveler) => r.formStatus, render: (r: WTraveler) => <Pill tone={r.formStatus === "returned" ? "green" : r.formStatus === "sent" ? "amber" : "slate"}>{r.formStatus}</Pill> },
      { key: "docs", label: "Documents signed", get: (r: WTraveler) => r.docsSigned, render: (r: WTraveler) => `${r.docsSigned} of ${r.docsRequired}`, align: "right" },
      { key: "full", label: "Fully signed", get: (r: WTraveler) => r.fullySigned, render: (r: WTraveler) => <Pill tone={r.fullySigned ? "green" : "amber"}>{r.fullySigned ? "yes" : "no"}</Pill> },
      { key: "pp", label: "Passport on file", get: (r: WTraveler) => r.passportOnFile, render: (r: WTraveler) => (r.passportOnFile ? "yes" : "no") },
    ];
    case "payments": return [
      { key: "group", label: "Group", get: (r: WPayment) => r.groupName, render: GroupCell, min: "10rem" },
      { key: "cabin", label: "Cabin", get: (r: WPayment) => r.cabinNum },
      { key: "kind", label: "Kind", get: (r: WPayment) => r.kind },
      { key: "due", label: "Due", get: (r: WPayment) => r.dueDate, render: (r: WPayment) => when(r.dueDate), sort: (r: WPayment) => r.dueDate },
      { key: "days", label: "Days out", get: (r: WPayment) => r.daysOut, render: (r: WPayment) => (r.status === "paid" ? "—" : dayWord(r.daysOut)), align: "right" },
      { key: "amount", label: "Amount ($)", get: (r: WPayment) => r.amount, render: (r: WPayment) => (r.amount === null ? "—" : money(r.amount)), align: "right" },
      { key: "paid", label: "Paid on", get: (r: WPayment) => r.paidAt, render: (r: WPayment) => when(r.paidAt), sort: (r: WPayment) => r.paidAt },
      { key: "status", label: "Status", get: (r: WPayment) => r.status, render: (r: WPayment) => <Pill tone={tone(PAY_TONE, r.status)}>{r.status}</Pill> },
    ];
    case "paperwork": return [
      { key: "group", label: "Group", get: (r: WPaperwork) => r.groupName, render: GroupCell, min: "10rem" },
      { key: "who", label: "Traveler", get: (r: WPaperwork) => r.travelerName },
      { key: "cabin", label: "Cabin", get: (r: WPaperwork) => r.cabinNum },
      { key: "doc", label: "Document", get: (r: WPaperwork) => r.docTitle },
      { key: "status", label: "Status", get: (r: WPaperwork) => r.status, render: (r: WPaperwork) => <Pill tone={r.status === "signed" ? "green" : "amber"}>{r.status}</Pill> },
      { key: "at", label: "Signed on", get: (r: WPaperwork) => r.signedAt, render: (r: WPaperwork) => when(r.signedAt), sort: (r: WPaperwork) => r.signedAt },
      { key: "copy", label: "Signed copy", get: () => null, render: (r: WPaperwork) => <CopyButton row={r} />, action: true },
    ];
    case "messages": return [
      { key: "group", label: "Group", get: (r: WMessage) => r.groupName, render: GroupCell, min: "10rem" },
      { key: "who", label: "Traveler", get: (r: WMessage) => r.travelerName ?? "Whole group" },
      { key: "kind", label: "Email", get: (r: WMessage) => r.kind },
      { key: "status", label: "Status", get: (r: WMessage) => r.status, render: (r: WMessage) => <Pill tone={tone(MSG_TONE, r.status)}>{r.status}</Pill> },
      { key: "sched", label: "Scheduled", get: (r: WMessage) => r.scheduledFor, render: (r: WMessage) => when(r.scheduledFor), sort: (r: WMessage) => r.scheduledFor },
      { key: "sent", label: "Sent", get: (r: WMessage) => r.sentAt, render: (r: WMessage) => when(r.sentAt), sort: (r: WMessage) => r.sentAt },
      { key: "to", label: "To", get: (r: WMessage) => r.to },
    ];
    case "interests": return [
      { key: "group", label: "Group", get: (r: WInterest) => r.groupName, render: GroupCell, min: "10rem" },
      { key: "at", label: "Received", get: (r: WInterest) => r.createdAt, render: (r: WInterest) => when(r.createdAt), sort: (r: WInterest) => r.createdAt },
      { key: "ago", label: "Days ago", get: (r: WInterest) => r.daysAgo, align: "right" },
      { key: "name", label: "Name", get: (r: WInterest) => r.name },
      { key: "email", label: "Email", get: (r: WInterest) => r.email },
      { key: "guests", label: "Party size", get: (r: WInterest) => r.guests, align: "right" },
      { key: "type", label: "Cabin type", get: (r: WInterest) => r.cabinType },
      { key: "lang", label: "Language", get: (r: WInterest) => (r.lang === "es" ? "Spanish" : "English") },
      { key: "status", label: "Status", get: (r: WInterest) => r.status, render: (r: WInterest) => <Pill tone={tone(LEAD_TONE, r.status)}>{r.status}</Pill> },
    ];
    case "deadlines": return [
      { key: "group", label: "Group", get: (r: WDeadline) => r.groupName, render: GroupCell, min: "10rem" },
      { key: "date", label: "Date", get: (r: WDeadline) => r.date, render: (r: WDeadline) => when(r.date), sort: (r: WDeadline) => r.date },
      { key: "out", label: "When", get: (r: WDeadline) => r.daysOut, render: (r: WDeadline) => <span className={r.daysOut < 0 && !r.done && missable(r.kind) ? "text-red-600 font-semibold" : ""}>{dayWord(r.daysOut)}</span>, align: "right" },
      { key: "what", label: "What", get: (r: WDeadline) => r.label, min: "16rem" },
      { key: "kind", label: "Kind", get: (r: WDeadline) => KIND_LABEL[r.kind] },
      { key: "state", label: "State", get: (r: WDeadline) => (r.done ? "met" : r.state === "due" ? "goes out next run" : r.daysOut < 0 ? "passed" : "ahead"), render: (r: WDeadline) => r.done ? <Pill tone="green">met</Pill> : r.state === "due" ? <Pill tone="amber">goes out next run</Pill> : r.daysOut < 0 ? <Pill tone={missable(r.kind) ? "red" : "slate"}>passed</Pill> : <Pill>ahead</Pill> },
      { key: "detail", label: "Detail", get: (r: WDeadline) => r.detail },
    ];
  }
}

/** The section of the group file a row of each grid belongs to (ids on the headings in pages/groups.tsx). */
export const SECTION: Record<Tab, string> = {
  groups: "", cabins: "cabins", travelers: "travelers", payments: "payments", paperwork: "paperwork", messages: "journey", interests: "marketing", deadlines: "attention",
};
export const TAB_LABEL: Record<Tab, string> = {
  groups: "Groups", cabins: "Cabins", travelers: "Travelers", payments: "Payments", paperwork: "Paperwork", messages: "Emails", interests: "Leads", deadlines: "Deadlines",
};

const PAGE = 200;

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DataGrid<T extends { groupId?: string; id?: string }>({ tab, rows, onOpen, today }: {
  tab: Tab; rows: T[]; onOpen: (row: T) => void; today: string;
}) {
  const columns = useMemo(() => columnsFor(tab) as Column<T>[], [tab]);
  const dataCols = useMemo(() => columns.filter((c) => !c.action), [columns]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [limit, setLimit] = useState(PAGE);
  // A different grid (or a different set of rows behind the same one) starts from the top again.
  React.useEffect(() => { setLimit(PAGE); }, [tab, rows]);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    let out = words.length ? rows.filter((r) => { const hay = dataCols.map((c) => String(c.get(r) ?? "")).join(" ").toLowerCase(); return words.every((w) => hay.includes(w)); }) : rows;
    const col = sort ? dataCols.find((c) => c.key === sort.key) : null;
    if (col && sort) {
      const key = col.sort ?? ((r: T) => { const v = col.get(r); return typeof v === "boolean" ? Number(v) : (v as string | number | null | undefined) ?? null; });
      out = [...out].sort((a, b) => {
        const x = key(a), y = key(b);
        if (x === null && y === null) return 0;
        if (x === null) return 1; // empty values last, whichever way it sorts
        if (y === null) return -1;
        return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sort.dir;
      });
    }
    return out;
  }, [rows, dataCols, query, sort]);

  const exportCsv = () => download(`group-workspace-${tab}-${today}.csv`, toCsv(dataCols.map((c) => c.label), shown.map((r) => dataCols.map((c) => c.get(r)))));
  const filtered = query.trim() !== "";
  const open = (r: T) => onOpen(r);

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 px-3 py-2 border-b">
        <label className="relative flex-1 min-w-[12rem] max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Filter the {TAB_LABEL[tab].toLowerCase()} grid</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type to filter these rows" className="w-full pl-8 pr-2 py-1.5 text-sm rounded-md border bg-card text-foreground" />
        </label>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {filtered ? `${shown.length} of ${rows.length} row${rows.length === 1 ? "" : "s"} match` : `${rows.length} row${rows.length === 1 ? "" : "s"}`}
        </span>
        <button type="button" onClick={exportCsv} disabled={!shown.length} className="ml-auto inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border bg-card disabled:opacity-40">
          <Download className="w-3.5 h-3.5" /> Export CSV{filtered ? " (filtered rows)" : ""}
        </button>
      </div>
      <div className="overflow-auto max-h-[520px]">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b">
              {columns.map((c) => {
                const on = sort?.key === c.key;
                if (c.action) return <th key={c.key} className="px-3 py-2 font-semibold text-muted-foreground whitespace-nowrap text-left" style={{ minWidth: c.min }}>{c.label}</th>;
                return (
                  <th key={c.key} className={`px-3 py-2 font-semibold text-muted-foreground whitespace-nowrap ${c.align === "right" ? "text-right" : "text-left"}`} style={{ minWidth: c.min }} aria-sort={on ? (sort!.dir === 1 ? "ascending" : "descending") : "none"}>
                    <button type="button" className={`inline-flex items-center gap-1 hover:text-foreground ${on ? "text-foreground" : ""}`}
                      onClick={() => setSort(on ? (sort!.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 })}>
                      {c.label}
                      {on ? (sort!.dir === 1 ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                    </button>
                  </th>
                );
              })}
              <th className="w-8" aria-label="Open the group file" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.length === 0 && (
              <tr><td colSpan={columns.length + 1} className="px-4 py-8 text-center text-muted-foreground">{filtered ? "No rows match what you typed." : `No ${TAB_LABEL[tab].toLowerCase()} match these filters.`}</td></tr>
            )}
            {shown.slice(0, limit).map((r, i) => (
              <tr key={(r.id ?? "") + i} tabIndex={0} onClick={() => open(r)} onKeyDown={(e) => { if (e.key === "Enter") open(r); }}
                className="cursor-pointer hover:bg-muted/40 focus:bg-muted/40 focus:outline-none" title="Open this group's file">
                {columns.map((c) => <td key={c.key} className={`px-3 py-1.5 ${c.action ? "cursor-default align-top" : "whitespace-nowrap"} ${c.align === "right" ? "text-right tabular-nums" : ""}`}>{c.render ? c.render(r) : plain(c.get(r))}</td>)}
                <td className="pr-2 text-muted-foreground"><ChevronRight className="w-4 h-4" aria-hidden="true" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length > limit && (
        <div className="px-3 py-2 border-t text-xs text-muted-foreground flex items-center gap-3">
          Showing the first {limit} of {shown.length} rows.
          <button type="button" className="underline" onClick={() => setLimit((n) => n + PAGE)}>Show {Math.min(PAGE, shown.length - limit)} more</button>
          <span>Export CSV has all {shown.length}.</span>
        </div>
      )}
    </Card>
  );
}
