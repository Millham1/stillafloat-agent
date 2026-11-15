// contact-trail.ts — the paper trail (Mark 2026-11-14: "any time we have an interaction with someone there should be a 'paper trail,' so the
// contact record should stay in the DB for retrieval if necessary. It can be in a separate archive"). The archive is the table contact_trail
// (migration 0074): one row per interaction with a person, by email address, tied to nothing that can be deleted. Site emails land in it by a
// database trigger; this file holds the rest: the rows the site writes itself (events), the mailbox's messages turned into rows, and the
// roll-up Mark's page shows. Pure functions here; the reads and writes are in routes/contact-trail.ts.
import type { MailboxMessage } from "./ops-schedule";

export interface TrailRow {
  email: string; name: string | null; kind: "site-email" | "gmail" | "event"; direction: "out" | "in" | "note";
  subject: string | null; snippet: string | null; status: string | null; at: string;
  group_id: string | null; group_name: string | null; source_id: string; meta?: Record<string, unknown>;
}

export const trailEmail = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
};

/** Something that happened to a person's record, as a line of their trail. `key` makes the same event land once. */
export function trailEvent(o: { email: unknown; name?: string | null; what: string; detail?: string | null; at?: string; groupId?: string | null; groupName?: string | null; key: string }): TrailRow | null {
  const email = trailEmail(o.email);
  if (!email) return null;
  return { email, name: o.name?.trim() || null, kind: "event", direction: "note", subject: o.what, snippet: o.detail ?? null, status: null, at: o.at ?? new Date().toISOString(),
    group_id: o.groupId ?? null, group_name: o.groupName ?? null, source_id: `event:${o.key}` };
}

const squash = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The mailbox's messages as trail rows. The site's own emails go out through the same mailbox, so each one is in the mailbox too: a mailbox
 * message that IS a site email already on the trail (same person, same subject, within three minutes) is left out, so nothing shows twice.
 */
export function trailFromMailbox(messages: MailboxMessage[], already: Array<Pick<TrailRow, "email" | "kind" | "subject" | "at">>, name: string | null = null): TrailRow[] {
  const site = already.filter((r) => r.kind === "site-email");
  const out: TrailRow[] = [];
  for (const m of messages) {
    const email = trailEmail(m.address);
    const at = Date.parse(m.at);
    if (!email || !Number.isFinite(at)) continue;
    const dup = m.direction === "out" && site.some((r) => r.email === email && squash(r.subject) === squash(m.subject) && Math.abs(Date.parse(r.at) - at) < 180_000);
    if (dup) continue;
    out.push({ email, name, kind: "gmail", direction: m.direction, subject: m.subject || null, snippet: m.snippet || null, status: m.direction === "in" ? "received" : "sent",
      at: new Date(at).toISOString(), group_id: null, group_name: null, source_id: `gmail:${m.id}`, meta: { from: m.from, to: m.to } });
  }
  return out;
}

export interface TrailPerson { email: string; name: string | null; count: number; last_at: string; groups: string[] }
/** One line a person: how many interactions, the latest, the groups they were in. Newest first. */
export function trailPeople(rows: Array<Pick<TrailRow, "email" | "name" | "at" | "group_name">>): TrailPerson[] {
  const by = new Map<string, TrailPerson>();
  for (const r of rows) {
    const p = by.get(r.email) ?? { email: r.email, name: null, count: 0, last_at: r.at, groups: [] };
    p.count++; if (r.at > p.last_at) p.last_at = r.at;
    if (r.name && !p.name) p.name = r.name;
    if (r.group_name && !p.groups.includes(r.group_name)) p.groups.push(r.group_name);
    by.set(r.email, p);
  }
  return [...by.values()].sort((a, b) => b.last_at.localeCompare(a.last_at));
}
