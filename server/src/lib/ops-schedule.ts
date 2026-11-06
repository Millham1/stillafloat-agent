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
