// entry-requirements.ts — what each country on a group's itinerary asks of a U.S. traveler, for the passport and travel document
// checklist (Mark 2026-10-31: "we need to do a visa/vaccination requirements check for every country on the itinerary; this should
// be done as part of the travel advisory check routine"). Read when a paperwork page opens, beside the State Department advisory
// (travel-advisories.ts), kept for a week, the last good copy kept when a source is down. Nothing is asserted that was not read.
//
// Two government sources, one per question:
//   * VACCINATIONS: the CDC's Travelers' Health destination page (wwwnc.cdc.gov/travel/destinations/traveler/none/<country>), its
//     "Vaccines and Medicines" table: what the country REQUIRES at entry (yellow fever, for travel from the United States) and what
//     the CDC recommends, says to consider, or lists as routine. The destination list page maps a country name to its page.
//   * VISAS: the State Department's country information page (travel.state.gov …/International-Travel-Country-Information-Pages),
//     whose "Quick Facts" say whether a tourist visa is required, the passport validity asked, blank pages and vaccinations.
//     As of 2026-10-31 travel.state.gov answers a server's request for every country page, its index and its data API
//     (cadataapi.state.gov/api/CountryInformation) with a Cloudflare "Attention Required" page (HTTP 403), while its advisory feed
//     answers normally. The reader below parses Quick Facts whenever the page answers; until then `visa` is null and the checklist
//     says the line could not be read and carries the page for the traveler to check.
import type { EntryRequirement, Row, VaccineLine } from "./group-document-kit";
import { countryOfPort, itineraryPorts } from "./travel-advisories";
import { matchPortName } from "./ports";
import { visaRowFor, type VisaRow } from "./visa-requirements";

export const CDC_LIST_URL = "https://wwwnc.cdc.gov/travel/destinations/list";
const CDC_BASE = "https://wwwnc.cdc.gov";
export const STATE_COUNTRY_INDEX = "https://travel.state.gov/content/travel/en/international-travel/International-Travel-Country-Information-Pages.html";
const STATE_COUNTRY_BASE = "https://travel.state.gov/content/travel/en/international-travel/International-Travel-Country-Information-Pages/";
const UA = "StillAfloatCruising/1.0 (+https://stillafloatcruising.com)";

const strip = (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#8217;|&rsquo;/g, "’").replace(/&#8211;|&ndash;/g, "–").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
/** "Bahamas, The" → "bahamas"; "Virgin Islands, British" → "british virgin islands"; "Anguilla (U.K.)" → "anguilla". */
export function normCountry(name: string): string {
  let s = name.replace(/\(.*?\)/g, "").trim();
  const m = /^(.+?),\s*(.+)$/.exec(s);
  if (m) s = `${m[2]} ${m[1]}`;
  return s.toLowerCase().replace(/&/g, "and").replace(/\bthe\b/g, " ").replace(/[^a-z]+/g, " ").trim();
}

// ── The CDC ───────────────────────────────────────────────────────────────────

/** The destination list page: every country with its page's slug. */
export function parseCdcList(html: string): Array<{ name: string; slug: string }> {
  const out: Array<{ name: string; slug: string }> = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/href="\/travel\/destinations\/traveler\/none\/([a-z0-9-]+)"[^>]*>\s*([^<]+?)\s*</g)) {
    const slug = m[1]!, name = m[2]!.replace(/\s+/g, " ").trim();
    if (!name || seen.has(`${slug}|${name}`)) continue;
    seen.add(`${slug}|${name}`);
    out.push({ name, slug });
  }
  return out;
}

/** The slug of a country's CDC page, by name (loosely: "The Bahamas" finds "Bahamas, The"). */
export function cdcSlugFor(country: string, list: Array<{ name: string; slug: string }>): string | null {
  const want = normCountry(country);
  if (!want) return null;
  const exact = list.find((e) => normCountry(e.name) === want);
  if (exact) return exact.slug;
  const loose = list.find((e) => normCountry(e.name).includes(want) || want.includes(normCountry(e.name)));
  return loose?.slug ?? null;
}

/** The "Vaccines and Medicines" table of a destination page: one line per vaccine, with what the CDC says about it. */
export function parseCdcVaccines(html: string): VaccineLine[] {
  const at = html.indexOf("Vaccines and Medicines");
  if (at < 0) return [];
  const rest = html.slice(at);
  const tableStart = rest.indexOf("<table");
  const tableEnd = rest.indexOf("</table>");
  if (tableStart < 0 || tableEnd < 0) return [];
  const table = rest.slice(tableStart, tableEnd);
  const lines: VaccineLine[] = [];
  for (const tr of table.matchAll(/<tr[\s\S]*?<\/tr>/g)) {
    const cells = [...tr[0].matchAll(/<td[\s\S]*?<\/td>/g)].map((c) => strip(c[0]));
    if (cells.length < 2) continue;
    const name = cells[0]!.replace(/\s+/g, " ").trim();
    const text = cells[1]!;
    if (!name) continue;
    lines.push({ name, ...classify(name, text) });
  }
  return lines;
}

function classify(name: string, text: string): { advice: VaccineLine["advice"]; text: string } {
  const sentence = (s: string) => (s.split(/(?<=\.)\s+/)[0] ?? s).slice(0, 220);
  if (/^routine vaccines/i.test(name)) return { advice: "routine", text: "Up to date on all routine vaccines before every trip." };
  const entry = /Direct travel from (?:the )?United States:\s*Vaccine is (not )?required[^.]*\./i.exec(text);
  if (entry) return { advice: entry[1] ? "not-required" : "required", text: `Entry requirement for travel from the United States: vaccine is ${entry[1] ? "not " : ""}required.` };
  if (/^recommended for|should be up to date|should be fully vaccinated|is recommended for (?:all|most|unvaccinated)/i.test(text)) return { advice: "recommended", text: sentence(text) };
  if (/^consider|consult with a healthcare provider|please consult/i.test(text)) return { advice: "consider", text: sentence(text) };
  if (/not recommended/i.test(text)) return { advice: "not-required", text: sentence(text) };
  return { advice: "other", text: sentence(text) };
}

// ── The State Department ──────────────────────────────────────────────────────

/** The country page's slug as travel.state.gov spells it: the name run together ("The Bahamas" → "TheBahamas"). */
export function stateCountrySlug(country: string): string {
  return country.replace(/\(.*?\)/g, "").replace(/&/g, "and").replace(/[^A-Za-z0-9]+/g, "");
}
export const stateCountryUrl = (country: string) => `${STATE_COUNTRY_BASE}${stateCountrySlug(country)}.html`;

/** The page's "Quick Facts" (tourist visa required, passport validity, blank pages, vaccinations); null when the page has none. */
export function parseStateQuickFacts(html: string): { tourist_visa_required: boolean | null; passport_validity: string; blank_pages: string; vaccinations: string } | null {
  const text = strip(html);
  const at = text.search(/quick facts/i);
  if (at < 0) return null;
  const seg = text.slice(at, at + 3000);
  const grab = (label: RegExp) => { const m = label.exec(seg); return m ? m[1]!.trim().replace(/\s*(PASSPORT VALIDITY|BLANK PASSPORT PAGES|TOURIST VISA REQUIRED|VACCINATIONS|CURRENCY RESTRICTIONS).*$/i, "").trim() : ""; };
  const visa = grab(/TOURIST VISA REQUIRED:?\s*(.{1,120}?)(?=\s+(?:VACCINATIONS|CURRENCY|PASSPORT|BLANK)\b|$)/i);
  const validity = grab(/PASSPORT VALIDITY:?\s*(.{1,160}?)(?=\s+(?:BLANK PASSPORT|TOURIST VISA|VACCINATIONS|CURRENCY)\b|$)/i);
  const pages = grab(/BLANK PASSPORT PAGES:?\s*(.{1,120}?)(?=\s+(?:TOURIST VISA|VACCINATIONS|CURRENCY|PASSPORT)\b|$)/i);
  const vaccinations = grab(/VACCINATIONS:?\s*(.{1,160}?)(?=\s+(?:CURRENCY|PASSPORT|BLANK|TOURIST)\b|$)/i);
  if (!visa && !validity && !pages && !vaccinations) return null;
  const required = /^no\b/i.test(visa) ? false : /^yes\b/i.test(visa) ? true : null;
  return { tourist_visa_required: required, passport_validity: validity, blank_pages: pages, vaccinations };
}

// ── Reading, kept for a week ──────────────────────────────────────────────────

const WEEK = 7 * 24 * 3_600_000;
const DAY = 24 * 3_600_000;
type Kept<T> = { at: number; value: T };
let listCache: Kept<Array<{ name: string; slug: string }>> | null = null;
const cdcCache = new Map<string, Kept<EntryRequirement["vaccines"]>>();
const stateCache = new Map<string, Kept<EntryRequirement["visa"]>>();

async function read(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" } });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function cdcList(fetchImpl: typeof fetch, now: number): Promise<Array<{ name: string; slug: string }>> {
  if (listCache && now - listCache.at < WEEK) return listCache.value;
  const html = await read(CDC_LIST_URL, fetchImpl);
  const list = html ? parseCdcList(html) : [];
  if (list.length) listCache = { at: now, value: list };
  return listCache?.value ?? [];
}

async function cdcFor(country: string, fetchImpl: typeof fetch, now: number): Promise<EntryRequirement["vaccines"]> {
  const kept = cdcCache.get(country);
  if (kept && now - kept.at < (kept.value ? WEEK : DAY)) return kept.value;
  const slug = cdcSlugFor(country, await cdcList(fetchImpl, now));
  const url = slug ? `${CDC_BASE}/travel/destinations/traveler/none/${slug}` : null;
  const html = url ? await read(url, fetchImpl) : null;
  const lines = html ? parseCdcVaccines(html) : [];
  const value = lines.length && url ? { lines, url, read_at: new Date(now).toISOString() } : null;
  if (value || !kept?.value) cdcCache.set(country, { at: now, value: value ?? kept?.value ?? null });
  return value ?? kept?.value ?? null;
}

async function stateFor(country: string, fetchImpl: typeof fetch, now: number): Promise<EntryRequirement["visa"]> {
  const kept = stateCache.get(country);
  if (kept && now - kept.at < (kept.value ? WEEK : DAY)) return kept.value;
  const url = stateCountryUrl(country);
  const html = await read(url, fetchImpl);
  const facts = html ? parseStateQuickFacts(html) : null;
  const value = facts ? { ...facts, url, read_at: new Date(now).toISOString() } : null;
  if (value || !kept?.value) stateCache.set(country, { at: now, value: value ?? kept?.value ?? null });
  return value ?? kept?.value ?? null;
}

/** The countries of an itinerary (home ports left out), each with its ports. */
export function countriesOf(ports: string[]): Array<{ country: string; ports: string[] }> {
  const out: Array<{ country: string; ports: string[] }> = [];
  for (const port of ports) {
    const known = matchPortName(port);
    const country = countryOfPort(known?.name ?? port);
    if (country === "United States") continue;
    const row = out.find((r) => r.country === country);
    if (row) { if (!row.ports.includes(port)) row.ports.push(port); } else out.push({ country, ports: [port] });
  }
  return out;
}

/** Every country of the group's itinerary with what was read for it; a source that could not be read is null, never guessed.
 *  `visaRows`: our own visa table (lib/visa-requirements.ts), read once per call; the checklist uses it when the State Department's
 *  page did not answer. */
export async function entryRequirementsForGroup(group: Row, fetchImpl: typeof fetch = fetch, now = Date.now(), visaRows?: VisaRow[] | (() => Promise<VisaRow[]>)): Promise<EntryRequirement[]> {
  const out: EntryRequirement[] = [];
  const countries = countriesOf(itineraryPorts(group));
  let table: VisaRow[] = [];
  if (countries.length && visaRows) {
    try { table = typeof visaRows === "function" ? await visaRows() : visaRows; } catch { table = []; }
  }
  for (const { country, ports } of countries) {
    const [vaccines, visa] = await Promise.all([cdcFor(country, fetchImpl, now), stateFor(country, fetchImpl, now)]);
    const row = visaRowFor(country, table);
    out.push({
      country, ports, vaccines, visa, visa_url: stateCountryUrl(country),
      table: row ? { requirement: row.requirement, stay_days: row.stay_days, raw: row.raw, source: row.source, source_url: row.source_url, checked_at: row.checked_at } : null,
    });
  }
  return out;
}

/** Tests and tools: forget the kept copies. */
export function resetEntryCache(): void { listCache = null; cdcCache.clear(); stateCache.clear(); }
