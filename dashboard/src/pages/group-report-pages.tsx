import React, { useMemo } from "react";
import {
  computeKpis, crossValue, funnel, gridRows, journeyBars, longDate, moneyByWeek, paperworkMatrix, timeline,
  type Cross, type CrossDim, type DeadlineKind, type Filters, type FunnelStep, type Slice, type Tab, type WMessage, type WorkspaceData,
} from "@/lib/group-workspace";
import {
  cabinKpis, cabinStatusCounts, deadlineKpis, docStatusCounts, journeyKpis, leadKpis, moneyKpis, paperworkKpis, waitingLongest,
  type DrillKind, type Page,
} from "@/lib/group-report";
import { money } from "./group-workspace-parts";
import { FunnelVisual, JourneyVisual, MoneyVisual, PaperworkMatrix, TimelineVisual } from "./group-workspace-visuals";
import { DataGrid } from "./group-workspace-grids";
import { Box, Cell, ClickBars, KpiCard, PageGrid } from "./group-report-shell";

// The seven report pages of the Group Bookings Workspace (Mark 2026-10-25). Each is one screen: four key numbers, then the
// visuals. A click on part of a visual narrows the others on the page (Power BI's cross-filter); a click on a person, group,
// cabin, payment or lead opens that item's own page (drill-through).

export interface PageCtx {
  data: WorkspaceData; slice: Slice; filters: Filters;
  /** Turn a cross-filter on or off (and stay on this page). */
  cross: (c: Cross) => void;
  crossSet: (set: Cross[]) => void;
  /** Go to another report page, optionally with a cross-filter set there. */
  goPage: (p: Page, c?: Cross) => void;
  drill: (kind: DrillKind, id: string) => void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const TAB_PAGE: Record<Tab, Page> = { groups: "overview", cabins: "cabins", travelers: "paperwork", paperwork: "paperwork", payments: "money", messages: "journey", interests: "leads", deadlines: "deadlines" };

// ── Overview ─────────────────────────────────────────────────────────────────

export function OverviewPage({ c }: { c: PageCtx }) {
  const k = computeKpis(c.slice);
  const pick = (s: FunnelStep) => c.goPage(TAB_PAGE[s.tab], s.cross ?? undefined);
  return (
    <PageGrid kpis={<>
      <KpiCard label="Cabins booked" value={String(k.cabinsBooked)} caption={`of ${plural(k.cabinsBlock, "cabin")} in the block · ${k.cabinsHeld} held`} onClick={() => c.goPage("cabins")} />
      <KpiCard label="Travelers fully signed" value={k.signedPct === null ? "—" : `${k.signedPct}%`} caption={`${k.signedPeople} of ${plural(k.signedOf, "traveler")} signed every document`} onClick={() => c.goPage("paperwork")} />
      <KpiCard label="Due in the next 30 days" value={money(k.dueNext30)} caption={`dollars · ${plural(k.dueNext30Count, "payment")}`} onClick={() => c.goPage("money", { dim: "pay", value: "due" })} />
      <KpiCard label="Overdue" value={money(k.overdue)} tone={k.overdueCount ? "bad" : undefined} caption={`dollars · ${plural(k.overdueCount, "payment")} past their date`} onClick={() => c.goPage("money", { dim: "pay", value: "overdue" })} />
    </>}>
      <Cell span={4}><FunnelVisual fill steps={funnel(c.slice)} active={c.filters.x} onStep={pick} /></Cell>
      <Cell span={8}><MoneyVisual fill model={moneyByWeek(c.slice.payments, c.slice.today)} active={null} onSegment={(st) => c.goPage("money", { dim: "pay", value: st })} /></Cell>
      <Cell span={5}><TimelineVisual fill model={timeline(c.slice)} today={c.slice.today} onGroup={(id) => c.drill("group", id)} onKind={(kd: DeadlineKind) => c.goPage("deadlines", { dim: "dk", value: kd })} /></Cell>
      <Cell span={7}><DataGrid fill title="Groups" tab="groups" rows={gridRows("groups", c.slice, [])} today={c.slice.today} onOpen={(r: any) => c.drill("group", r.id)} rowTitle="Open this group's page" /></Cell>
    </PageGrid>
  );
}

// ── Cabins ───────────────────────────────────────────────────────────────────

const CABIN_TONE: Record<string, string> = { booked: "bg-green-600", held: "bg-amber-500", offered: "bg-blue-500", released: "bg-slate-400", cancelled: "bg-red-500" };

export function CabinsPage({ c }: { c: PageCtx }) {
  const k = cabinKpis(c.slice);
  const on = crossValue(c.filters, "cab");
  return (
    <PageGrid kpis={<>
      <KpiCard label="Booked" value={String(k.booked)} caption={`cabins · ${money(k.bookedValue)} booked value (dollars)`} onClick={() => c.cross({ dim: "cab", value: "booked" })} active={on === "booked"} />
      <KpiCard label="Held" value={String(k.held)} caption="cabins held in the block, not yet booked" onClick={() => c.cross({ dim: "cab", value: "held" })} active={on === "held"} />
      <KpiCard label="Offered" value={String(k.offered)} caption="cabins offered to someone" onClick={() => c.cross({ dim: "cab", value: "offered" })} active={on === "offered"} />
      <KpiCard label="Released or cancelled" value={String(k.released)} caption="cabins gone back to the line" />
    </>}>
      <Cell span={4}><Box title="Cabins by status" hint="Click a bar to list only those cabins.">
        <ClickBars rows={cabinStatusCounts(c.slice).map((r) => ({ key: r.status, label: r.status, value: r.count, tone: CABIN_TONE[r.status] }))} active={on} onPick={(st) => c.cross({ dim: "cab", value: st })} unit={(n) => plural(n, "cabin")} />
      </Box></Cell>
      <Cell span={8}><DataGrid fill title="Cabins" tab="cabins" rows={gridRows("cabins", c.slice, c.filters.x)} today={c.slice.today} onOpen={(r: any) => c.drill("cabin", r.id)} rowTitle="Open this cabin's page" /></Cell>
    </PageGrid>
  );
}

// ── Paperwork ────────────────────────────────────────────────────────────────

export function PaperworkPage({ c }: { c: PageCtx }) {
  const k = paperworkKpis(c.slice);
  const counts = docStatusCounts(c.slice);
  const doc = crossValue(c.filters, "doc");
  const pws = crossValue(c.filters, "pws");
  // Power BI cross-filter: a cell picked in the matrix narrows the matrix itself to the travelers in that state for that document.
  const model = useMemo(() => {
    const m = paperworkMatrix(c.slice);
    if (!pws) return m;
    return { ...m, groups: m.groups.map((g) => ({ ...g, rows: g.rows.filter((r) => (doc ? r.cells[doc] === pws : Object.values(r.cells).includes(pws as "signed" | "pending"))) })).filter((g) => g.rows.length) };
  }, [c.slice, doc, pws]);
  const waiting = waitingLongest(c.slice);
  const total = counts.signed + counts.pending + counts.notSent;
  const arc = (n: number) => (total ? (n / total) * 100 : 0);
  return (
    <PageGrid kpis={<>
      <KpiCard label="Travelers on file" value={`${k.onFile} of ${k.expected}`} caption={`people · ${Math.max(0, k.expected - k.onFile)} still to name`} />
      <KpiCard label="Fully signed" value={String(k.fullySigned)} caption={`travelers · ${k.onFile ? Math.round((k.fullySigned / k.onFile) * 100) : 0}% of those on file`} />
      <KpiCard label="Link sent, not opened" value={String(k.sentNotOpened)} tone={k.sentNotOpened ? "bad" : undefined} caption={k.oldestUnopenedDays === null ? "travelers" : `travelers · oldest ${plural(k.oldestUnopenedDays, "day")}`} />
      <KpiCard label="Signed copies sealed" value={String(k.sealedDocs)} tone={k.sealedDocs ? "good" : undefined} caption={`of ${plural(k.signedDocs, "signed document")} carry our seal`} />
    </>}>
      <Cell span={8} rows={2}>
        <PaperworkMatrix fill model={model} active={c.filters.x} title="Who has signed what"
          caption="Click a name to open that traveler's page. Click a cell to show only the travelers in that state."
          onCell={(key, st) => c.crossSet([{ dim: "doc", value: key }, { dim: "pws", value: st }])} onGroup={(id) => c.drill("group", id)} onTraveler={(id) => c.drill("traveler", id)} />
      </Cell>
      <Cell span={4}><Box title="Documents by status" hint="Click a status to show only those travelers in the table.">
        <div className="flex items-center gap-4 h-full">
          <svg width="128" height="128" viewBox="0 0 42 42" role="img" aria-label={`${counts.signed} signed, ${counts.pending} pending, ${counts.notSent} not sent`}>
            <circle cx="21" cy="21" r="15.915" fill="none" stroke="hsl(var(--muted))" strokeWidth="7" />
            <circle cx="21" cy="21" r="15.915" fill="none" stroke="#16a34a" strokeWidth="7" strokeDasharray={`${arc(counts.signed)} ${100 - arc(counts.signed)}`} strokeDashoffset="25" />
            <circle cx="21" cy="21" r="15.915" fill="none" stroke="#f59e0b" strokeWidth="7" strokeDasharray={`${arc(counts.pending)} ${100 - arc(counts.pending)}`} strokeDashoffset={25 - arc(counts.signed)} />
          </svg>
          <div className="space-y-1.5 text-sm">
            {([["signed", "Signed", counts.signed, "bg-green-600"], ["pending", "Pending", counts.pending, "bg-amber-500"], ["", "Not sent yet", counts.notSent, "bg-slate-400"]] as const).map(([v, label, n, tone]) => (
              v ? <button key={label} type="button" onClick={() => c.crossSet([{ dim: "pws", value: v }])} className={`flex items-center gap-2 rounded px-1.5 py-0.5 hover:bg-muted/50 ${pws === v && !doc ? "ring-2 ring-ring" : ""}`}><span className={`w-3 h-3 rounded-sm ${tone}`} />{label}<span className="tabular-nums text-muted-foreground">{plural(n, "document")}</span></button>
                : <div key={label} className="flex items-center gap-2 px-1.5 py-0.5"><span className={`w-3 h-3 rounded-sm ${tone}`} />{label}<span className="tabular-nums text-muted-foreground">{plural(n, "document")}</span></div>
            ))}
          </div>
        </div>
      </Box></Cell>
      <Cell span={4}><Box title="Waiting the longest" hint="Days since the link went out, not finished yet. Click a name to open that traveler.">
        <ClickBars rows={waiting.map((w) => ({ key: w.travelerId, label: w.name, value: w.days, note: `${w.signed} of ${w.required}`, tone: "bg-amber-500" }))} onPick={(id) => c.drill("traveler", id)} unit={(n) => plural(n, "day")} />
      </Box></Cell>
    </PageGrid>
  );
}

// ── Money ────────────────────────────────────────────────────────────────────

export function MoneyPage({ c }: { c: PageCtx }) {
  const k = moneyKpis(c.slice);
  const on = crossValue(c.filters, "pay");
  return (
    <PageGrid kpis={<>
      <KpiCard label="Collected" value={money(k.collected)} tone={k.collected ? "good" : undefined} caption={`dollars · ${plural(k.collectedCount, "payment")} received`} onClick={() => c.cross({ dim: "pay", value: "paid" })} active={on === "paid"} />
      <KpiCard label="Due in the next 30 days" value={money(k.due30)} caption={`dollars · ${plural(k.due30Count, "payment")}`} onClick={() => c.cross({ dim: "pay", value: "due" })} active={on === "due"} />
      <KpiCard label="Overdue" value={money(k.overdue)} tone={k.overdueCount ? "bad" : undefined} caption={`dollars · ${plural(k.overdueCount, "payment")} past their date`} onClick={() => c.cross({ dim: "pay", value: "overdue" })} active={on === "overdue"} />
      <KpiCard label="No date yet" value={money(k.noDate)} caption={`dollars · ${plural(k.noDateCount, "payment")} with no due date`} onClick={() => c.cross({ dim: "pay", value: "no date" })} active={on === "no date"} />
    </>}>
      <Cell span={7}><MoneyVisual fill model={moneyByWeek(c.slice.payments, c.slice.today)} active={on} onSegment={(st) => c.cross({ dim: "pay", value: st })} /></Cell>
      <Cell span={5}><DataGrid fill title="Payments" tab="payments" rows={gridRows("payments", c.slice, c.filters.x)} today={c.slice.today} onOpen={(r: any) => c.drill("payment", r.id)} rowTitle="Open this payment's page" /></Cell>
    </PageGrid>
  );
}

// ── Deadlines ────────────────────────────────────────────────────────────────

export function DeadlinesPage({ c }: { c: PageCtx }) {
  const k = deadlineKpis(c.slice);
  return (
    <PageGrid kpis={<>
      <KpiCard label="Next 30 days" value={String(k.next30)} caption="deadlines coming up" />
      <KpiCard label="Missed" value={String(k.missed)} tone={k.missed ? "bad" : undefined} caption="deposits, names or final payments past their date" />
      <KpiCard label="Met" value={String(k.met)} tone={k.met ? "good" : undefined} caption="deadlines already done" />
      <KpiCard label="Next up" value={k.nextDate ? longDate(k.nextDate) : "—"} caption={k.nextLabel ?? "nothing dated ahead"} />
    </>}>
      <Cell span={7}><TimelineVisual fill model={timeline(c.slice)} today={c.slice.today} onGroup={(id) => c.drill("group", id)} onKind={(kd: DeadlineKind) => c.cross({ dim: "dk", value: kd })} /></Cell>
      <Cell span={5}><DataGrid fill title="Deadlines" tab="deadlines" rows={gridRows("deadlines", c.slice, c.filters.x)} today={c.slice.today} onOpen={(r: any) => c.drill("group", r.groupId)} rowTitle="Open this group's page" /></Cell>
    </PageGrid>
  );
}

// ── Journey emails ───────────────────────────────────────────────────────────

export function JourneyPage({ c }: { c: PageCtx }) {
  const k = journeyKpis(c.slice);
  const ms = crossValue(c.filters, "ms");
  const open = (m: WMessage) => (m.travelerId ? c.drill("traveler", m.travelerId) : c.drill("group", m.groupId));
  return (
    <PageGrid kpis={<>
      <KpiCard label="Sent" value={String(k.sent)} tone={k.sent ? "good" : undefined} caption="journey emails delivered" onClick={() => c.cross({ dim: "ms", value: "sent" })} active={ms === "sent"} />
      <KpiCard label="Failed" value={String(k.failed)} tone={k.failed ? "bad" : undefined} caption="journey emails that did not go out" onClick={() => c.cross({ dim: "ms", value: "failed" })} active={ms === "failed"} />
      <KpiCard label="Queued" value={String(k.queued)} caption="approved, going out on the next run" onClick={() => c.cross({ dim: "ms", value: "queued" })} active={ms === "queued"} />
      <KpiCard label="Planned" value={String(k.planned)} caption="emails planned for future days (one per traveler)" />
    </>}>
      <Cell span={6}><JourneyVisual fill bars={journeyBars(c.slice)} active={c.filters.x}
        onSegment={(kind, series) => (series === "planned" ? c.goPage("deadlines", { dim: "dk", value: "journey" }) : c.crossSet([{ dim: "mk", value: kind }, { dim: "ms", value: series }]))} /></Cell>
      <Cell span={6}><DataGrid fill title="Emails" tab="messages" rows={gridRows("messages", c.slice, c.filters.x)} today={c.slice.today} onOpen={(r: any) => open(r as WMessage)} rowTitle="Open this traveler's page" /></Cell>
    </PageGrid>
  );
}

// ── Leads ────────────────────────────────────────────────────────────────────

const LEAD_TONE: Record<string, string> = { new: "bg-blue-500", contacted: "bg-amber-500", booked: "bg-green-600", declined: "bg-slate-400" };

export function LeadsPage({ c }: { c: PageCtx }) {
  const k = leadKpis(c.slice);
  const ix = crossValue(c.filters, "ix");
  const n = (st: string) => k.byStatus.find((x) => x.status === st)?.count ?? 0;
  return (
    <PageGrid kpis={<>
      <KpiCard label="New this week" value={String(k.newThisWeek)} caption="replies from the group pages in the last 7 days" />
      <KpiCard label="All leads" value={String(k.total)} caption="people who replied to a group page" />
      <KpiCard label="Contacted" value={String(n("contacted"))} caption="leads you have talked to" onClick={() => c.cross({ dim: "ix", value: "contacted" })} active={ix === "contacted"} />
      <KpiCard label="Booked" value={String(n("booked"))} tone={n("booked") ? "good" : undefined} caption="leads who booked a cabin" onClick={() => c.cross({ dim: "ix", value: "booked" })} active={ix === "booked"} />
    </>}>
      <Cell span={4}><Box title="Leads by status" hint="Click a bar to list only those leads.">
        <ClickBars rows={k.byStatus.filter((x) => x.count > 0).map((x) => ({ key: x.status, label: x.status, value: x.count, tone: LEAD_TONE[x.status] }))} active={ix} onPick={(st) => c.cross({ dim: "ix", value: st })} unit={(v) => plural(v, "lead")} />
      </Box></Cell>
      <Cell span={8}><DataGrid fill title="Leads" tab="interests" rows={gridRows("interests", c.slice, c.filters.x)} today={c.slice.today} onOpen={(r: any) => c.drill("lead", r.id)} rowTitle="Open this lead's page" /></Cell>
    </PageGrid>
  );
}

export const PAGE_VIEW: Record<Page, (p: { c: PageCtx }) => React.ReactElement> = {
  overview: OverviewPage, cabins: CabinsPage, paperwork: PaperworkPage, money: MoneyPage, deadlines: DeadlinesPage, journey: JourneyPage, leads: LeadsPage,
};

/** The dimensions a page's own visuals cross-filter on (the rest are cleared when you change page). */
export const PAGE_CROSS: Record<Page, CrossDim[]> = {
  overview: [], cabins: ["cab"], paperwork: ["doc", "pws", "tf"], money: ["pay"], deadlines: ["dk"], journey: ["mk", "ms"], leads: ["ix"],
};
