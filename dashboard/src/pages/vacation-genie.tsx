import React, { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/group-api";

// Vacation Genie files (Mark 2026-11-24): the single-booking front door. A visitor gives their email, answers the interview, and is shown the
// ship, the sailing, the fare and the rooms; then the file lands here for Mark to call them, go through it, finalize the quote and book.
// The left list is the people, newest first; picking one shows everything they told us and everything they were shown. The only things
// this page changes are where Mark is with the person and his own note.

type Lead = {
  id: string; status: string; created_at: string; finished_at: string | null; name: string; email: string; phone: string | null;
  ship: string | null; sailing: string | null; mark_note: string | null; file: [string, string][];
};

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const STATUS: Record<string, string> = {
  started: "Still answering", finished: "Waiting on your call", contacted: "You have talked", quoted: "Final quote sent", booked: "Booked", closed: "Closed, not booking",
};
// The steps Mark sets by hand, in order. "started" is the visitor's own and is never set here.
const STEPS = ["finished", "contacted", "quoted", "booked", "closed"] as const;

export default function VacationGenie() {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);                       // "Delete this file" was pressed; waiting on yes or no
  const [gone, setGone] = useState<string | null>(null);              // what the last delete did, said above the list

  const load = () => api<{ leads: Lead[] }>("/genie/leads").then((r) => setLeads(r.leads)).catch((e: Error) => { setLeads([]); setNote({ text: e.message, bad: true }); });
  useEffect(() => { void load(); }, []);

  // By default the list is the people who finished and are not yet booked or closed: the ones that need Mark.
  const shown = useMemo(() => (leads ?? []).filter((l) => showAll || ["finished", "contacted", "quoted"].includes(l.status)), [leads, showAll]);
  const lead = (leads ?? []).find((l) => l.id === open) ?? null;
  useEffect(() => { setNoteText(lead?.mark_note ?? ""); setNote(null); setAsking(false); }, [open]);
  const waiting = (leads ?? []).filter((l) => l.status === "finished").length;

  const save = async (fields: { status?: string; mark_note?: string }, said: string) => {
    if (!lead) return;
    setBusy(true); setNote(null);
    try { await api(`/genie/leads/${lead.id}`, "POST", fields); await load(); setNote({ text: said, bad: false }); }
    catch (e) { setNote({ text: (e as Error).message, bad: true }); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!lead) return;
    setBusy(true); setNote(null);
    try {
      const r = await api<{ deleted: { name: string } }>(`/genie/leads/${lead.id}`, "DELETE");
      setOpen(null); await load();
      setGone(`${r.deleted.name}'s file is deleted. Their contact trail is kept.`);
    } catch (e) { setNote({ text: (e as Error).message, bad: true }); }
    finally { setBusy(false); setAsking(false); }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Vacation Genie</h1>
        <p className="text-base text-muted-foreground">
          People who went through the Vacation Genie on the website. Each file holds what they told us and what they were shown: the ship, the sailing, the fare and the rooms.
          {leads !== null && ` ${waiting} ${waiting === 1 ? "person is" : "people are"} waiting on your call.`}
        </p>
      </div>
      {gone && <p className="text-base font-medium text-muted-foreground" role="status" data-testid="genie-deleted">{gone}</p>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <Card className="p-3">
          <label className="flex items-center gap-2 text-base cursor-pointer">
            <input type="checkbox" className="h-5 w-5" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            Also show people still answering, booked and closed
          </label>
          <p className="mt-2 text-sm text-muted-foreground">{leads === null ? "Loading…" : `${shown.length} of ${leads.length} ${leads.length === 1 ? "file" : "files"}`}</p>
          <ul className="mt-2 divide-y max-h-[70vh] overflow-auto" data-testid="genie-leads">
            {shown.map((l) => (
              <li key={l.id}>
                <button className={`w-full text-left px-2 py-2.5 rounded-md hover:bg-muted/40 ${open === l.id ? "bg-muted/50" : ""}`} onClick={() => setOpen(l.id)} aria-pressed={open === l.id}>
                  <span className="block text-base font-semibold">{l.name}</span>
                  <span className="block text-sm text-muted-foreground">{STATUS[l.status] ?? l.status} · {when(l.finished_at ?? l.created_at)}</span>
                  <span className="block text-sm text-muted-foreground">{l.ship ?? "No ship chosen yet"}{l.sailing ? ` · sails ${l.sailing}` : ""}</span>
                </button>
              </li>
            ))}
            {leads !== null && shown.length === 0 && <li className="px-2 py-4 text-base text-muted-foreground">{leads.length === 0 ? "Nobody has used the Vacation Genie yet." : "Nobody is waiting on you. Tick the box above to see everyone."}</li>}
          </ul>
        </Card>
        <Card className="p-4">
          {!lead && <p className="text-base text-muted-foreground">Pick a person to see their file.</p>}
          {lead && (
            <div className="space-y-4">
              <div>
                <h2 className="text-xl font-bold">{lead.name}</h2>
                <p className="text-base text-muted-foreground break-all">
                  <a className="underline" href={`mailto:${lead.email}`}>{lead.email}</a>{lead.phone ? <> · <a className="underline" href={`tel:${lead.phone}`}>{lead.phone}</a></> : " · no phone given"}
                </p>
              </div>
              <div>
                <p className="text-base font-semibold mb-2">Where you are with them: {STATUS[lead.status] ?? lead.status}</p>
                <div className="flex gap-2 flex-wrap">
                  {STEPS.map((s) => (
                    <button key={s} disabled={busy || lead.status === s} aria-pressed={lead.status === s}
                      className={`text-base px-4 py-2 rounded-md border ${lead.status === s ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted/40"} disabled:cursor-default`}
                      onClick={() => save({ status: s }, `Saved: ${STATUS[s]}.`)}>{STATUS[s]}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-base font-semibold mb-1" htmlFor="genie-note">Your note</label>
                <textarea id="genie-note" className="w-full px-3 py-2 rounded-md border bg-card text-base min-h-[5rem]" value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="What you agreed on the call, what to quote, when to follow up" />
                <button className="mt-2 text-base px-4 py-2 rounded-md border bg-card hover:bg-muted/40 disabled:opacity-50" disabled={busy || noteText === (lead.mark_note ?? "")} onClick={() => save({ mark_note: noteText }, "Note saved.")}>Save the note</button>
                {noteText === (lead.mark_note ?? "") && <span className="ml-3 text-sm text-muted-foreground">Change the note to save it.</span>}
              </div>
              {note && <p className={`text-base font-medium ${note.bad ? "text-red-500" : "text-muted-foreground"}`}>{note.text}</p>}
              <table className="w-full text-base" data-testid="genie-file">
                <tbody>
                  {lead.file.map(([k, v], i) => (
                    <tr key={i} className="border-t align-top">
                      <td className="py-2 pr-4 text-muted-foreground w-[16rem]">{k}</td>
                      <td className="py-2 font-medium break-words">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t pt-4">
                {!asking ? (
                  <button className="text-base px-4 py-2 rounded-md border bg-card hover:bg-muted/40 disabled:opacity-50" disabled={busy} onClick={() => setAsking(true)} data-testid="genie-delete">Delete this file</button>
                ) : (
                  <div className="space-y-2" data-testid="genie-delete-ask">
                    <p className="text-base font-medium">Delete {lead.name}'s file? Their answers, the ship, the sailing and the fares shown go with it. Their contact trail is kept, with a line saying the file was deleted.</p>
                    <div className="flex gap-2 flex-wrap">
                      <button className="text-base px-4 py-2 rounded-md border border-red-600 text-red-600 bg-card hover:bg-muted/40 disabled:opacity-50" disabled={busy} onClick={remove}>Yes, delete the file</button>
                      <button className="text-base px-4 py-2 rounded-md border bg-card hover:bg-muted/40 disabled:opacity-50" disabled={busy} onClick={() => setAsking(false)}>Keep it</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
