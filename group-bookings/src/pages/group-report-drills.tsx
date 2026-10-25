import React from "react";
import { Card } from "@/components/ui/card";
import { ExternalLink } from "lucide-react";
import { longDate, type WorkspaceData } from "@/lib/group-workspace";
import {
  cabinDetail, groupDetail, leadDetail, paymentDetail, travelerDetail, type Drill, type DrillKind,
} from "@/lib/group-report";
import { Pill, money } from "./group-workspace-parts";
import { groupFileHref } from "@/lib/group-api";
import { CopyButton, TravelerPaperworkPanel } from "./group-workspace-actions";
import { Box, DrillHeader, Facts, KpiCard, RowLink } from "./group-report-shell";

// The drill-through pages of the Group Bookings Workspace (Mark 2026-10-25): a click on a traveler, group, cabin, payment or
// lead opens its own one-screen page, with a back arrow to the report page it came from. Everything here is read from ALL the
// data (lib/group-report.ts), so a slicer never hides the page you opened. Editing a file's fields stays on the group's file.

const when = (d: string | null | undefined) => (d ? longDate(d.slice(0, 10)) : "—");
const PAY_TONE: Record<string, "green" | "blue" | "red" | "slate"> = { paid: "green", due: "blue", overdue: "red", "no date": "slate" };
const CABIN_TONE: Record<string, "green" | "amber" | "blue" | "slate" | "red"> = { booked: "green", held: "amber", offered: "blue", released: "slate", cancelled: "red" };

/** A drill page: header, four key numbers, three boxes side by side; one screen. */
function DrillPage({ header, kpis, children }: { header: React.ReactNode; kpis: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 lg:h-full lg:min-h-0">
      {header}
      <section aria-label="Key numbers" className="grid gap-3 grid-cols-2 xl:grid-cols-4 shrink-0">{kpis}</section>
      <div className="grid gap-3 lg:flex-1 lg:min-h-0 lg:grid-cols-3 [&>*]:min-h-[260px] lg:[&>*]:min-h-0">{children}</div>
    </div>
  );
}

function Gone({ what, onBack, backTo }: { what: string; onBack: () => void; backTo: string }) {
  return (
    <div className="space-y-3">
      <DrillHeader backTo={backTo} onBack={onBack} title={`This ${what} is not on file any more`} />
      <Card className="p-8 text-center text-muted-foreground">It may have been removed from its group file. Go back and pick another.</Card>
    </div>
  );
}

const fileButton = (go: () => void, label = "Open the group file") => (
  <button type="button" onClick={go} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border bg-card hover:bg-muted/50"><ExternalLink className="w-3.5 h-3.5" /> {label}</button>
);

export function DrillView({ data, drill, backTo, onBack, onDrill }: {
  data: WorkspaceData; drill: Drill; backTo: string; onBack: () => void; onDrill: (kind: DrillKind, id: string) => void;
}) {
  // Editing a file's fields stays on the group's file; it opens in a new tab so Group Bookings stays where it is.
  const openFile = (groupId: string, section = "") => { window.open(groupFileHref(groupId, section), "_blank", "noopener"); };

  if (drill.kind === "traveler") {
    const d = travelerDetail(data, drill.id);
    if (!d) return <Gone what="traveler" onBack={onBack} backTo={backTo} />;
    const t = d.t;
    return (
      <DrillPage
        header={<DrillHeader backTo={backTo} onBack={onBack} title={t.name} sub={[t.isLead ? "lead" : null, t.groupName, t.cabinNum ? `cabin ${t.cabinNum}` : d.cabin?.category ?? null, t.lang === "es" ? "Spanish" : "English"].filter(Boolean).join(" · ")}
          action={fileButton(() => openFile(t.groupId, "travelers"))} />}
        kpis={<>
          <KpiCard label="Documents signed" value={`${t.docsSigned} of ${t.docsRequired}`} tone={t.fullySigned ? "good" : undefined} caption={t.fullySigned ? "documents · all signed" : "documents"} />
          <KpiCard label="Link" value={t.formSentAt ? `Sent ${when(t.formSentAt)}` : "Not sent"} caption={t.email ? `to ${t.email}${t.formOpenedAt ? ` · opened ${when(t.formOpenedAt)}` : t.formSentAt ? " · not opened yet" : ""}` : "no email address on the file"} />
          <KpiCard label="Consent to e-signing" value={t.consentAt ? when(t.consentAt) : "Not yet"} caption="asked once, before the first signature" />
          <KpiCard label="Copies emailed" value={t.copiesSentAt ? when(t.copiesSentAt) : "—"} caption="sent when the last document is signed" />
        </>}>
        <Box title="Paperwork actions"><TravelerPaperworkPanel row={t} /></Box>
        <Box title="Documents" hint="Open any signed copy. A green shield means it carries our seal.">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card"><tr className="border-b text-xs text-muted-foreground"><th className="text-left py-1.5 pr-2 font-semibold">Document</th><th className="text-left py-1.5 pr-2 font-semibold">Status</th><th className="text-left py-1.5 pr-2 font-semibold">Signed</th><th className="text-left py-1.5 font-semibold">Copy</th></tr></thead>
            <tbody className="divide-y divide-border">
              {d.docs.map((p) => (
                <tr key={p.docKey}><td className="py-1.5 pr-2">{p.docTitle}</td><td className="py-1.5 pr-2"><Pill tone={p.status === "signed" ? "green" : "amber"}>{p.status}</Pill></td><td className="py-1.5 pr-2 whitespace-nowrap">{when(p.signedAt)}</td><td className="py-1.5"><CopyButton row={p} /></td></tr>
              ))}
              {d.docs.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-muted-foreground">No documents are asked of this traveler yet.</td></tr>}
            </tbody>
          </table>
        </Box>
        <Box title="Cabin and trip" hint="From the group file. Click a line to open it.">
          {d.group && <RowLink onClick={() => onDrill("group", d.group!.id)}><span className="text-muted-foreground w-24 shrink-0">Group</span>{d.group.name}</RowLink>}
          {d.cabin && <RowLink onClick={() => onDrill("cabin", d.cabin!.id)}><span className="text-muted-foreground w-24 shrink-0">Cabin</span>{[d.cabin.category, d.cabin.cabinNum, d.cabin.bookingNumber].filter(Boolean).join(" · ")}</RowLink>}
          {d.mates.map((m) => <RowLink key={m.id} onClick={() => onDrill("traveler", m.id)}><span className="text-muted-foreground w-24 shrink-0">Sharing with</span>{m.name}</RowLink>)}
          {d.payments.map((p) => <RowLink key={p.id} onClick={() => onDrill("payment", p.id)}><span className="text-muted-foreground w-24 shrink-0">{p.kind}</span>{money(p.amount)} · {p.dueDate ? when(p.dueDate) : "no date"} <span className="ml-auto"><Pill tone={PAY_TONE[p.status] ?? "slate"}>{p.status}</Pill></span></RowLink>)}
          <Facts rows={[["Sails", d.group?.sailDate ? `${when(d.group.sailDate)} · ${[d.group.cruiseLine, d.group.shipName].filter(Boolean).join(" · ")}` : "—"], ["Emails sent to them", d.messages.length ? d.messages.map((m) => `${m.kind}: ${m.status}`).join(", ") : "none yet"]]} />
        </Box>
      </DrillPage>
    );
  }

  if (drill.kind === "group") {
    const d = groupDetail(data, drill.id);
    if (!d) return <Gone what="group" onBack={onBack} backTo={backTo} />;
    const g = d.g;
    return (
      <DrillPage
        header={<DrillHeader backTo={backTo} onBack={onBack} title={g.name} sub={[g.status, [g.cruiseLine, g.shipName].filter(Boolean).join(" · "), g.sailDate ? `sails ${when(g.sailDate)}` : null].filter(Boolean).join(" · ")} action={fileButton(() => openFile(g.id))} />}
        kpis={<>
          <KpiCard label="Cabins booked" value={`${g.cabinsBooked} of ${g.cabinsTotal - g.cabinsReleased}`} caption={`cabins · ${g.cabinsHeld} held`} />
          <KpiCard label="Travelers fully signed" value={`${g.fullySigned} of ${g.travelersExpected}`} caption={`travelers · ${g.travelersOnFile} named so far`} />
          <KpiCard label="Still due" value={money(g.amountDue)} tone={g.amountOverdue > 0 ? "bad" : undefined} caption={g.amountOverdue > 0 ? `dollars · ${money(g.amountOverdue)} overdue` : "dollars · nothing overdue"} />
          <KpiCard label="Next deadline" value={g.nextDeadlineDate ? when(g.nextDeadlineDate) : "—"} caption={g.nextDeadlineLabel ?? "nothing dated ahead"} />
        </>}>
        <Box title={`Cabins (${d.cabins.length})`} hint="Click a cabin to open it.">
          {d.cabins.map((c) => <RowLink key={c.id} onClick={() => onDrill("cabin", c.id)}><span className="min-w-0 truncate">{[c.category, c.cabinNum, c.bookingNumber].filter(Boolean).join(" · ") || "Cabin"}</span><span className="ml-auto text-xs text-muted-foreground">{c.travelers || "no one yet"}</span><Pill tone={CABIN_TONE[c.status] ?? "slate"}>{c.status}</Pill></RowLink>)}
        </Box>
        <Box title={`Travelers (${d.travelers.length})`} hint="Click a traveler to open their page.">
          {d.travelers.map((t) => <RowLink key={t.id} onClick={() => onDrill("traveler", t.id)}><span className="min-w-0 truncate">{t.name}{t.isLead && <span className="text-xs text-muted-foreground"> (lead)</span>}</span><span className="ml-auto text-xs tabular-nums">{t.docsSigned} of {t.docsRequired}</span><Pill tone={t.fullySigned ? "green" : t.formSentAt ? "amber" : "slate"}>{t.fullySigned ? "signed" : t.formSentAt ? "sent" : "not sent"}</Pill></RowLink>)}
          {d.travelers.length === 0 && <p className="text-sm text-muted-foreground py-4">No travelers named yet.</p>}
        </Box>
        <Box title="Open deadlines and leads" hint="Soonest first.">
          <Facts rows={d.deadlines.slice(0, 8).map((x) => [when(x.date), <span key={x.label} className={x.daysOut < 0 ? "text-red-600 font-semibold" : ""}>{x.label}</span>])} />
          <div className="mt-3 text-xs font-semibold text-muted-foreground">Leads ({d.interests.length})</div>
          {d.interests.map((i) => <RowLink key={i.id} onClick={() => onDrill("lead", i.id)}><span>{i.name}</span><span className="ml-auto text-xs text-muted-foreground">{i.guests ? `party of ${i.guests}` : ""}</span><Pill tone="blue">{i.status}</Pill></RowLink>)}
        </Box>
      </DrillPage>
    );
  }

  if (drill.kind === "cabin") {
    const d = cabinDetail(data, drill.id);
    if (!d) return <Gone what="cabin" onBack={onBack} backTo={backTo} />;
    const c = d.c;
    return (
      <DrillPage
        header={<DrillHeader backTo={backTo} onBack={onBack} title={[c.category, c.cabinNum].filter(Boolean).join(" · ") || "Cabin"} sub={c.groupName} action={fileButton(() => openFile(c.groupId, "cabins"))} />}
        kpis={<>
          <KpiCard label="Status" value={c.status} caption={c.bookingNumber ? `booking ${c.bookingNumber}` : "no booking number yet"} />
          <KpiCard label="Cabin total" value={c.priceTotal === null ? "—" : money(c.priceTotal)} caption="dollars" />
          <KpiCard label="Deposit" value={c.depositAmount === null ? "—" : money(c.depositAmount)} caption="dollars" />
          <KpiCard label="Travelers" value={String(d.travelers.length)} caption={d.travelers.length ? "people in this cabin" : "no one named yet"} />
        </>}>
        <Box title="Travelers" hint="Click a traveler to open their page.">
          {d.travelers.map((t) => <RowLink key={t.id} onClick={() => onDrill("traveler", t.id)}><span>{t.name}</span><span className="ml-auto text-xs tabular-nums">{t.docsSigned} of {t.docsRequired} signed</span></RowLink>)}
          {d.travelers.length === 0 && <p className="text-sm text-muted-foreground py-4">No one named in this cabin yet.</p>}
        </Box>
        <Box title="Payments" hint="Click a payment to open it.">
          {d.payments.map((p) => <RowLink key={p.id} onClick={() => onDrill("payment", p.id)}><span className="w-20 shrink-0">{p.kind}</span><span>{money(p.amount)}</span><span className="text-xs text-muted-foreground">{p.dueDate ? when(p.dueDate) : "no date"}</span><span className="ml-auto"><Pill tone={PAY_TONE[p.status] ?? "slate"}>{p.status}</Pill></span></RowLink>)}
          {d.payments.length === 0 && <p className="text-sm text-muted-foreground py-4">No payments on this cabin.</p>}
        </Box>
        <Box title="Group">
          {d.group && <RowLink onClick={() => onDrill("group", d.group!.id)}><span>{d.group.name}</span><span className="ml-auto text-xs text-muted-foreground">{d.group.sailDate ? `sails ${when(d.group.sailDate)}` : ""}</span></RowLink>}
          <Facts rows={[["Type code", c.categoryCode ?? "—"], ["Who", c.travelers || "—"]]} />
        </Box>
      </DrillPage>
    );
  }

  if (drill.kind === "payment") {
    const d = paymentDetail(data, drill.id);
    if (!d) return <Gone what="payment" onBack={onBack} backTo={backTo} />;
    const p = d.p;
    return (
      <DrillPage
        header={<DrillHeader backTo={backTo} onBack={onBack} title={`${p.kind} payment · ${money(p.amount)}`} sub={[p.groupName, p.cabinNum ? `cabin ${p.cabinNum}` : null].filter(Boolean).join(" · ")} action={fileButton(() => openFile(p.groupId, "payments"), "Record it on the group file")} />}
        kpis={<>
          <KpiCard label="Amount" value={money(p.amount)} caption="dollars" />
          <KpiCard label="Status" value={p.status} tone={p.status === "overdue" ? "bad" : p.status === "paid" ? "good" : undefined} caption={p.paidAt ? `paid ${when(p.paidAt)}` : "not paid yet"} />
          <KpiCard label="Due" value={p.dueDate ? when(p.dueDate) : "No date"} caption={p.daysOut === null ? "—" : p.daysOut < 0 ? `${-p.daysOut} days ago` : p.daysOut === 0 ? "today" : `in ${p.daysOut} days`} />
          <KpiCard label="Kind" value={p.kind} caption="deposit or final payment" />
        </>}>
        <Box title="Cabin">{d.cabin ? <RowLink onClick={() => onDrill("cabin", d.cabin!.id)}><span>{[d.cabin.category, d.cabin.cabinNum, d.cabin.bookingNumber].filter(Boolean).join(" · ")}</span><span className="ml-auto text-xs text-muted-foreground">{d.cabin.travelers || "no one yet"}</span></RowLink> : <p className="text-sm text-muted-foreground py-4">Not tied to one cabin.</p>}</Box>
        <Box title="Group">{d.group && <RowLink onClick={() => onDrill("group", d.group!.id)}><span>{d.group.name}</span><span className="ml-auto text-xs text-muted-foreground">{d.group.sailDate ? `sails ${when(d.group.sailDate)}` : ""}</span></RowLink>}</Box>
        <Box title="How it is recorded"><p className="text-sm text-muted-foreground">Payments are made to the cruise line. When one is paid, record it on the group file with the line's receipt reference; never a card number.</p></Box>
      </DrillPage>
    );
  }

  const d = leadDetail(data, drill.id);
  if (!d) return <Gone what="lead" onBack={onBack} backTo={backTo} />;
  const i = d.i;
  return (
    <DrillPage
      header={<DrillHeader backTo={backTo} onBack={onBack} title={i.name} sub={[i.groupName, i.lang === "es" ? "Spanish" : "English"].join(" · ")} action={fileButton(() => openFile(i.groupId, "marketing"))} />}
      kpis={<>
        <KpiCard label="Received" value={when(i.createdAt)} caption={i.daysAgo === null ? "—" : i.daysAgo === 0 ? "today" : `${i.daysAgo} days ago`} />
        <KpiCard label="Party size" value={i.guests === null ? "—" : String(i.guests)} caption="people" />
        <KpiCard label="Cabin type" value={i.cabinType ?? "—"} caption="what they asked about" />
        <KpiCard label="Status" value={i.status} caption="new, contacted, booked or declined" />
      </>}>
      <Box title="Contact"><Facts rows={[["Name", i.name], ["Email", i.email ?? "—"], ["Language", i.lang === "es" ? "Spanish" : "English"]]} /><p className="text-xs text-muted-foreground mt-2">Names and addresses are shortened here; the full ones are on the group file.</p></Box>
      <Box title="Group">{d.group && <RowLink onClick={() => onDrill("group", d.group!.id)}><span>{d.group.name}</span><span className="ml-auto text-xs text-muted-foreground">{d.group.sailDate ? `sails ${when(d.group.sailDate)}` : ""}</span></RowLink>}</Box>
      <Box title="Next step"><p className="text-sm text-muted-foreground">Talk to them or confirm their choice from your waiting list; the lead's full record is on the group file.</p></Box>
    </DrillPage>
  );
}
