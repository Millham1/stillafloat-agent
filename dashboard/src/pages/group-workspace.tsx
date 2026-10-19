import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, ArrowLeft, BarChart3, PanelLeftClose, PanelLeftOpen, RefreshCw } from "lucide-react";
import { ANALYTICS_KEY, ANALYTICS_STALE_MS, fetchAnalytics } from "@/lib/group-api";
import {
  CROSS_TAB, DUE_WINDOW_DAYS, LEADS_WINDOW_DAYS, TABS, activeFilterCount, applyFilters, computeKpis, crossValue, funnel, gridRows, hasFilterParams,
  isDefaultFilters, journeyBars, moneyByWeek, paperworkMatrix, parseFilters, parseTab, removeCross, serializeFilters, timeline, toggleCross, toggleGroup,
  type Cross, type DeadlineKind, type Filters, type FunnelStep, type Tab,
} from "@/lib/group-workspace";
import { CrossChips, FilterPane, KpiCard, money } from "./group-workspace-parts";
import { FunnelVisual, JourneyVisual, MoneyVisual, PaperworkMatrix, TimelineVisual } from "./group-workspace-visuals";
import { DataGrid, SECTION, TAB_LABEL } from "./group-workspace-grids";

// Group Bookings Workspace — the workhorse behind the Group Bookings tab.
// Mark 2026-10-19: "I need a link to open a power BI style dashboard to track this. the group booking tab in the business
// dashboard should give the 'big picture', the power BI should be the workhorse."
//
// ONE request (GET /api/groups/analytics) feeds everything. The slicers narrow every card, chart and grid; a click on a chart
// segment narrows the grids and shows as a chip; a click on a group's name sets the Group slicer. The slicers live in the
// address (so a link carries them) and are remembered in this browser.

const STORE_KEY = "saf.groupWorkspace.slicers";
const PATH = "/groups/workspace";

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
  const tab = parseTab(search);
  const q = useQuery({ queryKey: ANALYTICS_KEY, queryFn: fetchAnalytics, staleTime: ANALYTICS_STALE_MS });
  const [paneOpen, setPaneOpen] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1280);
  const gridsRef = useRef<HTMLDivElement>(null);

  const go = useCallback((next: Filters, nextTab: Tab = tab) => {
    writeStored(serializeFilters({ ...next, x: [] }));
    const qs = serializeFilters(next, nextTab);
    navigate(`${PATH}${qs ? `?${qs}` : ""}`, { replace: true });
  }, [navigate, tab]);

  // Open with the slicers this browser last used, unless the address already carries some (a shared link wins).
  useEffect(() => {
    if (hasFilterParams(search)) return;
    const stored = readStored();
    if (!stored) return;
    const t = parseTab(search);
    navigate(`${PATH}?${stored}${t !== "groups" ? `&tab=${t}` : ""}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const data = q.data;
  const slice = useMemo(() => (data ? applyFilters(data, filters) : null), [data, filters]);
  const kpis = useMemo(() => (slice ? computeKpis(slice) : null), [slice]);
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t, slice ? gridRows(t, slice, filters.x).length : 0])) as Record<Tab, number>, [slice, filters.x]);

  const scrollToGrids = () => window.setTimeout(() => gridsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  const pickGroup = (id: string, additive: boolean) => go(toggleGroup(filters, id, additive));
  const pickCross = (c: Cross) => {
    const turningOn = crossValue(filters, c.dim) !== c.value;
    go(toggleCross(filters, c), CROSS_TAB[c.dim]);
    if (turningOn) scrollToGrids();
  };
  /** Set several cross-filters at once (a part of the journey chart is a milestone AND a state). */
  const pickCrossSet = (set: Cross[], toTab: Tab) => {
    const on = set.every((c) => crossValue(filters, c.dim) === c.value);
    const rest = filters.x.filter((x) => !set.some((c) => c.dim === x.dim));
    go({ ...filters, x: on ? rest : [...rest, ...set] }, toTab);
    if (!on) scrollToGrids();
  };
  const pickStep = (s: FunnelStep) => {
    if (s.cross) pickCross(s.cross);
    else { go(filters, s.tab); scrollToGrids(); }
  };
  const open = (row: any) => {
    const id = tab === "groups" ? row.id : row.groupId;
    const section = SECTION[tab];
    navigate(`/groups/${id}${section ? `#${section}` : ""}`);
  };
  const clearAll = () => { writeStored(""); navigate(PATH, { replace: true }); };

  const dirty = !isDefaultFilters(filters);
  const nSlicers = activeFilterCount(filters);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Link href="/groups"><span className="text-xs text-muted-foreground flex items-center gap-1 cursor-pointer hover:text-foreground"><ArrowLeft className="w-3.5 h-3.5" /> Group Bookings</span></Link>
          <h2 className="text-xl font-bold tracking-tight mt-1 flex items-center gap-2"><BarChart3 className="w-5 h-5 text-muted-foreground" /> Group Bookings Workspace</h2>
          <p className="text-sm text-muted-foreground mt-0.5">Every group in one place. Filter on the left, click a chart to narrow the lists below it, click a row to open that group's file.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setPaneOpen((v) => !v)} aria-expanded={paneOpen}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border bg-card">
            {paneOpen ? <PanelLeftClose className="w-3.5 h-3.5" /> : <PanelLeftOpen className="w-3.5 h-3.5" />}
            {paneOpen ? "Hide filters" : `Filters${nSlicers ? ` (${nSlicers})` : ""}`}
          </button>
          {data && <span className="text-xs text-muted-foreground" title={`Counted for ${data.today}`}>as of {clock(data.generatedAt)}</span>}
          <button type="button" onClick={() => void q.refetch()} disabled={q.isFetching}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-60">
            <RefreshCw className={`w-3.5 h-3.5 ${q.isFetching ? "animate-spin" : ""}`} /> {q.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {/* "no data and no error yet", not isLoading: while the request is being tried a second time neither is true for a moment */}
      {!data && !q.error && <Card className="p-8 text-center text-muted-foreground">Loading the workspace…</Card>}

      {q.error && !data && (
        <Card className="p-6 border-red-300">
          <div className="flex items-start gap-2 text-red-700"><AlertTriangle className="w-4 h-4 mt-0.5" /><div>
            <div className="font-semibold">The workspace could not load.</div>
            <div className="text-sm">{(q.error as Error).message}</div>
          </div></div>
          <button type="button" onClick={() => void q.refetch()} className="mt-3 text-xs px-3 py-1.5 rounded-md border bg-card">Try again</button>
        </Card>
      )}
      {q.error && data && (
        <div className="flex items-center gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          <AlertTriangle className="w-4 h-4" /> The numbers below are from {clock(data.generatedAt)}; refreshing failed: {(q.error as Error).message}
        </div>
      )}
      {data && data.warnings.length > 0 && (
        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2" role="status">
          {data.warnings.map((w) => <div key={w}>{w}</div>)}
        </div>
      )}

      {data && slice && kpis && (
        <div className="flex flex-col xl:flex-row gap-4 items-start">
          {paneOpen && (
            <aside className="w-full xl:w-60 xl:shrink-0 xl:sticky xl:top-0 xl:max-h-[calc(100vh-9rem)] xl:overflow-y-auto" aria-label="Filters">
              <Card className="p-3">
                <FilterPane groups={data.groups} filters={filters} onChange={(next) => go(next)} onClear={clearAll} dirty={dirty} matching={slice.groups.length} />
              </Card>
            </aside>
          )}

          <div className="flex-1 min-w-0 w-full space-y-4">
            {filters.x.length > 0 && (
              <div className="sticky top-0 z-20 -mx-1 px-1 py-1.5 bg-background/95 backdrop-blur border-b">
                <CrossChips cross={filters.x} docs={data.docs} onRemove={(c) => go(removeCross(filters, c))} onClear={() => go({ ...filters, x: [] })} />
              </div>
            )}
            {data.groups.length === 0 ? (
              <Card className="p-10 text-center text-muted-foreground">There are no group files yet. Open one on the <Link href="/groups"><span className="underline cursor-pointer">Group Bookings</span></Link> tab.</Card>
            ) : slice.groups.length === 0 ? (
              <Card className="p-10 text-center">
                <div className="font-semibold">No groups match these filters</div>
                <p className="text-sm text-muted-foreground mt-1">{data.groups.length} group{data.groups.length === 1 ? " is" : "s are"} on file; the filters on the left are hiding {data.groups.length === 1 ? "it" : "them all"}.</p>
                <button type="button" onClick={clearAll} className="mt-3 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground">Clear filters</button>
              </Card>
            ) : (
              <>
                <section aria-label="Key numbers" className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))]">
                  <KpiCard label="Cabins booked" value={String(kpis.cabinsBooked)}
                    caption={`of ${kpis.cabinsBlock} cabins in the block · ${kpis.cabinsHeld} held, ${kpis.cabinsOffered} offered`} />
                  <KpiCard label="Travelers fully signed" value={kpis.signedPct === null ? "—" : `${kpis.signedPct}%`}
                    caption={`${kpis.signedPeople} of ${kpis.signedOf} ${slice.byLanguage ? "named " : ""}travelers have signed every document`} />
                  <KpiCard label={`Due in the next ${DUE_WINDOW_DAYS} days`} value={money(kpis.dueNext30)}
                    caption={`dollars · ${kpis.dueNext30Count} payment${kpis.dueNext30Count === 1 ? "" : "s"}`}
                    onClick={() => pickCross({ dim: "pay", value: "due" })} active={crossValue(filters, "pay") === "due"} />
                  <KpiCard label="Overdue" value={money(kpis.overdue)} tone={kpis.overdueCount > 0 ? "bad" : undefined}
                    caption={`dollars · ${kpis.overdueCount} payment${kpis.overdueCount === 1 ? "" : "s"} past their date`}
                    onClick={() => pickCross({ dim: "pay", value: "overdue" })} active={crossValue(filters, "pay") === "overdue"} />
                  <KpiCard label="Collected" value={money(kpis.collected)} tone={kpis.collected > 0 ? "good" : undefined}
                    caption={`dollars · ${kpis.collectedCount} payment${kpis.collectedCount === 1 ? "" : "s"} received`}
                    onClick={() => pickCross({ dim: "pay", value: "paid" })} active={crossValue(filters, "pay") === "paid"} />
                  <KpiCard label="New interests this week" value={String(kpis.newInterests)}
                    caption={`replies from the group pages in the last ${LEADS_WINDOW_DAYS} days`} />
                  <KpiCard label="Journey emails" value={`${kpis.journeyQueued} / ${kpis.journeyFailed}`} tone={kpis.journeyFailed > 0 ? "bad" : undefined}
                    caption="queued to go / failed (emails)"
                    onClick={() => pickCrossSet([{ dim: "ms", value: "failed" }], "messages")} active={crossValue(filters, "ms") === "failed"} />
                </section>

                <div className="grid gap-4 xl:grid-cols-5">
                  <div className="xl:col-span-2"><FunnelVisual steps={funnel(slice)} active={filters.x} onStep={pickStep} /></div>
                  <div className="xl:col-span-3">
                    <MoneyVisual model={moneyByWeek(slice.payments, slice.today)} active={crossValue(filters, "pay")}
                      onSegment={(status) => pickCross({ dim: "pay", value: status })} />
                  </div>
                </div>

                <div className="grid gap-4 xl:grid-cols-5">
                  <div className="xl:col-span-3">
                    <TimelineVisual model={timeline(slice)} today={slice.today} onGroup={pickGroup} onKind={(k: DeadlineKind) => pickCross({ dim: "dk", value: k })} />
                  </div>
                  <div className="xl:col-span-2">
                    <JourneyVisual bars={journeyBars(slice)} active={filters.x}
                      onSegment={(kind, series) => series === "planned"
                        ? pickCross({ dim: "dk", value: "journey" })
                        : pickCrossSet([{ dim: "mk", value: kind }, { dim: "ms", value: series }], "messages")} />
                  </div>
                </div>

                <PaperworkMatrix model={paperworkMatrix(slice)} active={filters.x} onGroup={pickGroup}
                  onCell={(docKey, status) => pickCrossSet([{ dim: "doc", value: docKey }, { dim: "pws", value: status }], "paperwork")} />

                <div ref={gridsRef} className="scroll-mt-16">
                  <Tabs value={tab} onValueChange={(v) => go(filters, v as Tab)}>
                    <TabsList className="h-auto flex-wrap justify-start gap-1">
                      {TABS.map((t) => <TabsTrigger key={t} value={t}>{TAB_LABEL[t]} <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{counts[t]}</span></TabsTrigger>)}
                    </TabsList>
                    <TabsContent value={tab}>
                      <DataGrid key={tab} tab={tab} rows={gridRows(tab, slice, filters.x)} today={slice.today} onOpen={open} />
                    </TabsContent>
                  </Tabs>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
