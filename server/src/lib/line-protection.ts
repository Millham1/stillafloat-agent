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
/** Norwegian Cruise Line: NorwegianCare, policy NWENCL04, insurance benefits underwritten by Nationwide, administered by Aon Affinity. Norwegian's
 *  own FAQ page links the administrator's page (affinitytravelcert.com/docs/nwencl04), which answers a state with the plan document's address
 *  (found 2026-11-13: one 61-page document, "Ed. 12/2024", served for North Carolina and Florida alike). No sign-in. */
interface LineSource { line: RegExp; cruiseLine: string; plan: string; product: string; insurer: string; via: "generali" | "aon"; aon?: { splr: string; carrier: string; landing: string } }
const SOURCES: LineSource[] = [
  { line: /\bmsc\b/i, cruiseLine: "MSC Cruises", plan: "MSC Cruises Travel Insurance", product: "GR452", insurer: "Generali", via: "generali" },
  { line: /\bnorwegian\b|\bncl\b/i, cruiseLine: "Norwegian Cruise Line", plan: "NorwegianCare Travel Protection", product: "NWENCL04", insurer: "Nationwide", via: "aon", aon: { splr: "NCL", carrier: "NWE", landing: "https://affinitytravelcert.com/docs/nwencl04" } },
];
const AON = "https://affinitytravelcert.com";
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
  const end = rest.search(/\n\s*(FORMS AND ENDORSEMENTS|--- page break ---|There are also Non|[A-Z]{4,6} \d{4}\s*\n)/);
  const body = rest.slice(0, end < 0 ? 4000 : end);
  const out: PlanBenefit[] = [];
  for (const raw of body.split("\n")) {
    const cells = raw.trim().split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (cells.length !== 3 || /^(coverage|per person)$/i.test(cells[0]!)) continue;
    const [name, perPerson, perPlan] = cells as [string, string, string];
    if (!/[\d%]/.test(perPerson)) continue;
    const last = out[out.length - 1];
    if (/\blimit$/i.test(name) && last) { last.limits.splice(Math.max(0, last.limits.length - 1), 0, { name, value: perPerson }); continue; }
    out.push({ name, coverage: perPerson, limits: perPlan && perPlan !== perPerson ? [{ name: "Per plan", value: perPlan }] : [] });
  }
  return [...cancellationPrograms(text), ...(out.length >= 3 ? out : stackedSchedule(body))];
}

/** "$ 2 , 5 00" → "$2,500"; "150 % of Trip Cost" → "150% of Trip Cost" (a PDF often spaces the characters of a figure apart). */
const figure = (v: string): string => v.replace(/\s+/g, " ").trim().replace(/(?<=[\d$,.])\s+(?=[\d,.%])/g, "").replace(/\$\s+/g, "$");
const isFigure = (v: string): boolean => /^(\$[\d,.]+|\d+%( of .+)?)$/.test(figure(v));

/**
 * The stacked layout (Norwegian's NorwegianCare, an Aon / Nationwide document): a benefit's name, then its lines ("Maximum Benefit", "Dental
 * Expenses"…), then their figures in the same order; or a line and its figure together. A name is a benefit when the next line of words under it
 * is "Maximum Benefit". The Maximum Benefit is the coverage; the other lines are listed under it.
 */
function stackedSchedule(body: string): PlanBenefit[] {
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l && !/^(COVERAGES|MAXIMUM BENEFIT|PER PERSON PER)\b/.test(l));
  const out: PlanBenefit[] = [];
  const waiting: Array<{ benefit: PlanBenefit; label: string }> = [];
  const put = (benefit: PlanBenefit, label: string, value: string) => { if (/^maximum benefit$/i.test(label)) benefit.coverage = figure(value); else benefit.limits.push({ name: label, value: figure(value) }); };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (isFigure(line)) { const w = waiting.shift(); if (w) put(w.benefit, w.label, line); continue; }
    const pair = /^(.+?)\s{2,}(\$.+|\d+\s*%.*)$/.exec(line);
    const current = out[out.length - 1];
    if (pair && isFigure(pair[2]!)) { if (current) put(current, pair[1]!.trim(), pair[2]!); continue; }
    const nextWords = lines.slice(n + 1).find((l) => !isFigure(l)) ?? "";
    if (/^maximum benefit\b/i.test(nextWords) && !/^maximum benefit$/i.test(line)) { out.push({ name: line, coverage: "", limits: [] }); continue; }
    if (current) waiting.push({ benefit: current, label: line });
  }
  return out.filter((b) => b.coverage);
}

/** A cruise line's OWN cancellation programs, when its document states them (they are not insurance): read as the document's summary line prints them. */
function cancellationPrograms(text: string): PlanBenefit[] {
  const flat = text.replace(/\s+/g, " ");
  const out: PlanBenefit[] = [];
  const waiver = /Cancellation Penalty Waiver Program\s*[.…]{2,}\s*(Cash Refund Up to Total Cruise Vacation Cost)/i.exec(flat);
  if (waiver) out.push({ name: "Trip Cancellation: Cancellation Penalty Waiver Program (provided by the cruise line, not insurance)", coverage: waiver[1]!, limits: [] });
  const credit = /Cancel for Any Reason (\w+) Credit Program\s*[.…\s]{2,}provides\s*(\d+\s*%)\**\s*of the non\s*-\s*refundable pre\s*-\s*paid travel arrangements/i.exec(flat);
  if (credit) out.push({ name: `Cancel for Any Reason: ${credit[1]} Credit Program (provided by the cruise line, not insurance)`, coverage: `${figure(credit[2]!)} as a ${credit[1]} Credit`, limits: [] });
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
    let bytes: Uint8Array, sourceUrl: string;
    if (src.via === "aon" && src.aon) {
      // Aon Affinity's page answers a state with the address of the plan document
      at = "asking for the state's document";
      const where = await f(`${AON}/api/getDocumentUrlForState?splr=${src.aon.splr}&carrier=${src.aon.carrier}&product=${src.product}&state=${st}`, { method: "POST", headers: { "user-agent": BROWSER, referer: src.aon.landing } });
      const path = (await where.text()).trim();
      if (!where.ok || !/^\/[\w./-]+\.pdf$/i.test(path)) return { status: "unavailable", reason: `the administrator's page gave no ${src.product} document for ${st}` };
      at = "downloading the document";
      const file = await f(`${AON}${path}`, { headers: { "user-agent": BROWSER } });
      bytes = new Uint8Array(await file.arrayBuffer());
      if (!file.ok) return { status: "unavailable", reason: `the ${src.product} document for ${st} did not download` };
      sourceUrl = src.aon.landing;
    } else {
      const page = await f(CERT_PAGE(src.product), { headers: { "user-agent": BROWSER } });
      const cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
      at = "asking for the state's document";
      const form = new URLSearchParams({ policyNumber: "", appdate: date, product: src.product, certstate: st, submit: "View Terms & Conditions" });
      const answer = await f(CERT_SUBMIT, { method: "POST", headers: { "user-agent": BROWSER, "content-type": "application/x-www-form-urlencoded", referer: CERT_PAGE(src.product), ...(cookie ? { cookie } : {}) }, body: form.toString() });
      const link = /certLinkName=([A-Za-z0-9]+)/.exec(await answer.text())?.[1];
      if (!link) return { status: "unavailable", reason: `the insurer's page gave no ${src.product} document for ${st}` };
      at = "downloading the document";
      const file = await f(CERT_DOWNLOAD(link), { headers: { "user-agent": BROWSER, ...(cookie ? { cookie } : {}) } });
      bytes = new Uint8Array(await file.arrayBuffer());
      if (!file.ok) return { status: "unavailable", reason: `the ${src.product} document for ${st} did not download` };
      sourceUrl = CERT_PAGE(src.product);
    }
    if (bytes.length < 1000 || String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") return { status: "unavailable", reason: `the ${src.product} document for ${st} did not download as a PDF` };
    at = "reading the document";
    const text = await deps.pdfText(bytes);
    if (!text.replace(/\s+/g, "").includes(src.product)) return { status: "unavailable", reason: `the document served is not product ${src.product}` };
    const benefits = scheduleFromPolicyText(text);
    if (benefits.length < 3) return { status: "unavailable", reason: `the Schedule of Benefits could not be read from the ${src.product} document` };
    const [en, es] = STATE_NAMES[st] ?? [st, st];
    return { status: "ready", plan: {
      cruise_line: src.cruiseLine, plan_name: src.plan, product_code: src.product, state: st,
      about: `${src.plan}: ${src.cruiseLine}'s own plan (${src.product}). Insurance benefits are underwritten by ${src.insurer}. The figures are per person, from the plan's Schedule of Benefits.`,
      source_en: `From ${src.cruiseLine}'s plan document ${src.product} for ${en} residents. The policy itself governs.`,
      source_es: `Del documento del plan ${src.product} de ${src.cruiseLine} para residentes de ${es}. La póliza es la que manda.`,
      source_url: sourceUrl, benefits,
    } };
  } catch (err) {
    return { status: "unavailable", reason: `the insurer's page could not be read while ${at}: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}` };
  }
}
