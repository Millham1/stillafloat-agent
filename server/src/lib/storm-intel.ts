// storm-intel.ts — cruise-line + news intelligence for live named storms
// (Mark's lifecycle design 2026-07-22).
//
// For every live NAMED storm alert (TS and up), periodically check:
//   • official cruise-line advisory pages (config below — several lines block
//     datacenter IPs, so each source degrades gracefully and its health is
//     recorded in intel_state; Royal Caribbean is verified reachable, the rest
//     are attempted every pass in case they unblock);
//   • Cruise Hive + Cruise Radio RSS (the reliable backbone — line advisories
//     hit these within hours);
//   • GNews search on the storm's name (GNEWS_API_KEY from the shared env).
//
// New findings are appended to the alert's cruise_line_info — the same
// advisories card Mark edits in the dashboard and the public detail page
// renders — and Mark gets ONE pending action per alert nudging him to look.
// Dedup is content-hash based and stored in storm_alerts.intel_state, so
// Mark's manual edits to the card are never fought over.

import * as crypto from "node:crypto";
import { getSupabase } from "./persistence";
import { logger } from "./logger";
import { createAction } from "./actions";
import { severityRank } from "./storm-escalation";

const INTEL_EVERY_MS = 110 * 60 * 1000; // ~2h per alert; GNews stays well under free-tier limits
const NEWS_MAX_AGE_MS = 72 * 3_600_000;
const MAX_CARD_ENTRIES = 30;
const MAX_SEEN_HASHES = 120;

// Browser-profile UA: these are public advisory pages; several block obvious
// bot UAs even for benign readers.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const OFFICIAL_SOURCES: Array<{ key: string; line: string; url: string }> = [
  { key: "rci", line: "Royal Caribbean", url: "https://www.royalcaribbean.com/cruise-ships/itinerary-updates" },
  { key: "carnival", line: "Carnival", url: "https://help.carnival.com/app/answers/category/c/241" },
  { key: "ncl", line: "Norwegian", url: "https://www.ncl.com/travel-alert" },
  { key: "msc", line: "MSC Cruises", url: "https://www.msccruisesusa.com/service/travel-alerts" },
  { key: "princess", line: "Princess", url: "https://www.princess.com/en-us/plan/travel-advisories" },
  { key: "hal", line: "Holland America", url: "https://www.hollandamerica.com/en/us/plan-a-cruise/already-booked/travel-advisories" },
];

const NEWS_FEEDS: Array<{ key: string; label: string; url: string }> = [
  { key: "cruisehive", label: "Cruise Hive", url: "https://www.cruisehive.com/feed" },
  { key: "cruiseradio", label: "Cruise Radio", url: "https://cruiseradio.net/feed/" },
];

// ── Small pure helpers (exported for tests) ──────────────────────────────────

export interface IntelEntry { line: string; note: string; url: string }

export function intelHash(parts: string[]): string {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A window of page text around the first mention of `needle` (null = absent). */
export function extractWindow(text: string, needle: string, radius = 700): string | null {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return null;
  return text.slice(Math.max(0, idx - radius), idx + needle.length + radius).trim();
}

export interface RssItem { title: string; link: string; description: string; pubDate: string }

export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const chunk of xml.split(/<item[\s>]/i).slice(1)) {
    const pick = (tag: string): string => {
      const m = chunk.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      return m ? stripHtml(m[1]) : "";
    };
    const title = pick("title");
    if (!title) continue;
    items.push({ title, link: pick("link"), description: pick("description").slice(0, 500), pubDate: pick("pubDate") });
  }
  return items;
}

/** Does this news item cover the given named storm? */
export function newsItemMatchesStorm(item: { title: string; description: string }, stormName: string): boolean {
  const text = `${item.title} ${item.description}`.toLowerCase();
  if (!text.includes(stormName.toLowerCase())) return false;
  return /\b(hurricane|tropical storm|tropical depression|storm|cruise|itinerar)/i.test(text);
}

/** Does this item name the SHIP in a storm / itinerary context? (Mark 2026-09-05:
 *  operators and the press announce itinerary changes by ship, often without
 *  naming the storm.) */
export function newsItemMatchesShip(item: { title: string; description: string }, shipName: string): boolean {
  const text = `${item.title} ${item.description}`.toLowerCase();
  if (!text.includes(shipName.toLowerCase())) return false;
  return /\b(hurricane|tropical|storm|itinerar|divert|re-?rout|skip|cancel|port|weather|advisor)/i.test(text);
}

// ── Fetching ─────────────────────────────────────────────────────────────────

async function fetchText(url: string, timeoutMs = 15_000): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml,*/*" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

async function summarizeAdvisory(line: string, storm: string, window: string): Promise<string> {
  const apiKey = process.env["OPENAI_API_KEY"];
  const fallback = window.slice(0, 220);
  if (!apiKey) return fallback;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: "Summarize the cruise line's storm advisory in ONE plain factual sentence (max 180 chars) for a cruise-news card. No hype, no advice, just what the line announced." },
          { role: "user", content: `Cruise line: ${line}\nStorm: ${storm}\nAdvisory page excerpt:\n${window}` },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return fallback;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = (await res.json()) as any;
    const note = String(payload?.choices?.[0]?.message?.content ?? "").trim();
    return note ? note.slice(0, 220) : fallback;
  } catch {
    return fallback;
  }
}

interface GnewsArticle { title: string; url: string; publishedAt: string; source?: { name?: string } }

async function fetchGnewsQuery(query: string): Promise<GnewsArticle[]> {
  const key = process.env["GNEWS_API_KEY"];
  if (!key) return [];
  const q = encodeURIComponent(query);
  const txt = await fetchText(`https://gnews.io/api/v4/search?q=${q}&lang=en&max=10&apikey=${key}`);
  if (!txt) return [];
  try {
    const parsed = JSON.parse(txt) as { articles?: GnewsArticle[] };
    return parsed.articles ?? [];
  } catch {
    return [];
  }
}

async function fetchGnews(stormName: string): Promise<GnewsArticle[]> {
  return fetchGnewsQuery(`"${stormName}" cruise`);
}

/** The RSS backbone (Cruise Hive + Cruise Radio), fresh items only. Shared by
 *  the intel pass and by course-change detection. */
export async function fetchNewsBackbone(): Promise<Array<RssItem & { label: string }>> {
  const newsItems: Array<RssItem & { label: string }> = [];
  for (const feed of NEWS_FEEDS) {
    const xml = await fetchText(feed.url);
    if (!xml) continue;
    for (const item of parseRssItems(xml)) {
      const ts = Date.parse(item.pubDate);
      if (Number.isFinite(ts) && Date.now() - ts > NEWS_MAX_AGE_MS) continue;
      newsItems.push({ ...item, label: feed.label });
    }
  }
  return newsItems;
}

/**
 * What the operator / the press has said about ONE ship, for a course-change
 * nudge: existing advisories on the affected alerts that name the ship, fresh
 * backbone news naming it, and a GNews search on the ship's name.
 */
export async function diversionIntel(
  shipName: string, cruiseLine: string | null, stormNames: string[], alertIds: string[],
): Promise<IntelEntry[]> {
  const out: IntelEntry[] = [];
  const seenKeys = new Set<string>();
  const push = (e: IntelEntry) => {
    const k = (e.url || e.note).toLowerCase();
    if (seenKeys.has(k)) return;
    seenKeys.add(k);
    out.push(e);
  };
  const ship = shipName.toLowerCase();

  if (alertIds.length) {
    const supabase = getSupabase();
    const { data } = await supabase.from("storm_alerts").select("cruise_line_info").in("id", alertIds);
    for (const a of (data ?? []) as Array<{ cruise_line_info?: IntelEntry[] | null }>) {
      for (const e of a.cruise_line_info ?? []) {
        if (`${e.line} ${e.note}`.toLowerCase().includes(ship)) push(e);
      }
    }
  }

  for (const item of await fetchNewsBackbone()) {
    if (newsItemMatchesShip(item, shipName)) push({ line: item.label, note: item.title.slice(0, 220), url: item.link });
  }

  const storm = stormNames[0];
  for (const art of await fetchGnewsQuery(storm ? `"${shipName}" ${storm}` : `"${shipName}" cruise`)) {
    const ts = Date.parse(art.publishedAt);
    if (Number.isFinite(ts) && Date.now() - ts > NEWS_MAX_AGE_MS) continue;
    if (!newsItemMatchesShip({ title: art.title, description: "" }, shipName)) continue;
    push({ line: art.source?.name || "News", note: art.title.slice(0, 220), url: art.url });
  }

  void cruiseLine; // line-level advisories already reach the card through the pass
  return out.slice(0, 5);
}

// ── The pass ─────────────────────────────────────────────────────────────────

interface IntelState {
  lastRunAt?: string;
  entries?: string[];
  sources?: Record<string, { ok: boolean; at: string }>;
}

interface IntelAlertRow {
  id: string;
  nhc_id: string;
  name: string | null;
  classification: string | null;
  intel_state: IntelState | null;
  cruise_line_info: IntelEntry[] | null;
}

function isDue(state: IntelState | null): boolean {
  const last = Date.parse(state?.lastRunAt ?? "");
  return !Number.isFinite(last) || Date.now() - last >= INTEL_EVERY_MS;
}

export async function runStormIntel(): Promise<{ alertsChecked: number; newEntries: number }> {
  const result = { alertsChecked: 0, newEntries: 0 };
  if (process.env["DISABLE_STORM_INTEL"] === "1") return result;
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("storm_alerts")
    .select("id, nhc_id, name, classification, intel_state, cruise_line_info")
    .in("status", ["draft", "approved", "sent"])
    .eq("is_threat", true);
  if (error) {
    logger.error({ err: error }, "storm-intel: alert load failed");
    return result;
  }

  // Named storms only (TS+): "Two"-style depression labels and outlook blobs
  // match far too much text to search against.
  const alerts = ((data ?? []) as unknown as IntelAlertRow[]).filter(
    (a) => severityRank(a.classification) >= 3 && a.name && !/unnamed|area\(s\)/i.test(a.name) && isDue(a.intel_state),
  );
  if (!alerts.length) return result;

  // Shared fetches — once per pass, not per storm.
  const officialPages = new Map<string, string | null>();
  for (const src of OFFICIAL_SOURCES) {
    const html = await fetchText(src.url);
    officialPages.set(src.key, html ? stripHtml(html) : null);
  }
  const newsItems = await fetchNewsBackbone();

  for (const alert of alerts) {
    try {
      result.alertsChecked++;
      const stormName = alert.name as string;
      const state: IntelState = alert.intel_state ?? {};
      const seen = new Set(state.entries ?? []);
      const sourcesHealth: Record<string, { ok: boolean; at: string }> = {};
      const fresh: Array<{ hash: string; entry: IntelEntry }> = [];

      // Official advisory pages.
      for (const src of OFFICIAL_SOURCES) {
        const text = officialPages.get(src.key) ?? null;
        sourcesHealth[src.key] = { ok: text !== null, at: new Date().toISOString() };
        if (!text) continue;
        const window = extractWindow(text, stormName);
        if (!window) continue;
        const hash = intelHash(["official", src.key, window]);
        if (seen.has(hash)) continue;
        const note = await summarizeAdvisory(src.line, stormName, window);
        fresh.push({ hash, entry: { line: src.line, note, url: src.url } });
      }

      // Pinned ships: operator pages + news that name the SHIP, even when they
      // don't name the storm (Mark 2026-09-05 — "scan the operators' sites and
      // news releases for itinerary changes related to storms").
      const { data: pinnedRows } = await supabase.from("storm_tracked_ships")
        .select("ship_name").eq("alert_id", alert.id).is("released_at", null);
      const pinned = [...new Set(((pinnedRows ?? []) as Array<{ ship_name: string }>).map((p) => p.ship_name))];
      for (const src of OFFICIAL_SOURCES) {
        const text = officialPages.get(src.key) ?? null;
        if (!text) continue;
        for (const shipName of pinned) {
          const window = extractWindow(text, shipName);
          if (!window) continue;
          const hash = intelHash(["official-ship", src.key, shipName, window]);
          if (seen.has(hash)) continue;
          seen.add(hash);
          const note = await summarizeAdvisory(src.line, `${stormName} (${shipName})`, window);
          fresh.push({ hash, entry: { line: `${src.line} — ${shipName}`, note, url: src.url } });
        }
      }
      for (const item of newsItems) {
        for (const shipName of pinned) {
          if (!newsItemMatchesShip(item, shipName)) continue;
          const hash = intelHash(["news", item.link || item.title]);
          if (seen.has(hash)) continue;
          seen.add(hash);
          fresh.push({ hash, entry: { line: item.label, note: `${shipName}: ${item.title}`.slice(0, 220), url: item.link } });
        }
      }

      // News backbone.
      for (const item of newsItems) {
        if (!newsItemMatchesStorm(item, stormName)) continue;
        const hash = intelHash(["news", item.link || item.title]);
        if (seen.has(hash)) continue;
        fresh.push({ hash, entry: { line: item.label, note: item.title.slice(0, 220), url: item.link } });
      }
      for (const art of await fetchGnews(stormName)) {
        const ts = Date.parse(art.publishedAt);
        if (Number.isFinite(ts) && Date.now() - ts > NEWS_MAX_AGE_MS) continue;
        const hash = intelHash(["news", art.url]);
        if (seen.has(hash)) continue;
        fresh.push({ hash, entry: { line: art.source?.name || "News", note: art.title.slice(0, 220), url: art.url } });
      }

      // Persist: append to the advisories card, remember the hashes.
      for (const f of fresh) seen.add(f.hash);
      const nextState: IntelState = {
        lastRunAt: new Date().toISOString(),
        entries: [...seen].slice(-MAX_SEEN_HASHES),
        sources: sourcesHealth,
      };
      const patch: Record<string, unknown> = { intel_state: nextState };
      if (fresh.length) {
        const card = [...(alert.cruise_line_info ?? []), ...fresh.map((f) => f.entry)].slice(-MAX_CARD_ENTRIES);
        patch["cruise_line_info"] = card;
        patch["last_updated"] = new Date().toISOString();
      }
      const { error: upErr } = await supabase.from("storm_alerts").update(patch).eq("id", alert.id);
      if (upErr) {
        logger.warn({ err: upErr, alert: alert.nhc_id }, "storm-intel: update failed");
        continue;
      }

      if (fresh.length) {
        result.newEntries += fresh.length;
        await createAction({
          type: "storm_alert",
          source_ref: alert.id,
          title: `🛰 New storm intel: ${stormName} (${fresh.length} item${fresh.length === 1 ? "" : "s"})`,
          body: fresh.slice(0, 5).map((f) => `• ${f.entry.line}: ${f.entry.note}`).join("\n") +
            "\nAppended to the alert's cruise-line advisories card — review/edit in the dashboard.",
          tag: `storm-intel-${alert.nhc_id}`,
        }).catch((err) => logger.warn({ err }, "storm-intel: action failed"));
        logger.info({ alert: alert.nhc_id, added: fresh.length }, "storm-intel: new intel appended");
      }
    } catch (err) {
      logger.error({ err, alert: alert.nhc_id }, "storm-intel: alert pass failed");
    }
  }

  return result;
}
