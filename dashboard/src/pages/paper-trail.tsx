import React, { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/group-api";

// The paper trail (Mark 2026-11-14: "any time we have an interaction with someone there should be a 'paper trail,' so the contact record
// should stay in the DB for retrieval if necessary"). Everyone the business has emailed or heard from, kept when a guest or a whole group is
// deleted. The left list is the people; picking one shows every interaction in order: the emails the site sent, the messages in the mailbox
// (sent by hand, or written by the person), and what happened to their record. Read-only: nothing here deletes or sends.

type Person = { email: string; name: string | null; count: number; last_at: string; groups: string[] };
type Line = { kind: "site-email" | "gmail" | "event"; direction: "out" | "in" | "note"; subject: string | null; snippet: string | null; status: string | null; at: string; group_name: string | null; source_id: string; meta?: { template?: string; from?: string; to?: string } };

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const WHAT: Record<Line["kind"], string> = { "site-email": "Email from the site", gmail: "Mailbox", event: "Record" };

export default function PaperTrail() {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [find, setFind] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadPeople = () => api<{ people: Person[] }>("/trail").then((r) => setPeople(r.people)).catch((e: Error) => { setPeople([]); setNote({ text: e.message, bad: true }); });
  const loadLines = (email: string) => api<{ rows: Line[] }>(`/trail?email=${encodeURIComponent(email)}`).then((r) => setLines(r.rows)).catch((e: Error) => { setLines([]); setNote({ text: e.message, bad: true }); });
  useEffect(() => { void loadPeople(); }, []);
  useEffect(() => { setLines(null); setNote(null); if (open) void loadLines(open); }, [open]);

  const shown = useMemo(() => {
    const q = find.trim().toLowerCase();
    return (people ?? []).filter((p) => !q || p.email.includes(q) || (p.name ?? "").toLowerCase().includes(q) || p.groups.some((g) => g.toLowerCase().includes(q)));
  }, [people, find]);
  const person = (people ?? []).find((p) => p.email === open) ?? null;

  // Ask the mailbox for this person's messages now; the new ones are added to the trail and stay there.
  const checkMailbox = async () => {
    if (!open) return;
    setBusy(true); setNote(null);
    try {
      const r = await api<{ mailbox: number }>("/trail/refresh", "POST", { email: open });
      await loadLines(open); await loadPeople();
      setNote({ text: r.mailbox === 0 ? "The mailbox holds no message to or from this address." : `The mailbox holds ${r.mailbox} message${r.mailbox === 1 ? "" : "s"} to or from this address. Any that were new are on the trail now.`, bad: false });
    } catch (e) { setNote({ text: (e as Error).message, bad: true }); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Paper trail</h1>
        <p className="text-base text-muted-foreground">Every person we have emailed or heard from, with each interaction in order. A person stays here when they are deleted from a group, and when the group itself is deleted.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <Card className="p-3">
          <input className="w-full px-3 py-2 rounded-md border bg-card text-base" placeholder="Find a name, an address or a group" aria-label="Find a person" value={find} onChange={(e) => setFind(e.target.value)} />
          <p className="mt-2 text-sm text-muted-foreground">{people === null ? "Loading…" : `${shown.length} of ${people.length} ${people.length === 1 ? "person" : "people"}`}</p>
          <ul className="mt-2 divide-y max-h-[70vh] overflow-auto" data-testid="trail-people">
            {shown.map((p) => (
              <li key={p.email}>
                <button className={`w-full text-left px-2 py-2.5 rounded-md hover:bg-muted/40 ${open === p.email ? "bg-muted/50" : ""}`} onClick={() => setOpen(p.email)} aria-pressed={open === p.email}>
                  <span className="block text-base font-semibold">{p.name ?? p.email}</span>
                  {p.name && <span className="block text-sm text-muted-foreground break-all">{p.email}</span>}
                  <span className="block text-sm text-muted-foreground">{p.count} interaction{p.count === 1 ? "" : "s"} · last {when(p.last_at)}{p.groups.length ? ` · ${p.groups.join(", ")}` : ""}</span>
                </button>
              </li>
            ))}
            {people !== null && shown.length === 0 && <li className="px-2 py-4 text-base text-muted-foreground">{people.length === 0 ? "Nobody is on the trail yet. A person appears with the first email the site sends them." : "No one matches."}</li>}
          </ul>
        </Card>
        <Card className="p-4">
          {!open && <p className="text-base text-muted-foreground">Pick a person to see their trail.</p>}
          {open && (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <h2 className="text-xl font-bold">{person?.name ?? open}</h2>
                  <p className="text-base text-muted-foreground break-all">{open}{person?.groups.length ? ` · ${person.groups.join(", ")}` : ""}</p>
                </div>
                <button className="text-base px-4 py-2 rounded-md border bg-card hover:bg-muted/40 disabled:opacity-50" disabled={busy} onClick={checkMailbox}>{busy ? "Asking the mailbox…" : "Check the mailbox now"}</button>
              </div>
              {note && <p className={`text-base font-medium ${note.bad ? "text-red-500" : "text-muted-foreground"}`}>{note.text}</p>}
              {lines === null && <p className="text-base text-muted-foreground">Loading…</p>}
              {lines !== null && lines.length === 0 && <p className="text-base text-muted-foreground">Nothing is on this person's trail.</p>}
              <ol className="space-y-2" data-testid="trail-lines">
                {(lines ?? []).map((l) => (
                  <li key={l.source_id} className="rounded-md border px-3 py-2.5">
                    <p className="text-sm text-muted-foreground">{when(l.at)} · {WHAT[l.kind]}{l.kind !== "event" ? (l.direction === "in" ? " · they wrote to us" : " · sent to them") : ""}{l.status && l.kind === "site-email" && l.status !== "sent" ? ` · ${l.status === "skipped" ? "NOT sent (held)" : "FAILED"}` : ""}{l.group_name ? ` · ${l.group_name}` : ""}</p>
                    <p className="text-base font-semibold">{l.subject ?? "(no subject)"}</p>
                    {l.snippet && <p className="text-base text-muted-foreground">{l.snippet}</p>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
