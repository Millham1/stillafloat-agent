import React from "react";
import { Card } from "@/components/ui/card";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from "recharts";
import { Check } from "lucide-react";
import {
  KIND_LABEL, addDays, longDate, shortDate,
  type Cell as MatrixCell, type Cross, type DeadlineKind, type FunnelStep, type JourneyBar, type MatrixModel, type MoneyModel, type TimelineModel, type TimelinePoint,
} from "@/lib/group-workspace";
import { money } from "./group-workspace-parts";

// The five visuals of the Group Bookings Workspace. Every one is a plain picture of numbers that lib/group-workspace.ts
// worked out; a click on a part of it hands back a Group slicer change or a cross-filter, and the page does the rest.

export function Visual({ title, caption, children, className = "", fill = false }: { title: string; caption?: React.ReactNode; children: React.ReactNode; className?: string; fill?: boolean }) {
  // fill (Mark 2026-10-25, the report pages): the visual takes the box it is given and its chart grows to fit, so a page is one screen
  return (
    <Card className={fill ? `p-3 h-full min-h-0 flex flex-col ${className}` : `p-4 ${className}`}>
      <div className={fill ? "mb-1.5 shrink-0" : "mb-2"}>
        <h3 className="text-sm font-semibold">{title}</h3>
        {caption && <p className="text-xs text-muted-foreground mt-0.5">{caption}</p>}
      </div>
      {fill ? <div className="flex-1 min-h-0 flex flex-col">{children}</div> : children}
    </Card>
  );
}

/** In a filled visual the figure and its chart take the remaining height; otherwise the chart keeps its fixed height. */
const fig = (fill: boolean | undefined) => (fill ? "flex-1 min-h-0 flex flex-col m-0" : undefined);
const ch = (fill: boolean | undefined, h: string) => (fill ? "aspect-auto w-full flex-1 min-h-[140px]" : `aspect-auto ${h} w-full`.replace("  ", " "));

const Nothing = ({ children }: { children: React.ReactNode }) => (
  <div className="h-40 flex items-center justify-center text-sm text-muted-foreground text-center px-6">{children}</div>
);

/** Colours for light and dark; the meaning is always also written in words (legend, labels, tooltips), never colour alone. */
const C = {
  paid: { light: "#15803d", dark: "#4ade80" },
  due: { light: "#1d4ed8", dark: "#60a5fa" },
  overdue: { light: "#b91c1c", dark: "#f87171" },
  sent: { light: "#15803d", dark: "#4ade80" },
  planned: { light: "#1d4ed8", dark: "#60a5fa" },
  failed: { light: "#b91c1c", dark: "#f87171" },
  skipped: { light: "#94a3b8", dark: "#64748b" },
  funnel: { light: "#1e3a8a", dark: "#93c5fd" },
};
const cfg = (...keys: Array<[keyof typeof C, string]>): ChartConfig => Object.fromEntries(keys.map(([k, label]) => [k, { label, theme: C[k] }]));

function Tip({ title, lines }: { title: string; lines: Array<{ color?: string; text: string }> }) {
  return (
    <div className="rounded-md border bg-card text-card-foreground px-3 py-2 text-xs shadow-md max-w-xs">
      <div className="font-semibold mb-1">{title}</div>
      {lines.map((l, i) => <div key={i} className="flex items-center gap-1.5">{l.color && <span className="inline-block h-2 w-2 rounded-sm" style={{ background: l.color }} />}{l.text}</div>)}
    </div>
  );
}

// ── 1. Pipeline funnel ────────────────────────────────────────────────────────

export function FunnelVisual({ steps, active, onStep, fill }: { steps: FunnelStep[]; active: Cross[]; onStep: (s: FunnelStep) => void; fill?: boolean }) {
  const data = steps.map((s) => ({ ...s, axis: s.label, text: `${s.value.toLocaleString("en-US")} ${s.value === 1 ? s.unitOne : s.unit}` }));
  const isActive = (s: FunnelStep) => !!s.cross && active.some((c) => c.dim === s.cross!.dim && c.value === s.cross!.value);
  return (
    <Visual fill={fill} title="Pipeline" caption="From a lead to a final payment. Click a step to list its rows below.">
      <figure className={fig(fill)} aria-label={`Pipeline: ${data.map((d) => `${d.text} ${d.label.toLowerCase()}`).join(", ")}`}>
        <ChartContainer config={cfg(["funnel", "Count"])} className={ch(fill, "h-[240px]")}>
          <BarChart data={data} layout="vertical" margin={{ left: 4, right: 12, top: 4, bottom: 4 }}>
            <CartesianGrid horizontal={false} />
            <XAxis type="number" hide domain={[0, (max: number) => Math.max(1, Math.ceil(max * 1.45))]} />
            <YAxis type="category" dataKey="axis" width={128} tickLine={false} axisLine={false} />
            <Tooltip cursor={{ fill: "hsl(var(--muted))" }} content={({ payload }) => payload?.length ? <Tip title={payload[0]!.payload.label} lines={[{ text: payload[0]!.payload.text }]} /> : null} />
            <Bar dataKey="value" radius={4} cursor="pointer" onClick={(d: any) => onStep(d as FunnelStep)} maxBarSize={34}>
              {data.map((d) => <Cell key={d.key} fill="var(--color-funnel)" fillOpacity={isActive(d) ? 1 : 0.82} stroke={isActive(d) ? "currentColor" : "none"} strokeWidth={2} />)}
              {/* a plain <text>, so a short bar's label is never wrapped onto two lines */}
              <LabelList dataKey="text" content={({ x, y, width, height, value }: any) => <text x={Number(x) + Number(width) + 6} y={Number(y) + Number(height) / 2} dy={4} className="fill-foreground" fontSize={12}>{value}</text>} />
            </Bar>
          </BarChart>
        </ChartContainer>
      </figure>
    </Visual>
  );
}

// ── 2. Money by week ──────────────────────────────────────────────────────────

export function MoneyVisual({ model, active, onSegment, fill }: { model: MoneyModel; active: string | null; onSegment: (status: "paid" | "due" | "overdue") => void; fill?: boolean }) {
  const total = model.buckets.reduce((n, b) => n + b.paid + b.due + b.overdue, 0);
  const dim = (status: string) => (active && active !== status ? 0.35 : 1);
  return (
    <Visual
      fill={fill}
      title="Money by week"
      caption={<>Dollars falling due in each of the next 26 weeks. Overdue is everything unpaid past its date.{model.noDateCount > 0 && <> {model.noDateCount} unpaid payment{model.noDateCount === 1 ? " has" : "s have"} no date ({money(model.noDate)}) and {model.noDateCount === 1 ? "is" : "are"} not on the chart.</>}{model.laterCount > 0 && <> {money(model.later)} falls due after these 26 weeks.</>}</>}
    >
      {total === 0 ? <Nothing>No payments fall due in the next 26 weeks and none are overdue.</Nothing> : (
        <figure className={fig(fill)} aria-label={`Money by week: ${money(model.buckets[0]!.overdue)} overdue, ${money(model.buckets.reduce((n, b) => n + b.due, 0))} still due and ${money(model.buckets.reduce((n, b) => n + b.paid, 0))} paid across the next 26 weeks`}>
          <ChartContainer config={cfg(["paid", "Paid"], ["due", "Still due"], ["overdue", "Overdue"])} className={ch(fill, "h-[260px]")}>
            <BarChart data={model.buckets} margin={{ top: 18, right: 8, left: 0, bottom: 22 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} interval={2} tick={{ fontSize: 11 }} label={{ value: "week of", position: "insideBottom", offset: -14, fontSize: 11 }} />
              <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => (v >= 1000 ? `$${Math.round(v / 100) / 10}k` : `$${v}`)} label={{ value: "dollars ($)", angle: -90, position: "insideLeft", offset: -2, fontSize: 11, style: { textAnchor: "middle" } }} />
              <Tooltip
                cursor={{ fill: "hsl(var(--muted))", opacity: 0.5 }}
                content={({ payload }) => {
                  const b = payload?.[0]?.payload as MoneyModel["buckets"][number] | undefined;
                  if (!b) return null;
                  const lines = [
                    ...(b.key === "overdue" ? [{ color: "var(--color-overdue)", text: `Overdue: ${money(b.overdue)} (${b.overdueCount} payment${b.overdueCount === 1 ? "" : "s"})` }] : []),
                    ...(b.key !== "overdue" ? [
                      { color: "var(--color-due)", text: `Still due: ${money(b.due)} (${b.dueCount})` },
                      { color: "var(--color-paid)", text: `Paid: ${money(b.paid)} (${b.paidCount})` },
                    ] : []),
                  ];
                  return <Tip title={b.weekOf ? `Week of ${longDate(b.weekOf)}` : "Overdue (before today)"} lines={lines} />;
                }}
              />
              <Bar dataKey="overdue" stackId="m" fill="var(--color-overdue)" fillOpacity={dim("overdue")} cursor="pointer" onClick={() => onSegment("overdue")} />
              <Bar dataKey="paid" stackId="m" fill="var(--color-paid)" fillOpacity={dim("paid")} cursor="pointer" onClick={() => onSegment("paid")} />
              <Bar dataKey="due" stackId="m" fill="var(--color-due)" fillOpacity={dim("due")} cursor="pointer" radius={[3, 3, 0, 0]} onClick={() => onSegment("due")} />
            </BarChart>
          </ChartContainer>
          <LegendRow items={[["Overdue", C.overdue], ["Paid", C.paid], ["Still due", C.due]]} hint="Click a colour to list those payments below." />
        </figure>
      )}
    </Visual>
  );
}

function LegendRow({ items, hint }: { items: Array<[string, { light: string; dark: string }]>; hint?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mt-1">
      {items.map(([label, c]) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: c.light }} />{label}
        </span>
      ))}
      {hint && <span className="ml-auto">{hint}</span>}
    </div>
  );
}

// ── 3. Deadlines timeline ─────────────────────────────────────────────────────

const KIND_STYLE: Record<DeadlineKind, { light: string; dark: string; shape: "diamond" | "square" | "triangle" | "cross" | "ring" | "dot" | "star" }> = {
  deposit: { light: "#b45309", dark: "#fbbf24", shape: "diamond" },
  final: { light: "#1d4ed8", dark: "#60a5fa", shape: "square" },
  names: { light: "#7e22ce", dark: "#c084fc", shape: "triangle" },
  recall: { light: "#b91c1c", dark: "#f87171", shape: "cross" },
  line: { light: "#0f766e", dark: "#2dd4bf", shape: "ring" },
  journey: { light: "#64748b", dark: "#94a3b8", shape: "dot" },
  sail: { light: "#07183f", dark: "#e2e8f0", shape: "star" },
};
const KINDS = Object.keys(KIND_STYLE) as DeadlineKind[];

function Marker({ shape, size = 7, color }: { shape: (typeof KIND_STYLE)[DeadlineKind]["shape"]; size?: number; color: string }) {
  const s = size;
  switch (shape) {
    case "diamond": return <polygon points={`0,${-s - 1} ${s + 1},0 0,${s + 1} ${-s - 1},0`} fill={color} />;
    case "square": return <rect x={-s} y={-s} width={2 * s} height={2 * s} fill={color} />;
    case "triangle": return <polygon points={`0,${-s - 1} ${s + 1},${s} ${-s - 1},${s}`} fill={color} />;
    case "cross": return <path d={`M${-s},${-s} L${s},${s} M${-s},${s} L${s},${-s}`} stroke={color} strokeWidth={3} fill="none" />;
    case "ring": return <circle r={s} fill="none" stroke={color} strokeWidth={2.5} />;
    case "dot": return <circle r={s - 2.5} fill={color} />;
    case "star": return <polygon points="0,-9 2.6,-3 9,-2.8 4,1.6 5.6,8 0,4.4 -5.6,8 -4,1.6 -9,-2.8 -2.6,-3" fill={color} />;
  }
}

function GroupTick({ x, y, payload, rows, onGroup }: { x?: number; y?: number; payload?: { value: number }; rows: TimelineModel["rows"]; onGroup: (id: string, additive: boolean) => void }) {
  const row = rows.find((r) => r.y === payload?.value);
  if (!row) return null;
  const name = row.groupName.length > 20 ? `${row.groupName.slice(0, 19)}…` : row.groupName;
  return (
    <g transform={`translate(${x},${y})`} className="cursor-pointer" role="button" tabIndex={0} aria-label={`Show only ${row.groupName}`}
      onClick={(e) => onGroup(row.groupId, e.shiftKey || e.metaKey || e.ctrlKey)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onGroup(row.groupId, e.shiftKey || e.metaKey || e.ctrlKey); }}>
      <title>{row.groupName}</title>
      <text x={-8} y={0} dy={4} textAnchor="end" className="fill-foreground underline decoration-dotted" fontSize={12}>{name}</text>
    </g>
  );
}

export function TimelineVisual({ model, today, onGroup, onKind, fill }: {
  model: TimelineModel; today: string; onGroup: (id: string, additive: boolean) => void; onKind: (k: DeadlineKind) => void; fill?: boolean;
}) {
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const col = (k: DeadlineKind) => (dark ? KIND_STYLE[k].dark : KIND_STYLE[k].light);
  const height = Math.max(200, model.rows.length * 52 + 70);
  const ticks = [-14, 0, 14, 28, 42, 56, 70, 84, 98, 112].filter((d) => d <= model.to);
  const kindsHere = KINDS.filter((k) => model.points.some((p) => p.kind === k));
  return (
    <Visual fill={fill} title="Deadlines, next 120 days" caption="One row per group. Click a group's name to show only that group; click a marker's colour in the key to list that kind below.">
      {model.rows.length === 0 ? <Nothing>No dated deadlines in the next 120 days for these groups.</Nothing> : (
        <figure className={fig(fill)} aria-label={`Deadline timeline: ${model.points.length} dated items across ${model.rows.length} group${model.rows.length === 1 ? "" : "s"}`}>
          <ChartContainer config={{}} className={ch(fill, "")} style={fill ? undefined : { height }}>
            <ScatterChart margin={{ top: 22, right: 18, bottom: 26, left: 4 }}>
              <CartesianGrid />
              <XAxis type="number" dataKey="x" domain={[model.from, model.to]} ticks={ticks} allowDataOverflow tickFormatter={(d: number) => shortDate(addDays(today, d))} tick={{ fontSize: 11 }} label={{ value: "date", position: "insideBottom", offset: -14, fontSize: 11 }} />
              <YAxis type="number" dataKey="y" domain={[-0.6, model.rows.length - 0.4]} ticks={model.rows.map((r) => r.y)} interval={0} reversed width={150} tickLine={false}
                tick={<GroupTick rows={model.rows} onGroup={onGroup} />} />
              <ZAxis range={[90, 90]} />
              <ReferenceLine x={0} stroke="currentColor" strokeDasharray="4 3" label={{ value: "today", position: "top", fontSize: 11 }} />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                content={({ payload }) => {
                  const p = payload?.[0]?.payload as TimelinePoint | undefined;
                  if (!p) return null;
                  const when = p.daysOut === 0 ? "today" : p.daysOut > 0 ? `in ${p.daysOut} day${p.daysOut === 1 ? "" : "s"}` : `${-p.daysOut} day${p.daysOut === -1 ? "" : "s"} ago`;
                  return <Tip title={p.label} lines={[
                    { text: p.groupName }, { text: `${longDate(p.date)} · ${when}` },
                    { text: `${KIND_LABEL[p.kind]}${p.done ? " · already met" : ""}${p.state === "due" ? " · goes out on the next run" : ""}` },
                    ...(p.detail ? [{ text: p.detail }] : []),
                  ]} />;
                }}
              />
              {KINDS.map((k) => (
                <Scatter key={k} name={KIND_LABEL[k]} data={model.points.filter((p) => p.kind === k)} isAnimationActive={false}
                  shape={(props: any) => <g transform={`translate(${props.cx},${props.cy})`} opacity={props.payload?.done ? 0.4 : 1}><Marker shape={KIND_STYLE[k].shape} color={col(k)} /></g>} />
              ))}
            </ScatterChart>
          </ChartContainer>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs mt-1">
            {kindsHere.map((k) => (
              <button key={k} type="button" onClick={() => onKind(k)} className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
                <svg width="16" height="16" viewBox="-10 -10 20 20" aria-hidden="true"><Marker shape={KIND_STYLE[k].shape} color={col(k)} size={6} /></svg>{KIND_LABEL[k]}
              </button>
            ))}
            <span className="ml-auto text-muted-foreground">Faded = already met</span>
          </div>
        </figure>
      )}
    </Visual>
  );
}

// ── 4. Journey status ─────────────────────────────────────────────────────────

export function JourneyVisual({ bars, active, onSegment, fill }: {
  bars: JourneyBar[]; active: Cross[]; onSegment: (kind: string, series: "planned" | "sent" | "failed") => void; fill?: boolean;
}) {
  const total = bars.reduce((n, b) => n + b.planned + b.sent + b.failed + b.skipped, 0);
  const picked = active.find((c) => c.dim === "mk")?.value ?? null;
  const dim = (kind: string) => (picked && picked !== kind ? 0.4 : 1);
  return (
    <Visual fill={fill} title="Journey emails" caption="Each email in the journey, by how many travelers it is planned for, has gone to, or failed for. Click a part to list those emails (or, for planned, those dates).">
      {total === 0 ? <Nothing>No journey emails are planned for these groups yet.</Nothing> : (
        <figure className={fig(fill)} aria-label={`Journey emails: ${bars.reduce((n, b) => n + b.sent, 0)} sent, ${bars.reduce((n, b) => n + b.failed, 0)} failed, ${bars.reduce((n, b) => n + b.planned, 0)} planned`}>
          <ChartContainer config={cfg(["sent", "Sent"], ["failed", "Failed"], ["planned", "Planned"], ["skipped", "Skipped"])} className={ch(fill, "h-[300px]")}>
            <BarChart data={bars} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 22 }}>
              <CartesianGrid horizontal={false} />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} label={{ value: "emails (one per traveler)", position: "insideBottom", offset: -12, fontSize: 11 }} />
              <YAxis type="category" dataKey="label" width={92} tickLine={false} axisLine={false} />
              <Tooltip
                cursor={{ fill: "hsl(var(--muted))", opacity: 0.5 }}
                content={({ payload }) => {
                  const b = payload?.[0]?.payload as JourneyBar | undefined;
                  return b ? <Tip title={b.label} lines={[
                    { color: "var(--color-sent)", text: `Sent: ${b.sent}` }, { color: "var(--color-failed)", text: `Failed: ${b.failed}` },
                    { color: "var(--color-planned)", text: `Planned: ${b.planned}` }, { color: "var(--color-skipped)", text: `Skipped: ${b.skipped}` },
                  ]} /> : null;
                }}
              />
              <Bar dataKey="sent" stackId="j" fill="var(--color-sent)" cursor="pointer" onClick={(d: any) => onSegment(d.kind, "sent")}>{bars.map((b) => <Cell key={b.kind} fillOpacity={dim(b.kind)} />)}</Bar>
              <Bar dataKey="failed" stackId="j" fill="var(--color-failed)" cursor="pointer" onClick={(d: any) => onSegment(d.kind, "failed")}>{bars.map((b) => <Cell key={b.kind} fillOpacity={dim(b.kind)} />)}</Bar>
              <Bar dataKey="planned" stackId="j" fill="var(--color-planned)" cursor="pointer" onClick={(d: any) => onSegment(d.kind, "planned")}>{bars.map((b) => <Cell key={b.kind} fillOpacity={dim(b.kind)} />)}</Bar>
              <Bar dataKey="skipped" stackId="j" fill="var(--color-skipped)" fillOpacity={0.55}>{bars.map((b) => <Cell key={b.kind} fillOpacity={0.5 * dim(b.kind)} />)}</Bar>
            </BarChart>
          </ChartContainer>
          <LegendRow items={[["Sent", C.sent], ["Failed", C.failed], ["Planned", C.planned], ["Skipped", C.skipped]]} />
        </figure>
      )}
    </Visual>
  );
}

// ── 5. Paperwork matrix ───────────────────────────────────────────────────────

const CELL: Record<MatrixCell, { text: string; cls: string; icon?: boolean }> = {
  signed: { text: "Signed", cls: "bg-green-100 text-green-900 dark:bg-green-950/50 dark:text-green-200", icon: true },
  pending: { text: "Pending", cls: "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200" },
  "n/a": { text: "—", cls: "text-muted-foreground" },
};

export function PaperworkMatrix({ model, active, onCell, onGroup, onTraveler, fill, title, caption }: {
  model: MatrixModel; active: Cross[]; onCell: (docKey: string, status: "signed" | "pending") => void; onGroup: (id: string, additive: boolean) => void;
  /** Mark 2026-10-25: a traveler's name opens that traveler's page. */
  onTraveler?: (id: string) => void; fill?: boolean; title?: string; caption?: string;
}) {
  const doc = active.find((c) => c.dim === "doc")?.value ?? null;
  const st = active.find((c) => c.dim === "pws")?.value ?? null;
  const people = model.groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <Visual fill={fill} title={title ?? "Paperwork matrix"} caption={caption ?? "Every traveler against every document they are asked to sign. Click a cell to list that document's rows below; click a group's name to show only that group."}>
      {people === 0 ? <Nothing>No travelers with paperwork to show for these groups.</Nothing> : (
        <div className={fill ? "flex-1 min-h-0 overflow-auto border rounded-md" : "overflow-auto max-h-[460px] border rounded-md"}>
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b">
                <th className={`text-left px-2 py-2 font-semibold ${fill ? "min-w-[8.5rem]" : "min-w-[11rem]"}`}>Traveler</th>
                {model.columns.map((c) => <th key={c.key} className={`px-1.5 py-2 font-semibold text-center ${fill ? "min-w-[4.6rem]" : "min-w-[6.5rem]"}`}>{c.title}</th>)}
                <th className={`px-2 py-2 font-semibold text-center ${fill ? "min-w-[3.5rem]" : "min-w-[5rem]"}`}>Signed</th>
              </tr>
            </thead>
            <tbody>
              {model.groups.map((g) => (
                <React.Fragment key={g.groupId}>
                  <tr className="bg-muted/50 border-y">
                    <td colSpan={model.columns.length + 2} className="px-2 py-1.5">
                      <button type="button" className="font-semibold underline decoration-dotted" onClick={(e) => onGroup(g.groupId, e.shiftKey || e.metaKey || e.ctrlKey)}>{g.groupName}</button>
                      <span className="ml-2 text-muted-foreground">{g.rows.length} traveler{g.rows.length === 1 ? "" : "s"}</span>
                    </td>
                  </tr>
                  {g.rows.map((r) => (
                    <tr key={r.travelerId} className="border-b last:border-b-0">
                      <td className="px-2 py-1">{onTraveler
                        ? <button type="button" className="font-medium underline decoration-dotted text-left hover:text-primary" onClick={() => onTraveler(r.travelerId)} title={`Open ${r.name}'s page`}>{r.name}</button>
                        : <span className="font-medium">{r.name}</span>}{r.cabinNum && <span className="text-muted-foreground"> · cabin {r.cabinNum}</span>}</td>
                      {model.columns.map((c) => {
                        const cell = r.cells[c.key] ?? "n/a";
                        const look = CELL[cell];
                        const on = doc === c.key && st === cell;
                        const body = <>{look.icon && <Check className="w-3 h-3 inline mr-0.5 -mt-0.5" aria-hidden="true" />}{look.text}</>;
                        return (
                          <td key={c.key} className={`px-1 py-1 text-center ${on ? "outline outline-2 outline-ring -outline-offset-2" : ""}`}>
                            {cell === "n/a"
                              ? <span className={look.cls} title="Not part of this traveler's paperwork">{body}</span>
                              : <button type="button" onClick={() => onCell(c.key, cell)} className={`w-full rounded px-1.5 py-0.5 font-medium ${look.cls}`} title={`${c.title}: ${look.text.toLowerCase()} — list these rows`}>{body}</button>}
                          </td>
                        );
                      })}
                      <td className="px-2 py-1 text-center tabular-nums">{r.signed} of {r.required}</td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Visual>
  );
}
