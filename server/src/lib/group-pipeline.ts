// group-pipeline.ts — where each person of a group stands, and whose move it is (Mark 2026-11-11: "i cannot see currently what the status is and what
// the next step is after the client says Book it"; "this is now becoming a booking platform and should act like one").
//
// One person is on exactly one LEVEL of the group: a lead (they answered the group page; their choices are not in), a quote (their choices are in; the
// price is not approved), or booked (they said Book It, or the paperwork is out). A reply Mark closed (declined, spam) is on none of them.
// Inside a level a person has ONE status and ONE next step, and the next step is either Mark's ("mark"), the guest's ("guest"), or nobody's ("done").
// Pure: no database, no clock. The route (routes/group-details.ts, GET /groups/:id/pipeline) reads the rows and hands them here.

export type PipelineLevel = "lead" | "quote" | "booked" | "closed";
export type PipelineOn = "mark" | "guest" | "done";

export interface PipelineInput {
  /** the reply's status in the replies table: new, contacted, booked, declined, spam */
  status: string | null;
  /** the road the guest took after "Save my spot!": "call" (ring me), "finish" (the older hold road), or none yet */
  choice: string | null;
  call_when: string | null;
  quote_requested_at: string | null;
  booking_completed_at: string | null;
  price: { sent: string | null; sent_at: string | null; approved_at: string | null; approved_how: "guest" | "mark" | null; changes_open: boolean };
  /** where the paperwork went: "booking" (not sent yet), "sent", "held", "no-email", "failed"; null before the choices are in */
  paperwork: string | null;
  /** once the paperwork is out: what the party has signed */
  signed: { required: number; signed: number; complete: boolean } | null;
}

export interface PipelineStage {
  level: PipelineLevel;
  /** a stable name for the status, for filters and tests */
  key: string;
  status: string;
  next: string;
  on: PipelineOn;
  /** the moment the status began (ISO), when the record keeps one */
  since: string | null;
}

const PAPERWORK_WHY: Record<string, string> = {
  held: "this site may not email that address",
  "no-email": "there is no email address on file",
  failed: "the mail service refused it",
};

export function pipelineStage(r: PipelineInput): PipelineStage {
  const status = String(r.status ?? "new");
  if (status === "declined" || status === "spam") {
    return { level: "closed", key: status, status: status === "spam" ? "Closed: spam" : "Closed: declined", next: "Nothing: closed", on: "done", since: null };
  }

  // ── Leads: the choices are not in ──
  if (!r.quote_requested_at) {
    if (status === "booked") return { level: "booked", key: "confirmed", status: "Booking confirmed", next: "Nothing: done", on: "done", since: null };
    if (r.choice === "call" && status !== "contacted") {
      return { level: "lead", key: "call-booked", status: "Planning call booked", next: "Ring them at the booked time", on: "mark", since: r.call_when };
    }
    if (r.choice === "call") return { level: "lead", key: "talked", status: "You talked", next: "Waiting on the guest: their choices", on: "guest", since: r.call_when };
    if (r.choice === "finish") return { level: "lead", key: "hold-asked", status: "Asked you to hold a cabin", next: "Hold the cabin with the cruise line", on: "mark", since: null };
    return { level: "lead", key: "saved-spot", status: "Saved a spot", next: "Waiting on the guest: the form or a call", on: "guest", since: null };
  }

  const paperwork = r.paperwork ?? "booking";

  // ── Booked: the paperwork is out, or they said Book It ──
  if (paperwork !== "booking") {
    if (r.booking_completed_at) return { level: "booked", key: "confirmed", status: "Booking confirmed", next: "Nothing: done", on: "done", since: r.booking_completed_at };
    if (paperwork !== "sent") {
      return { level: "booked", key: "paperwork-not-sent", status: `Paperwork did not go out: ${PAPERWORK_WHY[paperwork] ?? paperwork}`, next: "Send the paperwork again", on: "mark", since: null };
    }
    if (r.signed?.complete) return { level: "booked", key: "signed", status: "Everything is signed", next: "Confirm the booking with the cruise line and vendors", on: "mark", since: null };
    const count = r.signed ? `${r.signed.signed} of ${r.signed.required} signed` : "nothing signed yet";
    return { level: "booked", key: "signing", status: `Paperwork is out: ${count}`, next: "Waiting on the guest: signatures", on: "guest", since: null };
  }
  if (r.price.approved_at) {
    return {
      level: "booked", key: "book-it", status: r.price.approved_how === "mark" ? "Said yes (you recorded it)" : "Said Book It",
      next: "Book it with the cruise line, enter the confirmation numbers, send the paperwork", on: "mark", since: r.price.approved_at,
    };
  }

  // ── Quotes: the choices are in, the price is not approved ──
  if (r.price.changes_open) return { level: "quote", key: "changes", status: "Asked for changes", next: "Re-quote, then email the quote again", on: "mark", since: null };
  if (!r.price.sent_at) return { level: "quote", key: "choices-in", status: "Choices are in", next: "Re-quote with the cruise line, then email the quote", on: "mark", since: r.quote_requested_at };
  if (r.price.sent !== "sent") {
    return { level: "quote", key: "quote-not-sent", status: `The quote did not go out: ${PAPERWORK_WHY[r.price.sent ?? ""] ?? r.price.sent ?? "no reason kept"}`, next: "Email the quote again", on: "mark", since: r.price.sent_at };
  }
  return { level: "quote", key: "quote-sent", status: "Quote emailed", next: "Waiting on the guest: Book It or changes", on: "guest", since: r.price.sent_at };
}
