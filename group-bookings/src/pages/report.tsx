import React, { useCallback, useEffect, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { AlertTriangle, BarChart3, RefreshCw } from "lucide-react";
import { ANALYTICS_KEY, ANALYTICS_STALE_MS, fetchAnalytics } from "@/lib/group-api";
import {
  activeFilterCount, applyFilters, crossValue, hasFilterParams, isDefaultFilters, parseFilters, removeCross, serializeFilters, toggleCross,
  type Cross, type Filters,
} from "@/lib/group-workspace";
import { PAGE_LABEL, parseDrill, parsePage, reportQuery, type DrillKind, type Page } from "@/lib/group-report";
import { CrossChips } from "./group-workspace-parts";
import { PageTabs, SlicerStrip } from "./group-report-shell";
import { PAGE_CROSS, PAGE_VIEW, type PageCtx } from "./group-report-pages";
import { DrillView } from "./group-report-drills";

// Group Bookings Workspace — the workhorse behind the Group Bookings tab, in Power BI's format.
// Mark 2026-10-19: "I need a link to open a power BI style dashboard to track this. the group booking tab in the business
// dashboard should give the 'big picture', the power BI should be the workhorse."
// Mark 2026-10-25: "it shouldnt be this one big scrolling document. it should be a power BI format that leads the clicks to
// bring up specific pieces."
//
// So: report PAGES that each fit one screen (tabs along the bottom), a slicer strip along the top, visuals that narrow each
// other when clicked, and DRILL-THROUGH pages for one traveler, group, cabin, payment or lead, with a back arrow. ONE request
// (GET /api/groups/analytics) feeds everything. Slicers, page and drill live in the address (a link carries them); the
// slicers are also remembered in this browser.

const STORE_KEY = "saf.groupBookings.slicers";
/** The app's one page, at the router's base (/groups/): the address carries the report page, the slicers and the drill. */
const PATH = "/";

function readStored(): string {
  try { return localStorage.getItem(STORE_KEY) ?? ""; } catch { return ""; }
}
function writeStored(qs: string) {
  try { if (qs) localStorage.setItem(STORE_KEY, qs); else localStorage.removeItem(STORE_KEY); } catch { /* private window: the address still carries the filters */ }
}

const clock = (iso: string | undefined): string =>
  iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) : "";

export default function GroupWorkspace() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const filters = useMemo(() => parseFilters(search), [search]);
  const page = parsePage(search);
  const drill = parseDrill(search);
  const q = useQuery({ queryKey: ANALYTICS_KEY, queryFn: fetchAnalytics, staleTime: ANALYTICS_STALE_MS });

  const to = useCallback((f: Filters, p: Page, d: { kind: DrillKind; id: string } | null = null, replace = true) => {
    writeStored(serializeFilters({ ...f, x: [] }));
    const qs = reportQuery(f, p, d);
    navigate(`${PATH}${qs ? `?${qs}` : ""}`, { replace });
  }, [navigate]);

  // Open with the slicers this browser last used, unless the address already carries some (a shared link wins).
  useEffect(() => {
    if (hasFilterParams(search)) return;
    const stored = readStored();
    if (!stored) return;
    const keep = new URLSearchParams(search);
    const next = new URLSearchParams(stored);
    for (const k of ["page", "d", "tab"]) { const v = keep.get(k); if (v) next.set(k, v); }
    navigate(`${PATH}?${next.toString()}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const data = q.data;
  const slice = useMemo(() => (data ? applyFilters(data, filters) : null), [data, filters]);

  const clearAll = () => { writeStored(""); navigate(`${PATH}${page !== "overview" ? `?page=${page}` : ""}`, { replace: true }); };
  const dirty = !isDefaultFilters(filters);

  const ctx: PageCtx | null = data && slice ? {
    data, slice, filters,
    cross: (c: Cross) => to(toggleCross(filters, c), page),
    crossSet: (set: Cross[]) => {
      const on = set.every((c) => crossValue(filters, c.dim) === c.value);
      const rest = filters.x.filter((x) => !set.some((c) => c.dim === x.dim));
      to({ ...filters, x: on ? rest : [...rest, ...set] }, page);
    },
    // A new page keeps the slicers; chart selections from another page are dropped (they belong to that page's visuals).
    goPage: (p: Page, c?: Cross) => {
      const kept = filters.x.filter((x) => PAGE_CROSS[p].includes(x.dim) && (!c || x.dim !== c.dim));
      to({ ...filters, x: c ? [...kept, c] : kept }, p);
    },
    // Opening an item is a step forward (the browser's back button returns here too); the page stays so "back" lands on it.
    drill: (kind: DrillKind, id: string) => to(filters, page, { kind, id }, false),
  } : null;

  const View = PAGE_VIEW[page];

  return (
    <div className="flex flex-col gap-2 lg:h-full lg:min-h-0">
      <div className="flex items-center gap-3 flex-wrap shrink-0">
        <div className="flex items-center gap-2 mr-2">
          <h1 className="text-base font-bold tracking-tight inline-flex items-center gap-1.5"><BarChart3 className="w-4 h-4 text-muted-foreground" />Group Bookings · {drill ? `${PAGE_LABEL[page]} ›` : PAGE_LABEL[page]}</h1>
        </div>
        {data && <SlicerStrip groups={data.groups} filters={filters} onChange={(next) => to(next, page, drill)} onClear={clearAll} dirty={dirty} matching={slice?.groups.length ?? 0} />}
        <div className="ml-auto flex items-center gap-2">
          {data && <span className="text-xs text-muted-foreground" title={`Counted for ${data.today}`}>as of {clock(data.generatedAt)}</span>}
          <button type="button" onClick={() => void q.refetch()} disabled={q.isFetching}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-60">
            <RefreshCw className={`w-3.5 h-3.5 ${q.isFetching ? "animate-spin" : ""}`} /> {q.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {filters.x.length > 0 && !drill && data && (
        <div className="shrink-0"><CrossChips cross={filters.x} docs={data.docs} onRemove={(c) => to(removeCross(filters, c), page)} onClear={() => to({ ...filters, x: [] }, page)} /></div>
      )}
      {q.error && data && (
        <div className="shrink-0 flex items-center gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5" /> These numbers are from {clock(data.generatedAt)}; refreshing failed: {(q.error as Error).message}
        </div>
      )}
      {data && data.warnings.length > 0 && (
        <div className="shrink-0 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5 truncate" role="status" title={data.warnings.join("\n")}>
          {data.warnings.length === 1 ? data.warnings[0] : `${data.warnings.length} warnings: ${data.warnings.join(" · ")}`}
        </div>
      )}

      <div className="lg:flex-1 lg:min-h-0">
        {!data && !q.error && <Card className="p-8 text-center text-muted-foreground">Loading Group Bookings…</Card>}
        {q.error && !data && (
          <Card className="p-6 border-red-300">
            <div className="flex items-start gap-2 text-red-700"><AlertTriangle className="w-4 h-4 mt-0.5" /><div>
              <div className="font-semibold">Group Bookings could not load.</div>
              <div className="text-sm">{(q.error as Error).message}</div>
            </div></div>
            <button type="button" onClick={() => void q.refetch()} className="mt-3 text-xs px-3 py-1.5 rounded-md border bg-card">Try again</button>
          </Card>
        )}
        {data && ctx && (drill
          ? <DrillView data={data} drill={drill} backTo={PAGE_LABEL[page]} onBack={() => to(filters, page)} onDrill={ctx.drill} />
          : data.groups.length === 0
            ? <Card className="p-10 text-center text-muted-foreground">There are no group files yet.</Card>
            : ctx.slice.groups.length === 0
              ? (
                <Card className="p-10 text-center">
                  <div className="font-semibold">No groups match these slicers</div>
                  <p className="text-sm text-muted-foreground mt-1">{data.groups.length} group{data.groups.length === 1 ? " is" : "s are"} on file; the slicers above are hiding {data.groups.length === 1 ? "it" : "them all"} ({activeFilterCount(filters)} in use).</p>
                  <button type="button" onClick={clearAll} className="mt-3 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground">Clear the slicers</button>
                </Card>
              )
              : <View c={ctx} />)}
      </div>

      <PageTabs page={page} onPage={(p) => ctx ? ctx.goPage(p) : to(filters, p)} />
    </div>
  );
}
