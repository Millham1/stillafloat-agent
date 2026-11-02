import React from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import {
  ACTIVE_STATUSES, ALL_STATUSES, crossLabel, shipKey, type Cross, type Filters, type WGroup, type WorkspaceData,
} from "@/lib/group-workspace";

// The small pieces of the Group Bookings Workspace: money formatting, status colours, the filter pane (slicers),
// the cards and the chips that show a cross-filter.

export const money = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });

export const STATUS_STYLE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700 border-slate-200",
  marketing: "bg-blue-100 text-blue-800 border-blue-200",
  booking: "bg-amber-100 text-amber-800 border-amber-200",
  "final-paid": "bg-green-100 text-green-800 border-green-200",
  sailed: "bg-teal-100 text-teal-800 border-teal-200",
  closed: "bg-gray-100 text-gray-600 border-gray-200",
  cancelled: "bg-red-100 text-red-700 border-red-200",
};

/** A status or state written out in words, with a colour that is only a second signal. */
export function Pill({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "green" | "blue" | "red" | "amber" | "violet" }) {
  const tones = {
    slate: "bg-slate-100 text-slate-700 border-slate-200",
    green: "bg-green-100 text-green-800 border-green-200",
    blue: "bg-blue-100 text-blue-800 border-blue-200",
    red: "bg-red-100 text-red-700 border-red-200",
    amber: "bg-amber-100 text-amber-800 border-amber-200",
    violet: "bg-violet-100 text-violet-800 border-violet-200",
  };
  return <Badge variant="outline" className={`${tones[tone]} font-medium whitespace-nowrap`}>{children}</Badge>;
}

// ── Cards ─────────────────────────────────────────────────────────────────────

export function KpiCard({ label, value, caption, tone, onClick, active }: {
  label: string; value: string; caption: string; tone?: "bad" | "good"; onClick?: () => void; active?: boolean;
}) {
  const body = (
    <>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-bold leading-tight ${tone === "bad" ? "text-red-600" : tone === "good" ? "text-green-700" : ""}`}>{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{caption}</div>
    </>
  );
  const cls = `p-3 text-left w-full h-full ${tone === "bad" ? "border-red-300 bg-red-50/50 dark:bg-red-950/20" : ""} ${active ? "ring-2 ring-ring" : ""}`;
  return onClick
    ? <Card className={`${cls} cursor-pointer hover:border-foreground/30 transition-colors`}><button type="button" onClick={onClick} className="block w-full text-left">{body}</button></Card>
    : <Card className={cls}>{body}</Card>;
}

// ── Chips ─────────────────────────────────────────────────────────────────────

export function CrossChips({ cross, docs, onRemove, onClear }: { cross: Cross[]; docs: WorkspaceData["docs"]; onRemove: (c: Cross) => void; onClear: () => void }) {
  if (!cross.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Chart selections that are narrowing the grids">
      <span className="text-xs text-muted-foreground">Narrowing the grids:</span>
      {cross.map((c) => (
        <span key={`${c.dim}:${c.value}`} className="inline-flex items-center gap-1 rounded-full border bg-primary text-primary-foreground pl-3 pr-1 py-0.5 text-xs">
          {crossLabel(c, docs)}
          <button type="button" onClick={() => onRemove(c)} aria-label={`Remove ${crossLabel(c, docs)}`} className="rounded-full p-0.5 hover:bg-primary-foreground/20"><X className="w-3 h-3" /></button>
        </span>
      ))}
      {cross.length > 1 && <button type="button" onClick={onClear} className="text-xs underline text-muted-foreground hover:text-foreground">Remove all</button>}
    </div>
  );
}

// ── Slicers ───────────────────────────────────────────────────────────────────

function Slicer({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <fieldset className="border-b last:border-b-0 py-3 first:pt-0">
      <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">{title}</legend>
      {hint && <p className="text-[11px] text-muted-foreground -mt-0.5 mb-1.5">{hint}</p>}
      {children}
    </fieldset>
  );
}

export function CheckList({ options, selected, onChange, empty }: {
  options: Array<{ value: string; label: string; hint?: string }>; selected: string[]; onChange: (next: string[]) => void; empty?: string;
}) {
  if (!options.length) return <p className="text-xs text-muted-foreground">{empty ?? "Nothing to pick yet."}</p>;
  return (
    <div className={`space-y-0.5 ${options.length > 7 ? "max-h-44 overflow-y-auto pr-1" : ""}`}>
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <label key={o.value} className={`flex items-center gap-2 rounded px-1.5 py-1 text-sm cursor-pointer hover:bg-muted/60 ${on ? "bg-muted font-medium" : ""}`}>
            <input type="checkbox" className="h-3.5 w-3.5 shrink-0" checked={on} onChange={() => onChange(on ? selected.filter((s) => s !== o.value) : [...selected, o.value])} />
            <span className="truncate" title={o.label}>{o.label}</span>
            {o.hint && <span className="ml-auto text-[11px] text-muted-foreground whitespace-nowrap">{o.hint}</span>}
          </label>
        );
      })}
    </div>
  );
}

const dateCls = "w-full px-2 py-1 text-sm rounded border bg-card text-foreground";

export function FilterPane({ groups, filters, onChange, onClear, dirty, matching }: {
  groups: WGroup[]; filters: Filters; onChange: (next: Filters) => void; onClear: () => void; dirty: boolean; matching: number;
}) {
  const ships = [...new Set(groups.map(shipKey))].sort();
  const statusCount = (s: string) => groups.filter((g) => g.status === s).length;
  const needAttention = groups.filter((g) => g.needsAttention).length;
  const statusOptions = ALL_STATUSES.filter((s) => statusCount(s) > 0 || filters.status.includes(s)).map((s) => ({ value: s, label: s, hint: String(statusCount(s)) }));
  // The status slicer shows every status ticked when it is empty (= no limit), so ticking "all" and ticking nothing cannot disagree.
  const statusSelected = filters.status.length === 0 ? statusOptions.map((o) => o.value) : filters.status;
  return (
    <div className="space-y-0">
      <div className="flex items-center justify-between gap-2 pb-2 border-b">
        <div>
          <div className="text-sm font-semibold">Filters</div>
          <div className="text-[11px] text-muted-foreground">{matching} of {groups.length} group{groups.length === 1 ? "" : "s"} shown</div>
        </div>
        <button type="button" onClick={onClear} disabled={!dirty} className="text-xs px-2.5 py-1 rounded-md border bg-card disabled:opacity-40">Clear filters</button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-1 gap-x-6">
        <Slicer title="Group">
          <CheckList options={groups.map((g) => ({ value: g.id, label: g.name, hint: g.status }))} selected={filters.groups} onChange={(next) => onChange({ ...filters, groups: next })} empty="No group files yet." />
        </Slicer>
        <Slicer title="Status" hint={filters.status.length && filters.status.length === ACTIVE_STATUSES.length && ACTIVE_STATUSES.every((s) => filters.status.includes(s)) ? "Showing the active groups. Tick sailed, closed or cancelled to see those too." : undefined}>
          <CheckList
            options={statusOptions}
            selected={statusSelected}
            onChange={(next) => onChange({ ...filters, status: next.length === statusOptions.length ? [] : next })}
          />
        </Slicer>
        <Slicer title="Cruise line · ship">
          <CheckList options={ships.map((s) => ({ value: s, label: s }))} selected={filters.ships} onChange={(next) => onChange({ ...filters, ships: next })} empty="No ships on the files yet." />
        </Slicer>
        <Slicer title="Sail date">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-muted-foreground">From
              <input type="date" className={dateCls} value={filters.from} max={filters.to || undefined} onChange={(e) => onChange({ ...filters, from: e.target.value })} />
            </label>
            <label className="text-[11px] text-muted-foreground">To
              <input type="date" className={dateCls} value={filters.to} min={filters.from || undefined} onChange={(e) => onChange({ ...filters, to: e.target.value })} />
            </label>
          </div>
        </Slicer>
        <Slicer title="Traveler language" hint="Narrows travelers, paperwork, emails and leads.">
          <CheckList options={[{ value: "en", label: "English" }, { value: "es", label: "Spanish" }]} selected={filters.lang} onChange={(next) => onChange({ ...filters, lang: next })} />
        </Slicer>
        <Slicer title="Needs attention">
          <label className="flex items-center gap-2 rounded px-1.5 py-1 text-sm cursor-pointer hover:bg-muted/60">
            <input type="checkbox" className="h-3.5 w-3.5" checked={filters.attention} onChange={(e) => onChange({ ...filters, attention: e.target.checked })} />
            <span>Only groups that need attention</span>
            <span className="ml-auto text-[11px] text-muted-foreground">{needAttention}</span>
          </label>
        </Slicer>
      </div>
    </div>
  );
}
