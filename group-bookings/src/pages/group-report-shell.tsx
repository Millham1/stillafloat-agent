import React from "react";
import { Card } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { ACTIVE_STATUSES, ALL_STATUSES, shipKey, type Filters, type WGroup } from "@/lib/group-workspace";
import { PAGES, PAGE_LABEL, type Page } from "@/lib/group-report";
import { CheckList, KpiCard } from "./group-workspace-parts";

// The frame of the Group Bookings report (Mark 2026-10-25: "a power BI format that leads the clicks to bring up specific
// pieces"): a slicer strip along the top, one-screen pages, the page tabs along the bottom, and boxes that never grow past
// the screen (a long list scrolls inside its own box).

// ── Slicer strip ─────────────────────────────────────────────────────────────

function SlicerButton({ label, value, active, children, wide }: { label: string; value: string; active: boolean; children: React.ReactNode; wide?: boolean }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={`inline-flex items-center gap-1 text-xs rounded-md border px-2.5 py-1.5 bg-card hover:bg-muted/50 max-w-[16rem] ${active ? "border-primary/60 ring-1 ring-primary/30" : ""}`}>
          <span className="text-muted-foreground">{label}:</span><span className="font-semibold truncate">{value}</span><ChevronDown className="w-3 h-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={wide ? "w-80 p-3" : "w-64 p-3"}>{children}</PopoverContent>
    </Popover>
  );
}

const names = (ids: string[], groups: WGroup[]) => {
  if (!ids.length) return "All";
  if (ids.length === 1) return groups.find((g) => g.id === ids[0])?.name ?? "1 group";
  return `${ids.length} groups`;
};

export function SlicerStrip({ groups, filters, onChange, onClear, dirty, matching }: {
  groups: WGroup[]; filters: Filters; onChange: (next: Filters) => void; onClear: () => void; dirty: boolean; matching: number;
}) {
  const ships = [...new Set(groups.map(shipKey))].sort();
  const statusCount = (s: string) => groups.filter((g) => g.status === s).length;
  const statusOptions = ALL_STATUSES.filter((s) => statusCount(s) > 0 || filters.status.includes(s)).map((s) => ({ value: s, label: s, hint: String(statusCount(s)) }));
  const statusSelected = filters.status.length === 0 ? statusOptions.map((o) => o.value) : filters.status;
  const activeOnly = filters.status.length === ACTIVE_STATUSES.length && ACTIVE_STATUSES.every((s) => filters.status.includes(s));
  const statusValue = filters.status.length === 0 ? "All" : activeOnly ? "Active" : filters.status.join(", ");
  const dates = filters.from || filters.to ? `${filters.from || "…"} to ${filters.to || "…"}` : "All dates";
  const lang = filters.lang.length === 0 || filters.lang.length === 2 ? "All" : filters.lang[0] === "es" ? "Spanish" : "English";
  const dateCls = "w-full px-2 py-1 text-sm rounded border bg-card text-foreground";
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Slicers">
      <SlicerButton label="Group" value={names(filters.groups, groups)} active={filters.groups.length > 0} wide>
        <CheckList options={groups.map((g) => ({ value: g.id, label: g.name, hint: g.status }))} selected={filters.groups} onChange={(next) => onChange({ ...filters, groups: next })} empty="No group files yet." />
      </SlicerButton>
      <SlicerButton label="Status" value={statusValue} active={!activeOnly}>
        <CheckList options={statusOptions} selected={statusSelected} onChange={(next) => onChange({ ...filters, status: next.length === statusOptions.length ? [] : next })} />
      </SlicerButton>
      <SlicerButton label="Ship" value={filters.ships.length ? (filters.ships.length === 1 ? filters.ships[0]! : `${filters.ships.length} ships`) : "All"} active={filters.ships.length > 0} wide>
        <CheckList options={ships.map((s) => ({ value: s, label: s }))} selected={filters.ships} onChange={(next) => onChange({ ...filters, ships: next })} empty="No ships on the files yet." />
      </SlicerButton>
      <SlicerButton label="Sails" value={dates} active={!!(filters.from || filters.to)}>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[11px] text-muted-foreground">From<input type="date" className={dateCls} value={filters.from} max={filters.to || undefined} onChange={(e) => onChange({ ...filters, from: e.target.value })} /></label>
          <label className="text-[11px] text-muted-foreground">To<input type="date" className={dateCls} value={filters.to} min={filters.from || undefined} onChange={(e) => onChange({ ...filters, to: e.target.value })} /></label>
        </div>
      </SlicerButton>
      <SlicerButton label="Language" value={lang} active={filters.lang.length === 1}>
        <CheckList options={[{ value: "en", label: "English" }, { value: "es", label: "Spanish" }]} selected={filters.lang} onChange={(next) => onChange({ ...filters, lang: next })} />
      </SlicerButton>
      <label className={`inline-flex items-center gap-1.5 text-xs rounded-md border px-2.5 py-1.5 bg-card cursor-pointer ${filters.attention ? "border-primary/60 ring-1 ring-primary/30" : ""}`}>
        <input type="checkbox" className="h-3.5 w-3.5" checked={filters.attention} onChange={(e) => onChange({ ...filters, attention: e.target.checked })} />Needs attention only
      </label>
      <button type="button" onClick={onClear} disabled={!dirty} className="text-xs px-2.5 py-1.5 rounded-md border bg-card disabled:opacity-40">Clear</button>
      <span className="text-[11px] text-muted-foreground">{matching} of {groups.length} group{groups.length === 1 ? "" : "s"}</span>
    </div>
  );
}

// ── Page tabs (bottom, like Power BI's report pages) ─────────────────────────

export function PageTabs({ page, onPage, counts }: { page: Page; onPage: (p: Page) => void; counts?: Partial<Record<Page, number>> }) {
  return (
    <nav className="shrink-0 border-t pt-1.5 flex flex-wrap gap-0.5" aria-label="Report pages">
      {PAGES.map((p) => {
        const on = p === page;
        return (
          <button key={p} type="button" onClick={() => onPage(p)} aria-current={on ? "page" : undefined}
            className={`text-[13px] px-3.5 py-1.5 rounded-t-md border border-b-0 ${on ? "bg-card font-semibold text-foreground border-border" : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40"}`}>
            {PAGE_LABEL[p]}{counts?.[p] !== undefined && <span className="ml-1.5 text-[11px] text-muted-foreground tabular-nums">{counts[p]}</span>}
          </button>
        );
      })}
    </nav>
  );
}

// ── Layout pieces ────────────────────────────────────────────────────────────

/** A page: the KPI row, then the visuals, filling the screen (on a narrow screen it simply flows). */
export function PageGrid({ kpis, children }: { kpis: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 lg:h-full lg:min-h-0">
      <section aria-label="Key numbers" className="grid gap-3 grid-cols-2 xl:grid-cols-4 shrink-0">{kpis}</section>
      <div className="grid gap-3 lg:flex-1 lg:min-h-0 lg:grid-cols-12 lg:auto-rows-[minmax(0,1fr)]">{children}</div>
    </div>
  );
}

/** One cell of a page's visual grid. `span` is the number of the 12 columns; `rows` lets a cell take both rows. */
export function Cell({ span, rows = 1, children }: { span: number; rows?: 1 | 2; children: React.ReactNode }) {
  const col: Record<number, string> = { 3: "lg:col-span-3", 4: "lg:col-span-4", 5: "lg:col-span-5", 6: "lg:col-span-6", 7: "lg:col-span-7", 8: "lg:col-span-8", 9: "lg:col-span-9", 12: "lg:col-span-12" };
  return <div className={`min-h-[300px] lg:min-h-0 ${col[span] ?? ""} ${rows === 2 ? "lg:row-span-2" : ""}`}>{children}</div>;
}

/** A plain box (no chart): its body scrolls inside, never the page. */
export function Box({ title, hint, children, action }: { title: string; hint?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Card className="p-3 h-full min-h-0 flex flex-col">
      <div className="mb-1.5 shrink-0 flex items-start gap-2">
        <div className="min-w-0"><h3 className="text-sm font-semibold">{title}</h3>{hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}</div>
        {action && <div className="ml-auto shrink-0">{action}</div>}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </Card>
  );
}

export { KpiCard };

/** Horizontal bars you can click (cabins by status, leads by status, waiting the longest). */
export function ClickBars({ rows, onPick, active, unit }: {
  rows: Array<{ key: string; label: string; value: number; note?: string; tone?: string }>; onPick?: (key: string) => void; active?: string | null; unit: (n: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="text-sm text-muted-foreground py-6 text-center">Nothing to show for these filters.</p>;
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => {
        const on = active === r.key;
        const body = (
          <>
            <span className="w-32 shrink-0 truncate text-left" title={r.label}>{r.label}</span>
            <span className="flex-1 h-3 rounded bg-muted overflow-hidden"><span className={`block h-full rounded ${r.tone ?? "bg-primary/70"}`} style={{ width: `${Math.max(3, (r.value / max) * 100)}%` }} /></span>
            <span className="w-28 shrink-0 text-right tabular-nums text-xs">{unit(r.value)}{r.note ? <span className="text-muted-foreground"> · {r.note}</span> : null}</span>
          </>
        );
        return (
          <li key={r.key}>
            {onPick
              ? <button type="button" onClick={() => onPick(r.key)} className={`w-full flex items-center gap-2 text-sm rounded px-1 py-0.5 hover:bg-muted/50 ${on ? "ring-2 ring-ring" : ""}`}>{body}</button>
              : <div className="flex items-center gap-2 text-sm px-1 py-0.5">{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/** The header of a drill-through page: back to the page it came from, the item's name and what it belongs to. */
export function DrillHeader({ backTo, onBack, title, sub, action }: { backTo: string; onBack: () => void; title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 flex-wrap shrink-0">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border bg-card hover:bg-muted/50"><ArrowLeft className="w-3.5 h-3.5" /> {backTo}</button>
      <h2 className="text-lg font-bold tracking-tight">{title}</h2>
      {sub && <span className="text-sm text-muted-foreground">{sub}</span>}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

/** A two-column list of facts in a drill page's box. */
export function Facts({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="text-sm divide-y divide-border">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-3 py-1.5"><dt className="w-36 shrink-0 text-muted-foreground">{k}</dt><dd className="min-w-0">{v ?? "—"}</dd></div>
      ))}
    </dl>
  );
}

/** A clickable row inside a drill page's list (a cabin, a traveler, a payment). */
export function RowLink({ onClick, children, title }: { onClick: () => void; children: React.ReactNode; title?: string }) {
  return <button type="button" onClick={onClick} title={title} className="w-full text-left flex items-center gap-2 px-1.5 py-1.5 rounded hover:bg-muted/50 text-sm border-b last:border-b-0">{children}</button>;
}
