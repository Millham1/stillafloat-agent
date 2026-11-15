// Mark's schedule, asked of the ops-manager (the box that holds the calendar; agent/schedule.py there): which times already hold a meeting, and "book
// this one, with a video link". The site never talks to Google itself and never guesses: when the ops-manager does not answer, the answer is null and
// the page offers no times at all (a scheduler that shows a time it could not check would book over a real meeting).

import type { Busy } from "./flexpay-call";

const base = () => (process.env["OPS_MANAGER_URL"] ?? "http://127.0.0.1:5000").replace(/\/+$/, "");

/** The meetings between two instants, or null when the calendar could not be asked. */
export async function opsBusy(start: string, end: string): Promise<Busy[] | null> {
  const key = process.env["IDEAS_API_KEY"];
  if (!key) return null;
  try {
    const r = await fetch(`${base()}/schedule/busy?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { busy?: unknown };
    if (!Array.isArray(j.busy)) return null;
    return j.busy.filter((b): b is Busy => !!b && typeof (b as Busy).start === "string" && typeof (b as Busy).end === "string");
  } catch {
    return null;
  }
}

export type Booked = { ok: true; eventId: string | null; meetLink: string | null } | { ok: false; reason: "taken" | "unreachable" };

/** Put the appointment on Mark's calendar. "taken": a meeting landed on that time since the page was drawn. Asked twice with one requestId, it books once. */
export async function opsBook(o: { start: string; minutes: number; title: string; description: string; requestId: string }): Promise<Booked> {
  const key = process.env["IDEAS_API_KEY"];
  if (!key) return { ok: false, reason: "unreachable" };
  try {
    const r = await fetch(`${base()}/schedule/book`, {
      method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ start: o.start, minutes: o.minutes, title: o.title, description: o.description, request_id: o.requestId }),
    });
    if (r.status === 409) return { ok: false, reason: "taken" };
    if (!r.ok) return { ok: false, reason: "unreachable" };
    const j = (await r.json()) as { event_id?: unknown; meet_link?: unknown };
    const link = typeof j.meet_link === "string" && /^https:\/\/meet\.google\.com\/[a-z0-9-]+/i.test(j.meet_link) ? j.meet_link : null;
    return { ok: true, eventId: typeof j.event_id === "string" ? j.event_id : null, meetLink: link };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

/** Take an appointment the site booked off Mark's calendar (Mark 2026-11-14: a guest he deletes must not leave their planning call on his schedule).
 *  true: it is off the calendar (or was already gone). false: the calendar could not be asked, or the event is not one the site booked. */
export async function opsCancel(eventId: string): Promise<boolean> {
  const key = process.env["IDEAS_API_KEY"];
  if (!key || !eventId) return false;
  try {
    const r = await fetch(`${base()}/schedule/cancel`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, signal: AbortSignal.timeout(30_000), body: JSON.stringify({ event_id: eventId }) });
    return r.ok;
  } catch {
    return false;
  }
}

/** One message of Mark's mailbox to or from a person, as the ops-manager reports it (agent/mail_trail.py): never the body, only Gmail's preview line. */
export interface MailboxMessage { id: string; address: string; direction: "in" | "out"; from: string; to: string; subject: string; snippet: string; at: string }

/** The mailbox's messages to and from these addresses, or null when the mailbox could not be asked. */
export async function opsMailTrail(addresses: string[], since?: string): Promise<MailboxMessage[] | null> {
  const key = process.env["IDEAS_API_KEY"];
  if (!key || !addresses.length) return null;
  try {
    const r = await fetch(`${base()}/mail/trail`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, signal: AbortSignal.timeout(60_000), body: JSON.stringify({ addresses, ...(since ? { since } : {}) }) });
    if (!r.ok) return null;
    const j = (await r.json()) as { messages?: unknown };
    if (!Array.isArray(j.messages)) return null;
    return j.messages.filter((m): m is MailboxMessage => !!m && typeof (m as MailboxMessage).id === "string" && typeof (m as MailboxMessage).address === "string" && typeof (m as MailboxMessage).at === "string"
      && ((m as MailboxMessage).direction === "in" || (m as MailboxMessage).direction === "out"));
  } catch {
    return null;
  }
}
