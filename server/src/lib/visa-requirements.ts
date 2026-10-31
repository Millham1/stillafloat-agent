// visa-requirements.ts — what a U.S. passport needs at each destination, kept in a table of our own (Mark 2026-10-31: "these free
// APIs carry the visa requirements. since this doesn't change often we can load a table in the DB and set a job to review every
// 3 months"). The State Department's own country pages refuse a server's request (see entry-requirements.ts), so the source is
// the Passport Index dataset published on GitHub (ilyankou/passport-index-dataset: the data behind the community passport-visa
// APIs), read as one CSV with no key and no quota. Every row says when it was checked and when it is due again (90 days); the
// daily job (scheduleVisaRequirements in index.ts) refreshes the table only when a row is due or missing, so the review is
// quarterly, and each run says how many destinations changed. The checklist prints the row with its source and date and still
// names the State Department's page for the traveler to verify. Nothing here is asserted that was not read.
import { getSupabase } from "./persistence";

export const VISA_DATASET_URL = "https://raw.githubusercontent.com/ilyankou/passport-index-dataset/master/passport-index-tidy-iso2.csv";
export const VISA_SOURCE = "passport-index-dataset";
export const VISA_SOURCE_PAGE = "https://github.com/ilyankou/passport-index-dataset";
export const VISA_REVIEW_DAYS = 90;
const UA = "StillAfloatCruising/1.0 (+https://stillafloatcruising.com)";

export type Requirement = "visa-free" | "visa-on-arrival" | "e-visa" | "eta" | "visa-required" | "no-admission" | "unknown";
export interface VisaRow {
  passport: string;
  destination_iso2: string;
  destination_name: string;
  requirement: Requirement;
  stay_days: number | null;
  raw: string;
  source: string;
  source_url: string;
  checked_at: string;
  next_check_at: string;
}
export interface VisaStore {
  all(passport: string): Promise<VisaRow[]>;
  upsert(rows: VisaRow[]): Promise<void>;
}

/** The dataset's value for one pair → our requirement and the stay it allows. A number is the visa-free stay in days. */
export function requirementOf(raw: string): { requirement: Requirement; stay_days: number | null } {
  const v = raw.trim().toLowerCase();
  if (/^\d+$/.test(v)) return { requirement: "visa-free", stay_days: Number(v) };
  if (v === "visa free") return { requirement: "visa-free", stay_days: null };
  if (v === "visa on arrival") return { requirement: "visa-on-arrival", stay_days: null };
  if (v === "e-visa" || v === "evisa") return { requirement: "e-visa", stay_days: null };
  if (v === "eta") return { requirement: "eta", stay_days: null };
  if (v === "visa required") return { requirement: "visa-required", stay_days: null };
  if (v === "no admission") return { requirement: "no-admission", stay_days: null };
  return { requirement: "unknown", stay_days: null };
}

/** The tidy CSV (Passport,Destination,Requirement; ISO2 codes) → one passport's rows. "-1" (the passport's own country) is left out. */
export function parseTidyCsv(text: string, passport = "US"): Array<{ destination_iso2: string; raw: string }> {
  const out: Array<{ destination_iso2: string; raw: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(",");
    if (cells.length < 3 || cells[0]!.trim().toUpperCase() !== passport) continue;
    const dest = cells[1]!.trim().toUpperCase(), raw = cells.slice(2).join(",").trim();
    if (!/^[A-Z]{2}$/.test(dest) || raw === "-1" || !raw) continue;
    out.push({ destination_iso2: dest, raw });
  }
  return out;
}

// ── Country names ↔ ISO codes ─────────────────────────────────────────────────

let names: Intl.DisplayNames | null = null;
const regionNames = () => (names ??= new Intl.DisplayNames(["en"], { type: "region" }));
/** "BS" → "Bahamas" (the code itself when Node has no name for it). */
export function regionName(iso2: string): string {
  try { return regionNames().of(iso2.toUpperCase()) ?? iso2; } catch { return iso2; }
}
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/\bst\.?\s/g, "saint ").replace(/\bthe\b/g, " ").replace(/[^a-z]+/g, " ").trim();
/** Names the itinerary and the advisory feed use that Node's region names do not. */
const ALIASES: Record<string, string> = {
  "bahamas": "BS", "sint maarten": "SX", "saint maarten": "SX", "saint martin": "MF", "curacao": "CW", "bonaire": "BQ", "caribbean netherlands": "BQ",
  "turks and caicos": "TC", "turks and caicos islands": "TC", "bvi": "VG", "british virgin islands": "VG", "usvi": "VI", "us virgin islands": "VI",
  "united kingdom": "GB", "uk": "GB", "great britain": "GB", "england": "GB", "scotland": "GB", "wales": "GB", "holland": "NL", "dr": "DO",
  "hong kong": "HK", "macau": "MO", "united arab emirates": "AE", "uae": "AE", "south korea": "KR", "north korea": "KP", "russia": "RU",
  "vietnam": "VN", "laos": "LA", "ivory coast": "CI", "cote d ivoire": "CI", "cape verde": "CV", "cabo verde": "CV", "czech republic": "CZ",
  "swaziland": "SZ", "burma": "MM", "vatican city": "VA", "united states": "US", "usa": "US",
};
let codes: Map<string, string> | null = null;
function codeTable(): Map<string, string> {
  if (codes) return codes;
  codes = new Map();
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const a of A) for (const b of A) {
    const code = a + b, name = regionName(code);
    if (name && name !== code) codes.set(norm(name), code);
  }
  for (const [k, v] of Object.entries(ALIASES)) codes.set(norm(k), v);
  return codes;
}
/** The ISO 3166-1 alpha-2 code of a country as the itinerary names it ("The Bahamas" → "BS"); null when it is not one. */
export function iso2Of(country: string): string | null {
  const want = norm(country);
  if (!want) return null;
  const table = codeTable();
  return table.get(want) ?? [...table.entries()].find(([n]) => n.length > 4 && (n === want || want.endsWith(` ${n}`) || want.startsWith(`${n} `)))?.[1] ?? null;
}

/** The table's row for a country of the itinerary, by its ISO code. */
export function visaRowFor(country: string, rows: VisaRow[]): VisaRow | null {
  const code = iso2Of(country);
  return code ? rows.find((r) => r.destination_iso2 === code) ?? null : null;
}

/** The checklist's words for a row: whether a visa (or an authorization) must be obtained, and Cornerstone's type. */
export function describeVisa(row: VisaRow): { required: boolean | null; type: string } {
  switch (row.requirement) {
    case "visa-free": return { required: false, type: `Visa-free for U.S. passport holders${row.stay_days ? `, stays up to ${row.stay_days} days` : ""}` };
    case "visa-on-arrival": return { required: true, type: "Visa on Arrival (VOA): granted upon entry" };
    case "e-visa": return { required: true, type: "eVisa: applied for online before travel" };
    case "eta": return { required: true, type: "Electronic Travel Authorization (ETA): applied for online before travel" };
    case "visa-required": return { required: true, type: "Visa in Advance: from the consulate or embassy before departure" };
    case "no-admission": return { required: true, type: "No admission for U.S. passport holders, as published; ask us before you book anything ashore" };
    default: return { required: null, type: "Not published for this destination" };
  }
}

export const isDue = (row: VisaRow, now: Date) => Date.parse(row.next_check_at) <= now.getTime();

async function readDataset(fetchImpl: typeof fetch): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetchImpl(VISA_DATASET_URL, { signal: ctrl.signal, headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`the Passport Index dataset answered HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export interface RefreshResult { due: boolean; rows: number; loaded: number; changed: number; next_check_at: string | null }

/** The quarterly review: when any row is due (or the table is empty) the whole passport's rows are read again and written with
 *  today's date; otherwise nothing is fetched. A dataset that cannot be read throws, and the table keeps its rows. */
export async function refreshVisaRequirements(store: VisaStore, fetchImpl: typeof fetch = fetch, now = new Date(), passport = "US", force = false): Promise<RefreshResult> {
  const have = await store.all(passport);
  const nextDue = have.length ? have.map((r) => r.next_check_at).sort()[0]! : null;
  if (!force && have.length && !have.some((r) => isDue(r, now))) return { due: false, rows: have.length, loaded: 0, changed: 0, next_check_at: nextDue };
  const parsed = parseTidyCsv(await readDataset(fetchImpl), passport);
  if (parsed.length < 100) throw new Error(`the Passport Index dataset has only ${parsed.length} rows for ${passport}: not written`);
  const checked = now.toISOString();
  const next = new Date(now.getTime() + VISA_REVIEW_DAYS * 24 * 3_600_000).toISOString();
  const before = new Map(have.map((r) => [r.destination_iso2, r]));
  const rows: VisaRow[] = parsed.map((p) => ({
    passport, destination_iso2: p.destination_iso2, destination_name: regionName(p.destination_iso2), ...requirementOf(p.raw), raw: p.raw,
    source: VISA_SOURCE, source_url: VISA_DATASET_URL, checked_at: checked, next_check_at: next,
  }));
  const changed = rows.filter((r) => { const o = before.get(r.destination_iso2); return !!o && (o.requirement !== r.requirement || o.stay_days !== r.stay_days); }).length;
  await store.upsert(rows);
  return { due: true, rows: rows.length, loaded: rows.length, changed, next_check_at: next };
}

/** The table in Supabase (service key; migration 0064). */
export function supabaseVisaStore(): VisaStore {
  return {
    async all(passport) {
      const r = await getSupabase().from("visa_requirements").select("*").eq("passport", passport);
      if (r.error) throw new Error(`visa_requirements: ${r.error.message}`);
      return (r.data ?? []) as unknown as VisaRow[];
    },
    async upsert(rows) {
      const stamped = rows.map((r) => ({ ...r, updated_at: new Date().toISOString() }));
      const r = await getSupabase().from("visa_requirements").upsert(stamped as unknown as never[], { onConflict: "passport,destination_iso2" });
      if (r.error) throw new Error(`visa_requirements: ${r.error.message}`);
    },
  };
}
