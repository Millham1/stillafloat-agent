// line-protection.ts — what a cruise line's OWN travel protection plan covers, pulled off the site that publishes it (Mark 2026-11-13: "that doesnt
// solve the coverages problem only the price" … "you should be able to pull coverage off the sites as needed, then store them for future use").
//
// The PRICE of a cruise line's plan is Mark's to note. Its COVERAGES are the plan's own Schedule of Benefits, which the plan's insurer publishes for
// each state of residence. This file knows, for a cruise line, which insurer page serves that document, fetches the document for a state, and reads
// the schedule out of it. The result is kept in the database (lib/protection-store.ts) and reused. Nothing is written from memory: a cruise line
// with no known source, or a document whose schedule cannot be read, gives no coverages (never a guess).

import type { PlanBenefit } from "./allianz-quote";

/** Where a cruise line's own plan is published. MSC Cruises: product GR452, underwritten by Generali; its administrator's public page serves the
 *  policy document ("Travel Insurance Policy Declarations", with the Schedule of Benefits) for any state, without a sign-in. Found 2026-11-13; the
 *  North Carolina document it served is byte for byte the one Mark downloaded from MSC on 2026-09-21. */
interface LineSource { line: RegExp; cruiseLine: string; plan: string; product: string; insurer: string }
const SOURCES: LineSource[] = [
  { line: /\bmsc\b/i, cruiseLine: "MSC Cruises", plan: "MSC Cruises Travel Insurance", product: "GR452", insurer: "Generali" },
];
const CERT_PAGE = (product: string) => `https://www.csatravelprotection.com/certpolicy.do?product=${encodeURIComponent(product)}`;
const CERT_SUBMIT = "https://www.csatravelprotection.com/certpolicyglobalsubmit.do";
const CERT_DOWNLOAD = (link: string) => `https://www.csatravelprotection.com/certpolicyglobaldownload.do?download=true&certLinkName=${encodeURIComponent(link)}`;
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const STATE_NAMES: Record<string, [string, string]> = { NC: ["North Carolina", "Carolina del Norte"], FL: ["Florida", "Florida"], CA: ["California", "California"], NY: ["New York", "Nueva York"], TX: ["Texas", "Texas"], WA: ["Washington", "Washington"] };

/** The PDF text reader, handed over by the quote reader's routes when the server starts (routes/group-intake.ts): this file and the booking routes
 *  must not load the reader themselves (it brings the quote reader's whole kit, and loading it twice stalls the server's start). */
let pdfReader: ((bytes: Uint8Array) => Promise<string>) | null = null;
export function registerPdfReader(f: (bytes: Uint8Array) => Promise<string>): void { pdfReader = f; }
export const readPolicyPdf = async (bytes: Uint8Array): Promise<string> => {
  if (!pdfReader) throw new Error("the PDF reader is not loaded on this server");
  return pdfReader(bytes);
};
export const lineSource = (cruiseLine: unknown): LineSource | null => (typeof cruiseLine === "string" ? SOURCES.find((s) => s.line.test(cruiseLine)) ?? null : null);
/** The two-letter state out of "Fuquay Varina, NC 27526". */
export const stateOf = (cityStateZip: unknown): string | null => (typeof cityStateZip === "string" ? /,\s*([A-Za-z]{2})\s+\d{5}/.exec(cityStateZip)?.[1]?.toUpperCase() ?? null : null);

/**
 * The Schedule of Benefits out of a policy document's text: the lines between "SCHEDULE OF BENEFITS" and the next heading, each "benefit, limit per
 * person, limit per plan". The per-person figure is the coverage; the per-plan figure is listed under it; a "… Limit" line belongs to the benefit
 * above it. Read as printed, nothing reworded.
 */
export function scheduleFromPolicyText(text: string): PlanBenefit[] {
  const start = text.indexOf("SCHEDULE OF BENEFITS");
  if (start < 0) return [];
  const rest = text.slice(start + "SCHEDULE OF BENEFITS".length);
  const end = rest.search(/\n\s*(FORMS AND ENDORSEMENTS|--- page break ---)/);
  const out: PlanBenefit[] = [];
  for (const raw of rest.slice(0, end < 0 ? 4000 : end).split("\n")) {
    const cells = raw.trim().split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (cells.length !== 3 || /^(coverage|per person)$/i.test(cells[0]!)) continue;
    const [name, perPerson, perPlan] = cells as [string, string, string];
    if (!/[\d%]/.test(perPerson)) continue;
    const last = out[out.length - 1];
    if (/\blimit$/i.test(name) && last) { last.limits.splice(Math.max(0, last.limits.length - 1), 0, { name, value: perPerson }); continue; }
    out.push({ name, coverage: perPerson, limits: perPlan && perPlan !== perPerson ? [{ name: "Per plan", value: perPlan }] : [] });
  }
  return out;
}

export interface LinePull { cruise_line: string; plan_name: string; product_code: string; state: string; about: string; source_en: string; source_es: string; source_url: string; benefits: PlanBenefit[] }
export type LinePullOutcome = { status: "ready"; plan: LinePull } | { status: "unavailable"; reason: string };

/** Fetch the cruise line's plan document for a state from its insurer's public page and read its Schedule of Benefits. */
export async function pullLinePlanCoverage(cruiseLine: unknown, state: unknown, deps: { fetchImpl?: typeof fetch; pdfText: (bytes: Uint8Array) => Promise<string>; today?: Date }): Promise<LinePullOutcome> {
  const src = lineSource(cruiseLine), st = typeof state === "string" ? state.trim().toUpperCase() : "";
  if (!src) return { status: "unavailable", reason: "no published source is known for this cruise line's own plan" };
  if (!/^[A-Z]{2}$/.test(st)) return { status: "unavailable", reason: "the lead traveler's state is not on file" };
  const f = deps.fetchImpl ?? fetch, today = deps.today ?? new Date();
  const date = `${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}/${today.getFullYear()}`;
  let at = "opening the plan-document page";
  try {
    const page = await f(CERT_PAGE(src.product), { headers: { "user-agent": BROWSER } });
    const cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    at = "asking for the state's document";
    const form = new URLSearchParams({ policyNumber: "", appdate: date, product: src.product, certstate: st, submit: "View Terms & Conditions" });
    const answer = await f(CERT_SUBMIT, { method: "POST", headers: { "user-agent": BROWSER, "content-type": "application/x-www-form-urlencoded", referer: CERT_PAGE(src.product), ...(cookie ? { cookie } : {}) }, body: form.toString() });
    const link = /certLinkName=([A-Za-z0-9]+)/.exec(await answer.text())?.[1];
    if (!link) return { status: "unavailable", reason: `the insurer's page gave no ${src.product} document for ${st}` };
    at = "downloading the document";
    const file = await f(CERT_DOWNLOAD(link), { headers: { "user-agent": BROWSER, ...(cookie ? { cookie } : {}) } });
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!file.ok || bytes.length < 1000 || String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") return { status: "unavailable", reason: `the ${src.product} document for ${st} did not download as a PDF` };
    at = "reading the document";
    const text = await deps.pdfText(bytes);
    if (!text.includes(src.product)) return { status: "unavailable", reason: `the document served is not product ${src.product}` };
    const benefits = scheduleFromPolicyText(text);
    if (benefits.length < 3) return { status: "unavailable", reason: `the Schedule of Benefits could not be read from the ${src.product} document` };
    const [en, es] = STATE_NAMES[st] ?? [st, st];
    return { status: "ready", plan: {
      cruise_line: src.cruiseLine, plan_name: src.plan, product_code: src.product, state: st,
      about: `${src.cruiseLine}' own travel insurance (product ${src.product}), underwritten by ${src.insurer}. The figures are per person, from the plan's Schedule of Benefits.`,
      source_en: `From ${src.cruiseLine}' policy document ${src.product} for ${en} residents. The policy itself governs.`,
      source_es: `Del documento de póliza ${src.product} de ${src.cruiseLine} para residentes de ${es}. La póliza es la que manda.`,
      source_url: CERT_PAGE(src.product), benefits,
    } };
  } catch (err) {
    return { status: "unavailable", reason: `the insurer's page could not be read while ${at}: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}` };
  }
}
