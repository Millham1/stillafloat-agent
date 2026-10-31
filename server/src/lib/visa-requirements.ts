// visa-requirements.ts — what a U.S. passport needs at each destination, kept in a table of our own (Mark 2026-10-31: "these free
// APIs carry the visa requirements. since this doesn't change often we can load a table in the DB and set a job to review every
// 3 months"). The State Department's own country pages refuse a server's request (see entry-requirements.ts), so the source is
// the Passport Index dataset published on GitHub (ilyankou/passport-index-dataset: the data behind the community passport-visa
// APIs), read as one CSV with no key and no quota. Every row says when it was checked and when it is due again (90 days); the
// daily job (scheduleVisaRequirements in index.ts) refreshes the table only when a row is due or missing, so the review is
// quarterly, and each run says how many destinations changed. The checklist prints the row with its source and date and still
// names the State Department's page for the traveler to verify. Nothing here is asserted that was not read.
import { getSupabase } from "./persistence";
import { ALPHA3 } from "./iso3166";

export const VISA_DATASET_URL = "https://raw.githubusercontent.com/ilyankou/passport-index-dataset/master/passport-index-tidy-iso2.csv";
export const VISA_SOURCE = "passport-index-dataset";
export const VISA_SOURCE_PAGE = "https://github.com/ilyankou/passport-index-dataset";
export const VISA_REVIEW_DAYS = 90;
const UA = "StillAfloatCruising/1.0 (+https://stillafloatcruising.com)";

// ── The second source (Mark 2026-10-31, "Yes, add one"): Orizn's visa API, for the destinations the dataset lacks ──
// The dataset lists countries only; cruise ships call at territories (Cayman, Sint Maarten, Curaçao, Aruba, Turks and Caicos,
// the BVI, Bermuda…). Orizn (visa.orizn.app: OpenAPI at /.well-known/openapi.json; GET /api/v1/visa?passport=USA&destination=CYM
// with an x-api-key; 250 destinations; a free key of 100 requests a month, no card) fills those rows, and any itinerary country
// the dataset lacks, on the same 90-day review. Only what the dataset lacks is asked for, a few dozen a quarter at most, with a
// reserve kept on the monthly quota; the key is Mark's (ORIZN_API_KEY in the box's shared.env) and without one those rows stay
// "could not be read". Orizn speaks ISO alpha-3 (lib/iso3166.ts).
export const ORIZN_BASE = "https://visa.orizn.app/api/v1/visa";
export const ORIZN_SOURCE = "orizn";
export const ORIZN_DOCS = "https://visa.orizn.app/visa-api/docs";
/** Cruise ports whose territory the dataset does not list, by ISO 3166-1 alpha-2 (U.S. territories are "home" and need no row). */
export const CRUISE_TERRITORIES = ["KY", "SX", "CW", "AW", "BQ", "TC", "VG", "BM", "MQ", "GP", "MF", "BL", "AI", "MS", "GL", "GI", "FO", "PF", "NC", "MO", "RE"] as const;
/** The quota kept unspent on a free key, so a review never uses the month's last requests. */
export const ORIZN_RESERVE = 5;
const ORIZN_REQ: Record<string, Requirement> = { visa_free: "visa-free", visa_required: "visa-required", e_visa: "e-visa", visa_on_arrival: "visa-on-arrival", eta: "eta", no_admission: "no-admission" };

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

/** What an Orizn row keeps beside the requirement (its `raw` is JSON); {} for a dataset row. */
export function oriznDetail(row: VisaRow): { passport_validity_months?: number; documents_required?: string[]; last_verified_at?: string | null; verified?: boolean } {
  if (row.source !== ORIZN_SOURCE) return {};
  try { const d = JSON.parse(row.raw); return d && typeof d === "object" ? d : {}; } catch { return {}; }
}
/** How the checklist names a row's source. */
export function visaSourceLabel(source: string): string {
  return source === ORIZN_SOURCE ? "Orizn visa data" : source === VISA_SOURCE ? "Passport Index data" : source;
}

/** The checklist's words for a row: whether a visa (or an authorization) must be obtained, and Cornerstone's type. */
export function describeVisa(row: VisaRow): { required: boolean | null; type: string } {
  const months = oriznDetail(row).passport_validity_months;
  const validity = Number.isInteger(months) && (months as number) > 0 ? `; passport valid at least ${months} months` : "";
  switch (row.requirement) {
    case "visa-free": return { required: false, type: `Visa-free for U.S. passport holders${row.stay_days ? `, stays up to ${row.stay_days} days` : ""}${validity}` };
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

export interface OriznAnswer { row: VisaRow | null; remaining: number | null }

/** One destination from Orizn: its requirement, the visa-free stay, what it keeps beside (documents, passport validity, its own
 *  source and verification date), and the quota left. A 404 ("no visa data") is a null row; a refused key, an exhausted quota or
 *  a failure throws, so the job's ledger says so. */
export async function fetchOrizn(iso2: string, key: string, fetchImpl: typeof fetch = fetch, now = new Date(), passport = "US"): Promise<OriznAnswer> {
  const dest = ALPHA3[iso2.toUpperCase()], pass = ALPHA3[passport.toUpperCase()];
  if (!dest || !pass) return { row: null, remaining: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetchImpl(`${ORIZN_BASE}?passport=${pass}&destination=${dest}&lang=en`, { signal: ctrl.signal, headers: { "x-api-key": key, accept: "application/json", "user-agent": UA } });
  } finally {
    clearTimeout(timer);
  }
  const header = Number(res.headers.get("x-ratelimit-remaining"));
  const remaining = Number.isFinite(header) ? header : null;
  if (res.status === 404) return { row: null, remaining };
  if (res.status === 401) throw new Error("Orizn refused the API key (401): check ORIZN_API_KEY on this box");
  if (res.status === 429) throw new Error("Orizn: the month's quota is used up (429)");
  if (!res.ok) throw new Error(`Orizn answered HTTP ${res.status} for ${dest}`);
  const j = (await res.json()) as { data?: Record<string, unknown>; meta?: { quota?: { remaining?: unknown } } };
  const d = (j.data ?? j) as Record<string, unknown>;
  const requirement = ORIZN_REQ[String(d["requirement"])] ?? "unknown";
  const days = Number.isInteger(d["visa_free_days"]) ? (d["visa_free_days"] as number) : null;
  const detail = {
    requirement: d["requirement"] ?? null, visa_free_days: days, verified: !!d["verified"], source: typeof d["source"] === "string" ? d["source"] : null,
    source_url: typeof d["source_url"] === "string" ? d["source_url"] : null, last_verified_at: typeof d["last_verified_at"] === "string" ? d["last_verified_at"] : null,
    passport_validity_months: Number.isInteger(d["passport_validity_months"]) ? (d["passport_validity_months"] as number) : null,
    documents_required: Array.isArray(d["documents_required"]) ? (d["documents_required"] as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 8) : [],
  };
  const quota = Number(j.meta?.quota?.remaining);
  return {
    row: {
      passport, destination_iso2: iso2.toUpperCase(), destination_name: regionName(iso2), requirement, stay_days: days, raw: JSON.stringify(detail),
      source: ORIZN_SOURCE, source_url: detail.source_url ?? ORIZN_DOCS, checked_at: now.toISOString(), next_check_at: new Date(now.getTime() + VISA_REVIEW_DAYS * 24 * 3_600_000).toISOString(),
    },
    remaining: Number.isFinite(quota) ? quota : remaining,
  };
}

export interface RefreshOptions {
  /** read the dataset again whether or not a row is due */
  force?: boolean;
  /** ORIZN_API_KEY; without it the destinations the dataset lacks stay unfilled and the result says so */
  oriznKey?: string | undefined;
  /** destinations (alpha-2) the open groups' itineraries need, beside the standing territory list */
  wanted?: string[] | (() => Promise<string[]>);
  /** the most Orizn requests one run may spend (the quota is 100 a month on a free key) */
  maxOrizn?: number;
}
export interface RefreshResult {
  due: boolean; rows: number; loaded: number; changed: number; next_check_at: string | null;
  /** the second source's pass: what it fetched, what is still missing, and why it stopped if it did */
  orizn: { fetched: number; missing: string[]; note: string; remaining: number | null };
}

/** The quarterly review: when any dataset row is due (or the table is empty) the whole passport's rows are read again and
 *  written with today's date; otherwise nothing is fetched from the dataset. Then the destinations the dataset lacks (the
 *  territories cruise ships call at, and any itinerary country without a row) are asked of Orizn, when a key is on the box:
 *  only the missing or due ones, within the run's cap and the quota's reserve. A dataset that cannot be read throws, and the
 *  table keeps its rows. */
export async function refreshVisaRequirements(store: VisaStore, fetchImpl: typeof fetch = fetch, now = new Date(), passport = "US", options: RefreshOptions | boolean = {}): Promise<RefreshResult> {
  const opts: RefreshOptions = typeof options === "boolean" ? { force: options } : options;
  let have = await store.all(passport);
  const nextDue = have.length ? have.map((r) => r.next_check_at).sort()[0]! : null;
  const next = new Date(now.getTime() + VISA_REVIEW_DAYS * 24 * 3_600_000).toISOString();
  const datasetDue = !!opts.force || !have.length || have.some((r) => r.source === VISA_SOURCE && isDue(r, now));
  let loaded = 0, changed = 0;
  if (datasetDue) {
    const parsed = parseTidyCsv(await readDataset(fetchImpl), passport);
    if (parsed.length < 100) throw new Error(`the Passport Index dataset has only ${parsed.length} rows for ${passport}: not written`);
    const before = new Map(have.map((r) => [r.destination_iso2, r]));
    const rows: VisaRow[] = parsed.map((p) => ({
      passport, destination_iso2: p.destination_iso2, destination_name: regionName(p.destination_iso2), ...requirementOf(p.raw), raw: p.raw,
      source: VISA_SOURCE, source_url: VISA_DATASET_URL, checked_at: now.toISOString(), next_check_at: next,
    }));
    changed = rows.filter((r) => { const o = before.get(r.destination_iso2); return !!o && (o.requirement !== r.requirement || o.stay_days !== r.stay_days); }).length;
    await store.upsert(rows);
    loaded = rows.length;
    have = await store.all(passport);
  }
  // the second source: what the dataset lacks
  const wanted = typeof opts.wanted === "function" ? await opts.wanted().catch(() => [] as string[]) : opts.wanted ?? [];
  const byCode = new Map(have.map((r) => [r.destination_iso2, r]));
  const candidates = [...new Set([...CRUISE_TERRITORIES, ...wanted.map((c) => c.toUpperCase())])].filter((c) => /^[A-Z]{2}$/.test(c) && c !== passport);
  const todo = candidates.filter((c) => { const r = byCode.get(c); return !r || (r.source === ORIZN_SOURCE && isDue(r, now)); });
  const orizn: RefreshResult["orizn"] = { fetched: 0, missing: candidates.filter((c) => !byCode.has(c)), note: "", remaining: null };
  const key = opts.oriznKey;
  if (todo.length && !key) orizn.note = "no ORIZN_API_KEY on this box: the destinations the dataset lacks stay unfilled";
  else if (todo.length && key) {
    const cap = opts.maxOrizn ?? 40;
    const got: VisaRow[] = [];
    for (const code of todo) {
      if (got.length >= cap) { orizn.note = `stopped at this run's cap of ${cap} requests`; break; }
      if (orizn.remaining !== null && orizn.remaining <= ORIZN_RESERVE) { orizn.note = `stopped: ${orizn.remaining} requests left on the month's quota (${ORIZN_RESERVE} kept in reserve)`; break; }
      // the territories ask for a few dozen requests a quarter; the key is Mark's and the month's quota is 100 on a free key
      const a = await fetchOrizn(code, key, fetchImpl, now, passport);
      orizn.remaining = a.remaining;
      // "no visa data" is written too, as unknown, so the same question is not asked every day; it is asked again at the review
      got.push(a.row ?? { passport, destination_iso2: code, destination_name: regionName(code), requirement: "unknown", stay_days: null, raw: JSON.stringify({ orizn: "no visa data" }), source: ORIZN_SOURCE, source_url: ORIZN_DOCS, checked_at: now.toISOString(), next_check_at: next });
    }
    if (got.length) await store.upsert(got);
    orizn.fetched = got.length;
    const after = new Set((await store.all(passport)).map((r) => r.destination_iso2));
    orizn.missing = candidates.filter((c) => !after.has(c));
  }
  return { due: datasetDue, rows: (await store.all(passport)).length, loaded, changed, next_check_at: datasetDue ? next : nextDue, orizn };
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
