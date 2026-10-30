// travel-advisories.ts — the U.S. Department of State travel advisory for every port on a group's itinerary (Mark 2026-10-30:
// "we are supposed to be pulling the travel advisory levels for each port in the itinerary"). The Department's own RSS feed
// (travel.state.gov) is read when a paperwork page opens, kept for a day, and the last good copy is kept when the feed is down;
// the waiver prints the level per country and ticks the highest one. Nothing here is asked of the client.
import { matchPortName } from "./ports";
import type { Advisory } from "./group-document-kit";
import type { Row } from "./group-document-kit";

export const ADVISORY_FEED = "https://travel.state.gov/_res/rss/TAsTWs.xml";
export interface AdvisoryEntry { country: string; level: 1 | 2 | 3 | 4; title: string }

/** "The Bahamas - Level 2: Exercise Increased Caution" → { country: "The Bahamas", level: 2, title: "Level 2: Exercise Increased Caution" }. */
export function parseAdvisoryFeed(xml: string): AdvisoryEntry[] {
  const out: AdvisoryEntry[] = [];
  for (const m of xml.matchAll(/<title>(?:<!\[CDATA\[)?\s*([^<\]]*?)\s+-\s+Level\s+([1-4])\s*:\s*([^<\]]*?)\s*(?:\]\]>)?<\/title>/g)) {
    const country = m[1]!.replace(/\s+Travel Advisory$/i, "").trim();
    if (!country) continue;
    out.push({ country, level: Number(m[2]) as 1 | 2 | 3 | 4, title: `Level ${m[2]}: ${m[3]!.trim()}` });
  }
  return out;
}

const US_STATES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "CA", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas",
  "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico",
  "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia",
  "Washington", "West Virginia", "Wisconsin", "Wyoming", "Puerto Rico", "USVI", "USA"];
const CANADA = ["Canada", "Nova Scotia", "New Brunswick", "BC", "British Columbia", "Quebec", "Ontario"];
/** Ports whose gazetteer name does not end in their country, and short forms the feed does not use. */
const COUNTRY_OF: Array<[RegExp, string]> = [
  [/grand cayman/i, "Cayman Islands"], [/st\.? ?maarten/i, "Sint Maarten"], [/st\.? ?kitts/i, "Saint Kitts and Nevis"], [/st\.? ?lucia/i, "Saint Lucia"],
  [/antigua/i, "Antigua and Barbuda"], [/bonaire/i, "Bonaire"], [/grand bahama|bahamas/i, "The Bahamas"], [/turks/i, "Turks and Caicos Islands"],
  [/\bBVI\b|tortola/i, "British Virgin Islands"], [/\bDR\b|dominican/i, "Dominican Republic"], [/\bUAE\b/i, "United Arab Emirates"], [/england|scotland|wales|united kingdom/i, "United Kingdom"],
  [/hong kong/i, "Hong Kong"], [/singapore/i, "Singapore"], [/aruba/i, "Aruba"], [/barbados/i, "Barbados"], [/bermuda/i, "Bermuda"], [/cura[cç]ao/i, "Curaçao"],
];

/** The country a port is in, by its gazetteer name ("Nassau, Bahamas" → "The Bahamas"; "Miami, Florida" → "United States"). */
export function countryOfPort(portName: string): string {
  for (const [re, country] of COUNTRY_OF) if (re.test(portName)) return country;
  const tail = portName.split(",").pop()!.trim().replace(/\(.*\)/, "").trim();
  if (US_STATES.includes(tail)) return "United States";
  if (CANADA.includes(tail)) return "Canada";
  return tail || portName;
}

const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/^the\s+/, "").replace(/[^a-z]+/g, " ").trim();

/** The feed's entry for a country, by name ("Bahamas" finds "The Bahamas"; "Mexico" finds "Mexico Travel Advisory"). */
export function advisoryFor(country: string, entries: AdvisoryEntry[]): AdvisoryEntry | null {
  const want = norm(country);
  if (!want) return null;
  return entries.find((e) => norm(e.country) === want) ?? entries.find((e) => norm(e.country).includes(want) || want.includes(norm(e.country))) ?? null;
}

/** The itinerary's ports in order, the embarkation port first, sea days left out. */
export function itineraryPorts(group: Row): string[] {
  const ports: string[] = [];
  const add = (raw: unknown) => {
    const p = typeof raw === "string" ? raw.trim() : "";
    if (!p || /^(at sea|cruising|sea day|scenic cruising)/i.test(p)) return;
    if (!ports.some((x) => x.toLowerCase() === p.toLowerCase())) ports.push(p);
  };
  add(group.embark_port);
  for (const stop of Array.isArray(group.itinerary) ? group.itinerary : []) add((stop as Row)?.port);
  return ports;
}

/** One advisory per port of the itinerary: the country from the gazetteer, the level from the feed (null when the feed has no entry). */
export function advisoriesForPorts(ports: string[], entries: AdvisoryEntry[]): Advisory[] {
  return ports.map((port) => {
    const known = matchPortName(port);
    const country = countryOfPort(known?.name ?? port);
    if (country === "United States") return { port, country, level: null, title: "United States (no State Department advisory applies at home)" };
    const e = advisoryFor(country, entries);
    return e ? { port, country: e.country, level: e.level, title: e.title } : { port, country, level: null, title: "not listed in the State Department feed" };
  });
}

// ── The feed, read at most once a day, last good copy kept ───────────────────
const DAY = 24 * 3_600_000;
let cache: { at: number; entries: AdvisoryEntry[] } | null = null;

export async function advisoryEntries(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<AdvisoryEntry[]> {
  if (cache && now - cache.at < DAY) return cache.entries;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetchImpl(ADVISORY_FEED, { signal: ctrl.signal, headers: { "user-agent": "StillAfloatCruising/1.0 (+https://stillafloatcruising.com)" } });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entries = parseAdvisoryFeed(await res.text());
    if (!entries.length) throw new Error("no advisories in the feed");
    cache = { at: now, entries };
    return entries;
  } catch {
    return cache?.entries ?? [];
  }
}

/** For a paperwork page: every port of the group's itinerary with its advisory; [] when the feed could not be read and nothing is kept. */
export async function advisoriesForGroup(group: Row, fetchImpl: typeof fetch = fetch): Promise<Advisory[]> {
  const entries = await advisoryEntries(fetchImpl);
  if (!entries.length) return [];
  return advisoriesForPorts(itineraryPorts(group), entries);
}

/** Tests and tools: forget the kept copy. */
export function resetAdvisoryCache(): void { cache = null; }
