import { logger } from "./logger";
import { getSupabase } from "./persistence";
import type { Sailing } from "./storm-sailings";

// A permanent, labelled TEST storm for the DEV mirror (Mark 2026-10-12: "build the never-ending dev storm fixture").
//
// Mark's 2026-10-04 mirror ruling: dev holds the conditions prod can have, including a live public storm. Until now
// dev leaned on whatever real storm happened to be live (Isaias, then Simon), so each time the weather moved on, seven
// release-gate checks went untestable. With DEV_STORM_FIXTURE=1 the storm scan keeps one hand-declared storm alive on
// dev, forever:
//   • a "sent" alert on the Bermuda grounds, classification Gale Warning (so it pins ships, and the paid intel sweep —
//     which only reads Tropical Storm and up — never touches it), no window (a hand-declared storm with no window is
//     open until dismissed), English and Spanish text, labelled as a test on its face;
//   • exactly three impacted ships — MSC Meraviglia, MSC Seashore, MSC Seascape: mainstream, and each already has a
//     position in the tracker (the gate's "she is followed and held" check needs one, and a first pin of a ship the
//     tracker has never heard would buy a Live-AIS fix) — through rolling `sailings` rows tagged source "dev-fixture" and
//     region "dev-fixture" (so no real storm ever matches them). impactedShipsForAlert answers with those rows
//     only, so the pins (and the Live-AIS lookups a new pin makes: three, about $0.06, once) never grow with the fleet.
// It never emails anyone (the row is inserted already "sent"), and it refuses to run on a box whose PUBLIC_URL is the
// production site. If it is dismissed or ended, the next scan revives it.

export const FIXTURE_NHC_ID = "MANUAL-dev-gate-storm";
export const FIXTURE_SOURCE = "dev-fixture";
export const FIXTURE_GROUND = "bermuda";
/** The sailings' own region tag: no real storm's grounds ever overlap it, so the fixture ships never leak into a real storm. */
export const FIXTURE_REGION = "dev-fixture";
const PRODUCTION_HOST = /(^|[/.])stillafloatcruising\.com(?=[/:]|$)/i;

export const FIXTURE_SHIPS = [
  { name: "MSC Meraviglia", line: "MSC", port: "Port Canaveral, Florida" },
  { name: "MSC Seashore", line: "MSC", port: "Port Canaveral, Florida" },
  { name: "MSC Seascape", line: "MSC", port: "Galveston, Texas" },
] as const;

export function devStormFixtureEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env["DEV_STORM_FIXTURE"] !== "1") return false;
  const url = env["PUBLIC_URL"] ?? "";
  return url.length > 0 && !PRODUCTION_HOST.test(url);
}

/** Is this the fixture alert? (Only ever true on a box that has the fixture switched on.) */
export function isDevFixtureAlert(a: { raw?: unknown }, env: Record<string, string | undefined> = process.env): boolean {
  const raw = a.raw as { source?: unknown } | null | undefined;
  return raw?.source === FIXTURE_SOURCE && devStormFixtureEnabled(env);
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The rolling sailing every fixture ship is "on": it started 2 days ago and ends in 10 (12 days, well inside the 120-day sanity limit). */
export function fixtureWindow(now: Date): { start: string; end: string } {
  return { start: day(now.getTime() - 2 * 86_400_000), end: day(now.getTime() + 10 * 86_400_000) };
}

export function fixtureSailingRows(now: Date) {
  const w = fixtureWindow(now);
  return FIXTURE_SHIPS.map((s) => ({
    ship_name: s.name, cruise_line: s.line, depart_port: s.port,
    start_date: w.start, end_date: w.end, regions: [FIXTURE_REGION], active: true, source: FIXTURE_SOURCE,
  }));
}

export function fixtureAlertRow(now: Date) {
  const at = now.toISOString();
  return {
    nhc_id: FIXTURE_NHC_ID, basin: "atlantic", name: "Gate Fixture", classification: "Gale Warning", is_threat: true,
    affected_grounds: [FIXTURE_GROUND], formation_chance: null,
    raw: { source: FIXTURE_SOURCE, note: "Permanent test storm for the dev mirror (lib/dev-storm-fixture.ts). Not real weather." },
    content_hash: "dev-gate-fixture-v1",
    window_start: null, window_end: null,
    headline: "Test storm: a gale warning for Bermuda (dev site only — not real weather)",
    body_md:
      "**Gate Fixture** (Gale Warning) — a permanent TEST storm on the Still Afloat development site, so the release gate always has a public storm to check. It is not real weather.\n\n" +
      "**What this means for you:** if you were sailing near Bermuda this week, itineraries could be adjusted at the cruise line's discretion. This is a test, so there is nothing to do.",
    headline_es: "Tormenta de prueba: aviso de vendaval para las Bermudas (solo en el sitio de desarrollo; no es clima real)",
    body_md_es:
      "**Gate Fixture** (Aviso de vendaval) — una tormenta de PRUEBA permanente en el sitio de desarrollo de Still Afloat, para que la verificación de lanzamiento siempre tenga una tormenta pública que revisar. No es clima real.\n\n" +
      "**Lo que esto significa para ti:** si navegaras cerca de las Bermudas esta semana, los itinerarios podrían ajustarse a criterio de la naviera. Es una prueba, así que no hay nada que hacer.",
    status: "sent",
    first_seen: at, last_updated: at, approved_at: at, sent_at: at, sent_count: 0,
  };
}

/** Rows the storm pages list for the fixture alert: its three ships on their rolling sailing. */
export async function fixtureSailings(windowStart: string, windowEnd: string): Promise<Sailing[]> {
  const { data, error } = await getSupabase()
    .from("sailings")
    .select("ship_name, cruise_line, depart_port, start_date, end_date, regions")
    .eq("source", FIXTURE_SOURCE).eq("active", true)
    .lte("start_date", windowEnd).gte("end_date", windowStart);
  if (error) throw new Error(`fixtureSailings: ${error.message}`);
  return ((data ?? []) as unknown as Sailing[]).sort((a, b) => a.ship_name.localeCompare(b.ship_name));
}

/**
 * Keep the fixture alive. Run before every storm-lifecycle pass. Returns what it did.
 *   off      — not a dev box with DEV_STORM_FIXTURE=1
 *   created  — the alert did not exist
 *   revived  — it had been ended or dismissed (or edited back to a draft)
 *   kept     — already live
 */
export async function ensureDevStormFixture(now: Date = new Date()): Promise<"off" | "created" | "revived" | "kept"> {
  if (!devStormFixtureEnabled()) return "off";
  const supabase = getSupabase();

  // The three ships' rolling sailing: update in place so the pages never see an empty moment; add what is missing.
  const have = await supabase.from("sailings").select("id, ship_name").eq("source", FIXTURE_SOURCE);
  if (have.error) throw new Error(`dev storm fixture: reading sailings failed: ${have.error.message}`);
  const byName = new Map(((have.data ?? []) as unknown as { id: string; ship_name: string }[]).map((r) => [r.ship_name, r.id]));
  for (const row of fixtureSailingRows(now)) {
    const id = byName.get(row.ship_name);
    const res = id
      ? await supabase.from("sailings").update(row as never).eq("id", id)
      : await supabase.from("sailings").insert(row as never);
    if (res.error) throw new Error(`dev storm fixture: writing ${row.ship_name} failed: ${res.error.message}`);
    byName.delete(row.ship_name);
  }
  for (const stale of byName.values()) await supabase.from("sailings").delete().eq("id", stale);

  const { data, error } = await supabase.from("storm_alerts").select("id, status").eq("nhc_id", FIXTURE_NHC_ID).maybeSingle();
  if (error) throw new Error(`dev storm fixture: alert lookup failed: ${error.message}`);
  const row = data as { id: string; status: string } | null;
  const insertable = fixtureAlertRow(now);
  if (!row) {
    const made = await supabase.from("storm_alerts").insert(insertable as never);
    if (made.error) throw new Error(`dev storm fixture: creating the alert failed: ${made.error.message}`);
    logger.info({ nhcId: FIXTURE_NHC_ID }, "dev storm fixture: created");
    return "created";
  }
  if (row.status === "sent") {
    await supabase.from("storm_alerts").update({ last_updated: now.toISOString(), missing_scans: 0 } as never).eq("id", row.id);
    return "kept";
  }
  const back = await supabase.from("storm_alerts").update({
    status: "sent", ended_at: null, missing_scans: 0, last_updated: now.toISOString(), sent_at: now.toISOString(),
    all_clear_headline: null, all_clear_body_md: null, all_clear_sent_at: null, all_clear_skipped_at: null,
  } as never).eq("id", row.id);
  if (back.error) throw new Error(`dev storm fixture: reviving the alert failed: ${back.error.message}`);
  logger.info({ nhcId: FIXTURE_NHC_ID, was: row.status }, "dev storm fixture: revived");
  return "revived";
}
