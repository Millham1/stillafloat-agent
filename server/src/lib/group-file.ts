// group-file.ts — pure helpers for the group-bookings file (migration 0041).
// No I/O here so the rules below are unit-testable: which columns a caller may
// write, the "no card numbers, ever" guard, and the roll-up that tells Mark what
// needs attention on a group.

export const GROUP_STATUSES = ["draft", "marketing", "booking", "final-paid", "sailed", "closed", "cancelled"] as const;

export const GROUP_COLUMNS = [
  "name", "slug", "status", "organizer_name", "organizer_email", "organizer_phone",
  "cruise_line", "ship_name", "ship_slug", "sail_date", "return_date", "nights",
  "embark_port", "itinerary", "group_number", "cabins_held", "amenities",
  "deposit_per_person", "deposit_due", "names_due", "final_payment_due",
  "recall_date", "lang", "notes",
] as const;

type ChildSpec = { table: string; columns: readonly string[]; select: string; order: string };

// Travelers: the API never selects passport_enc, form_token_hash or
// consent_ip_hash, and never accepts passport/consent fields from the dashboard —
// those are written only by the traveler's own signed-link form.
const TRAVELER_READ =
  "id, group_id, cabin_id, is_lead, first_name, middle_name, last_name, dob, gender, citizenship, " +
  "email, phone, lang, loyalty_number, passport_last4, passport_country, passport_expiry, " +
  "emergency_name, emergency_phone, special_needs, form_sent_at, form_submitted_at, " +
  "consent_name, consent_signed_at, notes, created_at, updated_at";

export const CHILDREN: Record<string, ChildSpec> = {
  cabins: {
    table: "group_cabins",
    columns: ["cabin_num", "deck", "category", "category_code", "status", "booking_number",
      "price_total", "deposit_amount", "insurance", "dining", "bed_config", "notes"],
    select: "*",
    order: "cabin_num",
  },
  travelers: {
    table: "group_travelers",
    columns: ["cabin_id", "is_lead", "first_name", "middle_name", "last_name", "dob", "gender",
      "citizenship", "email", "phone", "lang", "loyalty_number", "emergency_name",
      "emergency_phone", "special_needs", "notes"],
    select: TRAVELER_READ,
    order: "last_name",
  },
  documents: {
    table: "group_documents",
    columns: ["cabin_id", "traveler_id", "kind", "title", "status", "owner", "due_date",
      "completed_at", "external_ref", "notes"],
    select: "*",
    order: "due_date",
  },
  payments: {
    table: "group_payments",
    columns: ["cabin_id", "kind", "amount", "due_date", "paid_at", "method_note",
      "confirmation_ref", "notes"],
    select: "*",
    order: "due_date",
  },
  travel: {
    table: "group_travel",
    columns: ["cabin_id", "traveler_id", "kind", "direction", "provider", "reference",
      "from_place", "to_place", "starts_at", "ends_at", "confirmation", "notes"],
    select: "*",
    order: "starts_at",
  },
  checklist: {
    table: "group_checklist",
    columns: ["cabin_id", "audience", "kind", "title", "detail", "link_url", "due_date",
      "done_at", "sort"],
    select: "*",
    order: "sort",
  },
};

export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function luhnOk(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** True when the text contains something shaped like a payment-card number
 * (13–19 digits, spaces/dashes allowed, passing the Luhn check). */
export function looksLikeCardNumber(text: string): boolean {
  const runs = text.match(/\d(?:[ -]?\d){12,18}/g) ?? [];
  return runs.some((run) => {
    const digits = run.replace(/[ -]/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhnOk(digits);
  });
}

export type Picked = { ok: true; row: Record<string, unknown> } | { ok: false; error: string };

/** Keep only whitelisted columns; "" becomes null; refuse anything card-shaped. */
export function pickWritable(columns: readonly string[], body: unknown): Picked {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Expected a JSON object" };
  }
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!columns.includes(key)) continue;
    if (typeof value === "string") {
      if (looksLikeCardNumber(value)) {
        return {
          ok: false,
          error: `"${key}" looks like a payment card number. Card numbers are never stored in the group file.`,
        };
      }
      const trimmed = value.trim();
      row[key] = trimmed === "" ? null : trimmed;
    } else if (value !== null && typeof value === "object") {
      if (looksLikeCardNumber(JSON.stringify(value))) {
        return {
          ok: false,
          error: `"${key}" looks like it contains a payment card number. Card numbers are never stored in the group file.`,
        };
      }
      row[key] = value;
    } else {
      row[key] = value;
    }
  }
  return { ok: true, row };
}

// ── Roll-up ───────────────────────────────────────────────────────────────────

type Row = Record<string, any>;

export type GroupFile = {
  group: Row;
  cabins: Row[];
  travelers: Row[];
  documents: Row[];
  payments: Row[];
  checklist: Row[];
  messages?: Row[];
};

export type AttentionItem = {
  kind: "payment" | "document" | "checklist" | "traveler-form" | "group-date" | "email";
  label: string;
  due: string | null;
  overdue: boolean;
  daysOut: number | null;
};

export type GroupSummary = {
  cabins: { total: number; held: number; offered: number; booked: number; released: number };
  travelers: { total: number; formsIn: number; signed: number };
  payments: { dueTotal: number; paidTotal: number; openCount: number; overdueCount: number };
  /** Deposits for the whole block: what the quote says they add up to, and what has come in. */
  deposits: { total: number; paid: number };
  emails: { sent: number };
  documents: { open: number; overdue: number };
  checklist: { open: number; overdue: number };
  daysToSail: number | null;
  attention: AttentionItem[];
};

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso.slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(toIso.slice(0, 10) + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

const DOC_DONE = new Set(["signed", "received", "filed", "not-required"]);
const CABIN_LIVE = new Set(["held", "offered", "booked"]);

/** What a group looks like today, and what needs doing in the next `horizonDays`.
 * `today` is a YYYY-MM-DD string so callers (and tests) control the clock. */
export function summarize(file: GroupFile, today: string, horizonDays = 30): GroupSummary {
  const cabinLabel = new Map<string, string>();
  for (const c of file.cabins) cabinLabel.set(c.id, c.cabin_num ? `cabin ${c.cabin_num}` : "unassigned cabin");
  const liveCabin = (id: string | null | undefined) =>
    !id || CABIN_LIVE.has(file.cabins.find((c) => c.id === id)?.status ?? "held");

  const attention: AttentionItem[] = [];
  const push = (kind: AttentionItem["kind"], label: string, due: string | null) => {
    const daysOut = due ? daysBetween(today, due) : null;
    if (daysOut !== null && daysOut > horizonDays) return;
    attention.push({ kind, label, due, daysOut, overdue: daysOut !== null && daysOut < 0 });
  };

  const count = (status: string) => file.cabins.filter((c) => c.status === status).length;
  const cabins = {
    // Until each cabin has its own row, the block size on the file is the count.
    total: Math.max(file.cabins.length, Number(file.group.cabins_held ?? 0) || 0),
    held: count("held"),
    offered: count("offered"),
    booked: count("booked"),
    released: count("released") + count("cancelled"),
  };

  let dueTotal = 0;
  let paidTotal = 0;
  let openCount = 0;
  let overduePayments = 0;
  // Sixteen cabins with the same deposit date make ONE attention line, not sixteen.
  const byKindAndDate = new Map<string, { kind: string; due: string | null; who: string[] }>();
  for (const p of file.payments) {
    if (!liveCabin(p.cabin_id)) continue;
    const amount = Number(p.amount ?? 0) || 0;
    if (p.paid_at) {
      paidTotal += amount;
      continue;
    }
    dueTotal += amount;
    openCount++;
    if (p.due_date && daysBetween(today, p.due_date) < 0) overduePayments++;
    const key = `${p.kind}|${p.due_date ?? ""}`;
    const entry = byKindAndDate.get(key) ?? { kind: p.kind as string, due: (p.due_date ?? null) as string | null, who: [] as string[] };
    entry.who.push(p.cabin_id ? cabinLabel.get(p.cabin_id) ?? "cabin" : "group");
    byKindAndDate.set(key, entry);
  }
  for (const { kind, due, who } of byKindAndDate.values()) {
    const what = kind === "final" ? "Final payment" : kind === "deposit" ? "Deposit" : "Payment";
    const target = who.length === 1 ? who[0]! : `${who.length} cabins`;
    push("payment", `${what} — ${target}`, due);
  }

  // Deposits for the block: per-cabin amounts when the cabins are listed, else
  // cabins held × per-person deposit × two (double occupancy).
  const perPerson = Number(file.group.deposit_per_person ?? 0) || 0;
  const liveCabins = file.cabins.filter((c) => CABIN_LIVE.has(c.status ?? "held"));
  let depositsTotal = liveCabins.reduce((n, c) => n + (Number(c.deposit_amount ?? 0) || 0), 0);
  const unlisted = Math.max(0, cabins.total - file.cabins.length);
  depositsTotal += unlisted * perPerson * 2;
  const depositsPaid = file.payments
    .filter((p) => p.kind === "deposit" && p.paid_at && liveCabin(p.cabin_id))
    .reduce((n, p) => n + (Number(p.amount ?? 0) || 0), 0);
  const depositsOpen = file.payments.filter((p) => p.kind === "deposit" && !p.paid_at && liveCabin(p.cabin_id));
  const noDepositRows = !file.payments.some((p) => p.kind === "deposit");
  if (depositsTotal > 0 && depositsPaid < depositsTotal && (noDepositRows || depositsOpen.length === 0)) {
    const due = file.group.deposit_due ?? null;
    push("payment", `Deposits — ${cabins.total - cabins.released} cabins, $${Math.round(depositsTotal - depositsPaid).toLocaleString("en-US")} still to collect${due ? "" : " (due at booking)"}`, due);
  }

  let openDocs = 0;
  let overdueDocs = 0;
  for (const d of file.documents) {
    if (DOC_DONE.has(d.status) || !liveCabin(d.cabin_id)) continue;
    openDocs++;
    if (d.due_date && daysBetween(today, d.due_date) < 0) overdueDocs++;
    push("document", `${d.title} (${d.owner === "client" ? "client" : "you"})`, d.due_date ?? null);
  }

  let openChecks = 0;
  let overdueChecks = 0;
  for (const c of file.checklist) {
    if (c.done_at || c.audience !== "mark" || c.kind !== "task") continue;
    openChecks++;
    if (c.due_date && daysBetween(today, c.due_date) < 0) overdueChecks++;
    push("checklist", c.title, c.due_date ?? null);
  }

  const liveTravelers = file.travelers.filter((t) => liveCabin(t.cabin_id));
  // Two to a cabin until the names are in.
  const expectedTravelers = Math.max(liveTravelers.length, (cabins.total - cabins.released) * 2);
  const formsIn = liveTravelers.filter((t) => t.form_submitted_at).length;
  const signed = liveTravelers.filter((t) => t.consent_signed_at).length;
  const formsOut = liveTravelers.filter((t) => t.form_sent_at && !t.form_submitted_at).length;
  const formsMissing = expectedTravelers - formsIn;
  if (formsMissing > 0) {
    const unsent = Math.max(0, expectedTravelers - liveTravelers.filter((t) => t.form_sent_at || t.form_submitted_at).length);
    push("traveler-form",
      `${formsMissing} of ${expectedTravelers} traveler forms not returned` +
      (formsOut > 0 || unsent < expectedTravelers ? ` (${formsOut} sent, ${unsent} not yet sent)` : " (none sent yet)"),
      file.group.names_due ?? null);
  }
  const sentEmails = (file.messages ?? []).filter((m) => m.status === "sent" || m.sent_at).length;
  if (sentEmails === 0) push("email", "No emails sent yet on this group", null);

  const g = file.group;
  const active = !["sailed", "closed", "cancelled"].includes(g.status);
  if (active) {
    const groupDates: Array<[string, string | null]> = [
      ["Group deposit deadline", g.deposit_due],
      ["Names due to the cruise line", g.names_due],
      ["Group final payment deadline", g.final_payment_due],
      ["Unsold cabins go back to the line", g.recall_date],
    ];
    const reviews: Array<{ date?: string | null; percent_retaken?: number | null }> = Array.isArray(g.terms?.allotment_reviews) ? g.terms.allotment_reviews : [];
    for (const r of reviews) {
      if (r.date) groupDates.push([`Line reviews the block${r.percent_retaken != null ? ` (takes back ${r.percent_retaken}% of unsold)` : ""}`, r.date]);
    }
    for (const [label, due] of groupDates) {
      // A group-level date only matters while it is still ahead (or just passed).
      if (!due || daysBetween(today, due) < -7) continue;
      // Already shown as per-cabin payment lines, or as one of the line's review dates.
      if (label === "Group final payment deadline" && attention.some((a) => a.kind === "payment" && a.due === due && a.label.startsWith("Final payment"))) continue;
      if (label === "Unsold cabins go back to the line" && reviews.some((r) => r.date === due)) continue;
      push("group-date", label, due);
    }
  }

  attention.sort((a, b) => (a.daysOut ?? 9999) - (b.daysOut ?? 9999));

  return {
    cabins,
    travelers: { total: expectedTravelers, formsIn, signed },
    payments: { dueTotal, paidTotal, openCount, overdueCount: overduePayments },
    deposits: { total: depositsTotal, paid: depositsPaid },
    emails: { sent: sentEmails },
    documents: { open: openDocs, overdue: overdueDocs },
    checklist: { open: openChecks, overdue: overdueChecks },
    daysToSail: g.sail_date ? daysBetween(today, g.sail_date) : null,
    attention,
  };
}

/** Deposit + final payment rows a cabin should have, given the group's dates.
 * Returns only the rows that are missing, so the call is safe to repeat. */
export function missingSchedule(file: Pick<GroupFile, "group" | "cabins" | "payments">): Row[] {
  const out: Row[] = [];
  for (const cabin of file.cabins) {
    if (!CABIN_LIVE.has(cabin.status)) continue;
    const has = (kind: string) => file.payments.some((p) => p.cabin_id === cabin.id && p.kind === kind);
    const deposit = cabin.deposit_amount != null ? Number(cabin.deposit_amount) : null;
    const total = cabin.price_total != null ? Number(cabin.price_total) : null;
    // A deposit "due at booking" has no calendar date, but it is still owed.
    if (!has("deposit") && (file.group.deposit_due || deposit != null)) {
      out.push({ group_id: file.group.id, cabin_id: cabin.id, kind: "deposit", amount: deposit, due_date: file.group.deposit_due ?? null });
    }
    if (!has("final") && file.group.final_payment_due) {
      out.push({
        group_id: file.group.id,
        cabin_id: cabin.id,
        kind: "final",
        amount: total != null ? Math.round((total - (deposit ?? 0)) * 100) / 100 : null,
        due_date: file.group.final_payment_due,
      });
    }
  }
  return out;
}
