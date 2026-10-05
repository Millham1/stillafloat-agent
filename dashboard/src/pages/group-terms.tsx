import React, { useState } from "react";
import { Card } from "@/components/ui/card";

// The quote's terms, kept on the group file for working the booking: where we are
// against the line's review dates, what a cancellation costs today (or on any date),
// and the other deadlines. Read-only: it shows what the confirmed read said.

type Row = Record<string, any>;

const day = (d: string | null | undefined) =>
  d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

export function GroupTerms({ terms, sailDate }: { terms: Row | null | undefined; sailDate: string | null | undefined }) {
  const t = terms ?? {};
  const reviews: Row[] = t.allotment_reviews ?? [];
  const penalties: Row[] = t.cancellation_schedule ?? [];
  const deadlines: Row[] = t.deadlines ?? [];
  const today = iso(new Date());
  const [asOf, setAsOf] = useState(today);
  if (!reviews.length && !penalties.length && !deadlines.length) return null;

  const daysOut = sailDate ? daysBetween(asOf, sailDate.slice(0, 10)) : null;
  const hit = daysOut === null ? null : penalties.find((p) => daysOut <= p.from_days && daysOut >= p.to_days) ?? null;
  const beforeAll = daysOut !== null && penalties.length > 0 && daysOut > penalties[0]!.from_days;
  const nextReview = reviews.find((r) => r.date && r.date >= today);

  return (
    <div className="space-y-4">
      {penalties.length > 0 && (
        <Card>
          <div className="px-4 py-3 border-b flex flex-wrap items-center gap-3">
            <h3 className="font-semibold">If a cabin is cancelled</h3>
            <label className="text-sm text-muted-foreground flex items-center gap-2">
              on
              <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value || today)} className="px-2 py-1 text-sm rounded border bg-card text-foreground" />
            </label>
            {daysOut !== null && (
              <span className="text-sm font-semibold">
                {daysOut < 0 ? "after sailing" : `${daysOut} days before sailing`}: {beforeAll ? "no charge stated" : hit ? (hit.penalty ?? (hit.percent != null ? `${hit.percent}%` : "—")) : "—"}
              </span>
            )}
          </div>
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/30 text-muted-foreground"><th className="text-left px-3 py-2">Cancel between</th><th className="text-right px-3 py-2">Days before sailing</th><th className="text-left px-3 py-2">Charge</th></tr></thead>
            <tbody className="divide-y divide-border">
              {penalties.map((r, i) => {
                const live = hit === r;
                return (
                  <tr key={i} className={live ? "bg-amber-500/15 font-semibold" : ""}>
                    <td className="px-3 py-2">{day(r.from_date)} to {day(r.to_date)}</td>
                    <td className="px-3 py-2 text-right">{r.from_days} to {r.to_days}</td>
                    <td className="px-3 py-2">{r.penalty ?? (r.percent != null ? `${r.percent}%` : "—")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {t.cancellation_note && <p className="px-3 py-2 text-xs text-muted-foreground">{t.cancellation_note}</p>}
        </Card>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {reviews.length > 0 && (
          <Card>
            <div className="px-4 py-3 border-b"><h3 className="font-semibold">When the line takes cabins back</h3></div>
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/30 text-muted-foreground"><th className="text-left px-3 py-2">Date</th><th className="text-right px-3 py-2">Days before</th><th className="text-right px-3 py-2">Unsold taken back</th></tr></thead>
              <tbody className="divide-y divide-border">
                {reviews.map((r, i) => (
                  <React.Fragment key={i}>
                    <tr className={r === nextReview ? "bg-amber-500/15 font-semibold" : r.date && r.date < today ? "text-muted-foreground" : ""}>
                      <td className="px-3 py-2">{day(r.date)}{r === nextReview ? " · next" : ""}</td>
                      <td className="px-3 py-2 text-right">{r.days_before ?? "—"}</td>
                      <td className="px-3 py-2 text-right">{r.percent_retaken != null ? `${r.percent_retaken}%` : "—"}</td>
                    </tr>
                    {r.note && <tr><td colSpan={3} className="px-3 pb-2 text-xs text-muted-foreground">{r.note}</td></tr>}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </Card>
        )}
        {deadlines.length > 0 && (
          <Card>
            <div className="px-4 py-3 border-b"><h3 className="font-semibold">Other deadlines in the quote</h3></div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {deadlines.map((d, i) => (
                  <tr key={i} className={d.date && d.date < today ? "text-muted-foreground" : ""}>
                    <td className="px-3 py-2 whitespace-nowrap align-top">{day(d.date)}</td>
                    <td className="px-3 py-2 whitespace-nowrap align-top text-muted-foreground">{d.days_before} days before</td>
                    <td className="px-3 py-2">{d.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </div>
  );
}
