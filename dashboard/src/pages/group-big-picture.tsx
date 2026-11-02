import React, { useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { AlertTriangle, BarChart3, ExternalLink } from "lucide-react";
import { ANALYTICS_KEY, ANALYTICS_STALE_MS, fetchAnalytics, groupBookingsHref } from "@/lib/group-api";
import { DUE_WINDOW_DAYS, LEADS_WINDOW_DAYS, bigPicture, shortDate } from "@/lib/group-workspace";
import { money } from "./group-workspace-parts";

// The big picture on the Group Bookings tab: one band of numbers across every active group and the next five deadlines.
// It reads the same single request as the workspace (GET /api/groups/analytics), so the two always agree.
// Mark 2026-10-19: "the group booking tab in the business dashboard should give the 'big picture', the power BI should be the workhorse."

function Tile({ label, value, caption, bad, captionBad }: { label: string; value: string; caption: string; bad?: boolean; captionBad?: boolean }) {
  return (
    <div className={`rounded-md border p-3 ${bad ? "border-red-300 bg-red-50/50 dark:bg-red-950/20" : "bg-card"}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-xl font-bold leading-tight ${bad ? "text-red-600" : ""}`}>{value}</div>
      <div className={`text-xs ${captionBad ? "text-red-600 font-medium" : "text-muted-foreground"}`}>{caption}</div>
    </div>
  );
}

const when = (n: number) => (n === 0 ? "today" : n > 0 ? `in ${n} day${n === 1 ? "" : "s"}` : `${-n} day${n === -1 ? "" : "s"} ago`);

export function GroupBigPicture() {
  const { data, error, isLoading } = useQuery({ queryKey: ANALYTICS_KEY, queryFn: fetchAnalytics, staleTime: ANALYTICS_STALE_MS });
  const bp = useMemo(() => (data ? bigPicture(data) : null), [data]);
  const k = bp?.kpis;

  return (
    <section aria-label="The big picture">
      <Card>
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b flex-wrap">
          <div>
            <h3 className="font-semibold">The big picture</h3>
            <p className="text-xs text-muted-foreground">Every active group at a glance. The Group Bookings app is where the detail is.</p>
          </div>
          <div className="flex items-center gap-2">
            {/* Mark 2026-10-25: Group Bookings is its own app, opened in its own tab; the dashboard keeps only these highlights */}
            <a href={groupBookingsHref()} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm px-4 py-1.5 rounded-md bg-primary text-primary-foreground font-medium"><BarChart3 className="w-4 h-4" /> Open Group Bookings <ExternalLink className="w-3.5 h-3.5" /></a>
          </div>
        </div>

        {isLoading && <p className="px-4 py-6 text-sm text-muted-foreground">Loading the numbers…</p>}
        {error && !data && (
          <p className="px-4 py-4 text-sm text-red-700 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> The big picture could not load: {(error as Error).message}</p>
        )}
        {bp && k && bp.activeGroups === 0 && <p className="px-4 py-6 text-sm text-muted-foreground">No active groups yet. Open a group file below and its numbers will appear here.</p>}
        {bp && k && bp.activeGroups > 0 && (
          <div className="p-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
            <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] content-start">
              <Tile label="Active groups" value={String(bp.activeGroups)} caption={bp.needAttention > 0 ? `${bp.needAttention} need${bp.needAttention === 1 ? "s" : ""} attention` : "none need attention"} captionBad={bp.needAttention > 0} />
              <Tile label="Cabins booked" value={`${k.cabinsBooked} of ${k.cabinsBlock}`} caption={`cabins · ${k.cabinsHeld} held`} />
              <Tile label="Travelers signed" value={k.signedPct === null ? "—" : `${k.signedPct}%`} caption={`${k.signedPeople} of ${k.signedOf} travelers`} />
              <Tile label={`Due in ${DUE_WINDOW_DAYS} days`} value={money(k.dueNext30)} caption={`dollars · ${k.dueNext30Count} payment${k.dueNext30Count === 1 ? "" : "s"}`} />
              <Tile label="Overdue" value={money(k.overdue)} caption={`dollars · ${k.overdueCount} payment${k.overdueCount === 1 ? "" : "s"}`} bad={k.overdueCount > 0} />
              <Tile label="Leads this week" value={String(k.newInterests)} caption={`replies in the last ${LEADS_WINDOW_DAYS} days`} />
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Next deadlines</div>
              {bp.next.length === 0 ? <p className="text-sm text-muted-foreground">Nothing dated is coming up.</p> : (
                <ul className="divide-y divide-border rounded-md border bg-card">
                  {bp.next.map((d, i) => (
                    <li key={`${d.groupId}-${d.date}-${i}`}>
                      <Link href={`/groups/${d.groupId}#attention`}>
                        <span className="flex items-baseline gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-muted/40">
                          <span className={`w-14 shrink-0 tabular-nums ${d.daysOut < 0 ? "text-red-600 font-semibold" : "text-muted-foreground"}`} title={when(d.daysOut)}>{shortDate(d.date)}</span>
                          <span className="min-w-0">
                            <span className="font-medium">{d.groupName}</span>
                            <span className="text-muted-foreground"> · {d.label}</span>
                            {d.daysOut < 0 && <span className="text-red-600"> · {when(d.daysOut)}</span>}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}
