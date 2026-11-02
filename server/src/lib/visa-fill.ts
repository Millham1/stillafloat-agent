// visa-fill.ts — a new port on an itinerary → one visa check for that destination only, now (Mark 2026-10-31: "when a new port
// is on the itinerary it only checks for that missing port, then add it to the quarterly run"). The itinerary's countries and
// territories are looked up by code; the ones the table lacks are asked of Orizn, one request each; a row written today is due
// again in 90 days with the rest, so it rides the quarterly review from then on. Runs when the group file is saved with an
// itinerary (routes/groups.ts, routes/group-intake.ts) and inside the daily job (index.ts); never from a client's page.
import { countriesOf } from "./entry-requirements";
import { itineraryPorts } from "./travel-advisories";
import { iso2Of, refreshVisaRequirements, supabaseVisaStore, type RefreshResult, type VisaStore } from "./visa-requirements";
import { logger } from "./logger";

type Row = Record<string, any>;

/** The ISO codes an itinerary needs a row for: its countries and territories, home ports left out. */
export function visaCodesOf(group: Row): string[] {
  const codes = new Set<string>();
  for (const { country } of countriesOf(itineraryPorts(group))) {
    const c = iso2Of(country);
    if (c) codes.add(c);
  }
  return [...codes];
}

/** Fill what one group's itinerary lacks, now, with a small cap; the daily job is the backstop and would do it within a day.
 *  Never throws: a failure is logged and the job tries again. */
export async function fillItineraryVisas(group: Row, store: VisaStore = supabaseVisaStore(), fetchImpl: typeof fetch = fetch, now = new Date()): Promise<RefreshResult | null> {
  const wanted = visaCodesOf(group);
  if (!wanted.length) return null;
  try {
    const r = await refreshVisaRequirements(store, fetchImpl, now, "US", { oriznKey: process.env["ORIZN_API_KEY"] || undefined, wanted, maxOrizn: 10, territories: false });
    if (r.orizn.fetched || r.orizn.missing.length) logger.info({ group: group["id"], wanted, fetched: r.orizn.fetched, missing: r.orizn.missing, note: r.orizn.note || undefined }, "visa table: the itinerary's destinations");
    return r;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), group: group["id"] }, "visa table: filling the itinerary's destinations failed (the daily job tries again)");
    return null;
  }
}
