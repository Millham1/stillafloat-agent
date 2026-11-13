// line-protection.ts — what a cruise line's OWN travel protection plan covers (Mark 2026-11-13: "that doesnt solve the coverages problem only the
// price"). The PRICE of a cruise line's plan comes from the cruise line (its quote, or typed by Mark). Its COVERAGES do not change with the booking:
// they are the plan's own Schedule of Benefits, kept here exactly as the cruise line's plan document prints it, with where it was read.
//
// Nothing here is written from memory or from another site: one entry per plan DOCUMENT that has been read, for the residents it was issued for.
// A cruise line or a state with no document read → no coverages are shown (never a guess).

import type { PlanBenefit } from "./allianz-quote";

export interface LinePlanCoverage {
  /** the plan's own name and product code */
  plan: string;
  about: string;
  /** where the figures were read, said to the guest under the table */
  source: { en: string; es: string };
  benefits: PlanBenefit[];
}

// MSC Cruises, product GR452, underwritten by Generali - U.S. Branch. Read 2026-11-13 from the policy document Mark downloaded from MSC on
// 2026-09-21 (file GR452092126NC.pdf, 39 pages; "Schedule of Benefits", page 3: one column per person, one per plan). The file is the copy issued
// for North Carolina residents (the NC in its name); other states' copies have not been read, so it is offered to North Carolina residents only.
const MSC_GR452_NC: LinePlanCoverage = {
  plan: "MSC Cruises Travel Insurance (GR452)",
  about: "MSC Cruises' own travel insurance, underwritten by Generali. The figures are per person, from the plan's Schedule of Benefits.",
  source: {
    en: "From MSC Cruises' policy document GR452 (North Carolina residents). The policy itself governs.",
    es: "Del documento de póliza GR452 de MSC Cruises (residentes de Carolina del Norte). La póliza es la que manda.",
  },
  benefits: [
    { name: "Trip Cancellation", coverage: "100% of Trip Cost", limits: [] },
    { name: "Trip Interruption", coverage: "100% of Trip Cost", limits: [] },
    { name: "Travel Delay", coverage: "$600.00", limits: [{ name: "Daily Limit", value: "$200.00" }, { name: "Per plan", value: "$6,000.00" }] },
    { name: "Emergency Assistance & Transportation", coverage: "$75,000.00", limits: [{ name: "Per plan", value: "$500,000.00" }] },
    { name: "Emergency Companion Hospitality Expenses", coverage: "$10,000.00", limits: [] },
    { name: "Medical and Dental", coverage: "$75,000.00", limits: [{ name: "Emergency Dental Expense Limit", value: "$500.00" }, { name: "Per plan", value: "$250,000.00" }] },
    { name: "Accidental Death and Dismemberment - Air Flight Accident", coverage: "$25,000.00", limits: [{ name: "Per plan", value: "$250,000.00" }] },
    { name: "Baggage", coverage: "$1,000.00", limits: [{ name: "Per plan", value: "$10,000.00" }] },
    { name: "Baggage Delay", coverage: "$100.00", limits: [{ name: "Per plan", value: "$1,000.00" }] },
  ],
};

const TABLE: Array<{ line: RegExp; state: string; coverage: LinePlanCoverage }> = [
  { line: /\bmsc\b/i, state: "NC", coverage: MSC_GR452_NC },
];

/** The coverages of a cruise line's own plan for a resident of a state, when that plan document has been read; null otherwise. */
export function linePlanCoverage(cruiseLine: unknown, state: unknown): LinePlanCoverage | null {
  if (typeof cruiseLine !== "string" || typeof state !== "string") return null;
  return TABLE.find((t) => t.line.test(cruiseLine) && t.state === state.trim().toUpperCase())?.coverage ?? null;
}
/** The two-letter state out of "Fuquay Varina, NC 27526". */
export const stateOf = (cityStateZip: unknown): string | null => (typeof cityStateZip === "string" ? /,\s*([A-Za-z]{2})\s+\d{5}/.exec(cityStateZip)?.[1]?.toUpperCase() ?? null : null);
