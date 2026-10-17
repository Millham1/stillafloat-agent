// group-journey-store.ts — the journey engine wired to Supabase and the outside data it reads (the channel scan, the ship
// tables, the forecast, the storm tables). All I/O lives here and in the routes; the rules are in group-journey*.ts.
// Read-only toward every table it did not create: it writes only group_messages, groups.journey, group_travelers.hub_token_hash
// and the site-wide default in platform_state.

import { getSupabase, readJson, writeJson, PATHS } from "./persistence";
import { logger } from "./logger";
import { TRAVELER_COLS } from "./group-forms";
import { shipSlugCandidate } from "./group-marketing";
import { fetchForecast } from "./weather-forecast";
import { ACTIVE_GROUP_STATUSES, type JourneyDefaults } from "./group-journey";
import { dayDiff, stopsInHorizon, type Extras, type ForecastDay, type JourneyInput, type Row, type ScanVideo, type StormNote } from "./group-journey-facts";
import type { Clock, JourneyStore, Needs } from "./group-journey-run";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (): any => getSupabase();

export const DEFAULTS_KEY = "group-journey-defaults";

const must = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return (r.data ?? ([] as unknown)) as T;
};

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const MESSAGE_COLS = "id, group_id, cabin_id, traveler_id, template, to_email, subject, status, dedupe_key, sent_at, error, created_at, updated_at, meta";

/** A group's rows, for planning and rendering. `messages: false` skips the log (the cruise page does not need it). */
export async function loadJourneyInput(groupId: string, o: { messages?: boolean } = {}): Promise<JourneyInput | null> {
  const g = await db().from("groups").select("*").eq("id", groupId).maybeSingle();
  if (g.error) throw new Error(`groups: ${g.error.message}`);
  if (!g.data) return null;
  const by = (table: string, cols: string, order: string) =>
    db().from(table).select(cols).eq("group_id", groupId).order(order, { ascending: true }).order("id", { ascending: true });
  const [cabins, travelers, payments, travel, checklist, sigs] = await Promise.all([
    by("group_cabins", "*", "cabin_num"),
    by("group_travelers", `${TRAVELER_COLS}, hub_token_hash`, "last_name"),
    by("group_payments", "*", "due_date"),
    by("group_travel", "*", "starts_at"),
    by("group_checklist", "*", "sort"),
    db().from("group_signatures").select("traveler_id, doc_key, signer_role, signed_at").eq("group_id", groupId),
  ]);
  const messages = o.messages === false ? { data: [], error: null } : await db().from("group_messages").select(MESSAGE_COLS).eq("group_id", groupId).order("created_at", { ascending: false }).limit(3000);
  return {
    group: g.data as Row, cabins: must<Row[]>(cabins, "group_cabins"), travelers: must<Row[]>(travelers, "group_travelers"),
    payments: must<Row[]>(payments, "group_payments"), travel: must<Row[]>(travel, "group_travel"), checklist: must<Row[]>(checklist, "group_checklist"),
    signatures: must<Row[]>(sigs, "group_signatures"), messages: must<Row[]>(messages, "group_messages"),
  };
}

/** The group's change notices, newest first (the group-level rows; the per-traveler emails are separate rows). */
export async function loadNotices(groupId: string, limit = 5): Promise<Row[]> {
  const r = await db().from("group_messages").select("id, created_at, sent_at, meta").eq("group_id", groupId).eq("template", "change-notice").is("traveler_id", null).order("created_at", { ascending: false }).limit(limit);
  if (r.error) { logger.warn({ err: r.error.message }, "group journey: the change notices could not be read"); return []; }
  return r.data ?? [];
}

export async function loadVideos(): Promise<ScanVideo[]> {
  const scan = await readJson<{ videos?: ScanVideo[] }>(PATHS.youtubeChannel, { videos: [] });
  return Array.isArray(scan.videos) ? scan.videos : [];
}

/** The ship's published Conga Line row and its hull record, found by the slug on the file or by the ship's name. Never writes the slug back. */
export async function loadShip(group: Row): Promise<{ rating: Row | null; shipInfo: Row | null }> {
  let slug: string | null = group.ship_slug ?? null;
  if (!slug && group.ship_name) slug = shipSlugCandidate(group.ship_name) || null;
  if (!slug) return { rating: null, shipInfo: null };
  const [hull, rating] = await Promise.all([
    db().from("cabin_ships").select("slug, ship, line, class").eq("slug", slug).maybeSingle(),
    db().from("conga_line_ratings").select("*").eq("ship_slug", slug).maybeSingle(),
  ]);
  return { shipInfo: hull.data ?? null, rating: rating.data ?? null };
}

/** An active storm that lists this ship (read-only: a pinned ship on a live, public storm alert). */
export async function loadStorm(shipName: string): Promise<StormNote | null> {
  const name = (shipName ?? "").trim();
  if (!name) return null;
  const pins = await db().from("storm_tracked_ships").select("alert_id").ilike("ship_name", likeEscape(name)).limit(20);
  if (pins.error || !pins.data?.length) return null;
  const alerts = await db().from("storm_alerts").select("id, name, classification, headline, status, ended_at").in("id", pins.data.map((p: Row) => p.alert_id)).in("status", ["approved", "sent"]).is("ended_at", null).order("last_updated", { ascending: false }).limit(1);
  const a = alerts.data?.[0];
  return a ? { name: a.name ?? null, classification: a.classification ?? null, headline: a.headline ?? null } : null;
}

/** Forecasts for the stops inside the ten-day horizon. A place whose forecast fails is left out (its row is not shown), never faked. */
export async function loadWeather(group: Row, clock: Clock): Promise<Extras["weather"]> {
  const stops = stopsInHorizon(group, clock.simToday);
  if (!stops.length) return null;
  const places: Record<string, ForecastDay[]> = {};
  for (const s of stops) {
    if (places[s.key]) continue;
    try {
      const f = await fetchForecast({ slug: s.slug, name: s.name, type: "destination", lat: s.lat, lon: s.lon });
      places[s.key] = f.forecast.map((d) => ({ day: d.day, high: d.high, low: d.low, code: d.weatherCode }));
    } catch (err) {
      logger.warn({ err: (err as Error).message, place: s.slug }, "group journey: a forecast could not be fetched; that place is left out of the table");
    }
  }
  const shift = dayDiff(clock.realToday, clock.simToday);
  return { places, shiftDays: shift, sample: shift !== 0 };
}

export function normalizeDefaults(raw: unknown): JourneyDefaults {
  const r = (raw && typeof raw === "object" ? raw : {}) as Row;
  return { approved: r["approved"] && typeof r["approved"] === "object" ? r["approved"] : {}, ...(Array.isArray(r["videoSources"]) ? { videoSources: r["videoSources"].filter((v: unknown): v is string => typeof v === "string") } : {}) };
}

export function supabaseJourneyStore(): JourneyStore {
  return {
    async activeGroupIds(today) {
      const r = await db().from("groups").select("id").in("status", [...ACTIVE_GROUP_STATUSES]).gte("sail_date", today).order("sail_date", { ascending: true });
      return must<Row[]>(r, "groups").map((x) => x.id as string);
    },
    load: (groupId) => loadJourneyInput(groupId),
    async defaults() { return normalizeDefaults(await readJson<unknown>(DEFAULTS_KEY, { approved: {} })); },
    async saveDefaults(d) { await writeJson(DEFAULTS_KEY, d); },
    async extras(input, needs: Needs, clock) {
      const e: Extras = {};
      if (needs.videos) e.videos = await loadVideos();
      if (needs.rating) Object.assign(e, await loadShip(input.group));
      if (needs.weather) e.weather = await loadWeather(input.group, clock);
      if (needs.storm) e.storm = await loadStorm(String(input.group.ship_name ?? ""));
      if (needs.notices) e.notices = await loadNotices(input.group.id);
      return e;
    },
    async claim(row) {
      const r = await db().from("group_messages").insert(row).select("id").single();
      if (r.error) {
        if (r.error.code === "23505") return "exists";
        throw new Error(`group_messages: ${r.error.message}`);
      }
      return { id: r.data.id as string };
    },
    async retake(id, meta) {
      const r = await db().from("group_messages").update({ status: "queued", meta, error: null, updated_at: new Date().toISOString() }).eq("id", id).in("status", ["failed", "queued"]).select("id");
      if (r.error) throw new Error(`group_messages: ${r.error.message}`);
      return (r.data?.length ?? 0) > 0;
    },
    async finish(id, patch) {
      const r = await db().from("group_messages").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
      if (r.error) throw new Error(`group_messages: ${r.error.message}`);
    },
    async setHubHash(travelerId, hash) {
      const r = await db().from("group_travelers").update({ hub_token_hash: hash }).eq("id", travelerId);
      if (r.error) throw new Error(`group_travelers: ${r.error.message}`);
    },
    async saveJourney(groupId, journey) {
      const r = await db().from("groups").update({ journey, updated_at: new Date().toISOString() }).eq("id", groupId);
      if (r.error) throw new Error(`groups: ${r.error.message}`);
    },
    async removeSim(groupId, travelerId) {
      let q = db().from("group_messages").delete().eq("group_id", groupId).like("dedupe_key", "sim:%");
      if (travelerId) q = q.eq("traveler_id", travelerId);
      const r = await q.select("id");
      if (r.error) throw new Error(`group_messages: ${r.error.message}`);
      return r.data?.length ?? 0;
    },
  };
}
