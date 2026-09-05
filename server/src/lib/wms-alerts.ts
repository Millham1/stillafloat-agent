// wms-alerts.ts — the Where's-My-Ship watch/alert service.
//
// Subscribers save a (ship, sailing dates) watch from the WMS page. An hourly
// sweep checks each active watch for three event kinds and emails the watcher
// (via the ops-manager Gmail sender):
//   1. course change — a REAL one: a mid-leg re-route, a port the ship never
//      calls at, or a swapped port order, judged by the same classifier the
//      storm feature uses (storm-diversion.ts, Mark 2026-09-05). Scheduled port
//      rotation is recorded on the watch (itinerary_flags) but never emailed —
//      the old "any destination change" rule would have mailed every port day.
//      When Mark PUBLISHES a storm course change, watchers of that ship are
//      emailed too, with the operator/news intel (emailWatchersForShip).
//   2. weather threat — severe forecast at the declared destination port, or an
//      approved storm alert whose grounds overlap the ship's position/destination
//   3. cruise-line news — an approved story mentioning the ship's line
// Alerts auto-send (Mark's call 2026-07-12): templates are fixed, events are
// per-subscriber and time-critical, and everything is deduped via a hash list
// on the watch row so a given event emails at most once.
//
// Free during the launch window: any confirmed subscriber can hold watches;
// subscribers.tier exists so the premium gate later is a flag-flip.

import crypto from "node:crypto";
import { getSupabase, readJson, PATHS } from "./persistence";
import { logger } from "./logger";
import { sendMail } from "./mailer";
import { getPosition, trackerObservedSince, type ShipPosition } from "./ship-tracker";
import { portBySlug } from "./ports";
import { classifyDestinationChange, EVENT_KINDS, kindLabel, type ChangeKind } from "./storm-diversion";
import { groundsForPoint, labelGrounds } from "./storm-grounds";
import { storySlug, type NewsStory } from "./prerender-news";

const SEVERE_WEATHER_CODES = new Set([82, 95, 96, 99]); // violent showers + thunderstorms
const MAX_ALERT_HASHES = 60;

export interface ShipWatch {
  id: string;
  subscriber_id: string;
  ship_name: string;
  sailing_start: string;
  sailing_end: string;
  status: string;
  last_destination: string | null;
  last_destination_at: string | null;
  itinerary_flags: { at: string; from: string | null; to: string; raw: string | null; kind?: string; reason?: string }[];
  alerted: string[];
  subscribers?: { email: string; name: string; lang: string; status: string } | null;
}

// ── Stop-watch link signing (same HMAC pattern as unsubscribe) ───────────────
export function makeWatchSig(watchId: string): string {
  const secret = process.env["UNSUBSCRIBE_SECRET"] || "still-afloat-unsub-v1";
  return crypto.createHmac("sha256", secret).update(`watch:${watchId}`).digest("hex").slice(0, 24);
}

function eventHash(kind: string, key: string): string {
  return crypto.createHash("sha1").update(`${kind}|${key}`).digest("hex").slice(0, 16);
}

// ── Event checks ─────────────────────────────────────────────────────────────

interface WatchEvent { kind: "itinerary" | "weather" | "news"; hash: string; title: string; body: string }

/** Subscriber-facing wording for a REAL course change. Pure; tested. */
export function buildWatchItineraryEvent(
  shipName: string, kind: ChangeKind, change: { from: string; to: string }, watchId: string, nowIso: string,
): WatchEvent {
  const fromName = portBySlug(change.from)?.name ?? change.from;
  const toName = portBySlug(change.to)?.name ?? change.to;
  return {
    kind: "itinerary",
    hash: eventHash("itin", `${watchId}|${change.from}->${change.to}|${nowIso.slice(0, 10)}`),
    title: `⚓ ${shipName} ${kindLabel(kind)} — now headed to ${toName}`,
    body: `${shipName} was headed to ${fromName} and now declares ${toName}. ` +
      `Course changes like this are usually operational or weather-related — ` +
      `check your cruise line's app or advisories for the official word.`,
  };
}

interface ItineraryCheck {
  event: WatchEvent | null;
  newBaseline: string | null;
  newBaselineAt: string | null;
  kind: ChangeKind | null;
  reason: string | null;
}

function checkItinerary(watch: ShipWatch, pos: ShipPosition): ItineraryCheck {
  const now = new Date().toISOString();
  const v = classifyDestinationChange({
    baseline: watch.last_destination,
    baselineDeclaredAt: watch.last_destination_at,
    current: pos.destinationSlug,
    now,
    inPortSlug: pos.inPortSlug,
    lastPortSlug: pos.lastPortSlug,
    lastPortDepartedAt: pos.lastPortDepartedAt,
    lastPosAt: pos.lastPosAt,
    portCalls: pos.portCalls ?? [],
    knownExtra: [],
    observedSince: trackerObservedSince(),
  });
  const base = {
    newBaseline: v.newBaseline, newBaselineAt: v.newBaselineDeclaredAt,
    kind: v.change ? v.kind : null, reason: v.change ? v.reason : null,
  };
  if (!v.change || !EVENT_KINDS.has(v.kind)) return { event: null, ...base };
  return { event: buildWatchItineraryEvent(pos.name, v.kind, v.change, watch.id, now), ...base };
}

async function checkWeather(watch: ShipWatch, pos: ShipPosition): Promise<WatchEvent[]> {
  const events: WatchEvent[] = [];

  // Severe forecast at the declared destination (next 3 days).
  if (pos.destinationSlug) {
    const port = portBySlug(pos.destinationSlug);
    if (port) {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${port.lat}&longitude=${port.lon}` +
          `&daily=weather_code&forecast_days=3&timezone=auto`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = await res.json() as { daily?: { time: string[]; weather_code: number[] } };
          const codes = data.daily?.weather_code ?? [];
          const days = data.daily?.time ?? [];
          for (let i = 0; i < codes.length; i++) {
            if (SEVERE_WEATHER_CODES.has(codes[i])) {
              events.push({
                kind: "weather",
                hash: eventHash("wx", `${watch.id}|${port.slug}|${days[i]}`),
                title: `Weather heads-up for ${port.name}`,
                body: `Severe weather (thunderstorms) is in the forecast for ${port.name} on ${days[i]}, ` +
                  `where ${pos.name} is headed. Port days can shuffle when weather rolls through — ` +
                  `pack the rain plan and watch for onboard schedule updates.`,
              });
              break; // one weather alert per destination is enough
            }
          }
        }
      } catch { /* forecast unavailable — skip quietly */ }
    }
  }

  // Approved storm alerts whose grounds overlap the ship's position/destination.
  try {
    const grounds = new Set<string>();
    if (pos.lat !== null && pos.lon !== null) for (const g of groundsForPoint(pos.lat, pos.lon)) grounds.add(g);
    if (pos.destinationSlug) {
      const p = portBySlug(pos.destinationSlug);
      if (p) for (const g of groundsForPoint(p.lat, p.lon)) grounds.add(g);
    }
    if (grounds.size) {
      const supabase = getSupabase();
      const { data } = await supabase
        .from("storm_alerts")
        .select("id, name, classification, headline, affected_grounds")
        .eq("is_threat", true)
        .not("approved_at", "is", null)
        .gte("last_updated", new Date(Date.now() - 5 * 86_400_000).toISOString())
        .overlaps("affected_grounds", [...grounds]);
      for (const alert of (data ?? []) as { id: string; name: string | null; classification: string | null; headline: string | null; affected_grounds: string[] }[]) {
        events.push({
          kind: "weather",
          hash: eventHash("storm", `${watch.id}|${alert.id}`),
          title: `Storm watch: ${alert.classification ?? "Tropical system"} ${alert.name ?? ""}`.trim(),
          body: `${alert.headline ?? "A tropical system is being monitored in your ship's cruising area."} ` +
            `Affected grounds: ${labelGrounds(alert.affected_grounds)}. ` +
            `Full details on our Cruise Storm Watch: https://stillafloatcruising.com/`,
        });
      }
    }
  } catch (err) {
    logger.warn({ err }, "wms-alerts: storm check failed");
  }

  return events;
}

async function checkNews(watch: ShipWatch, pos: ShipPosition): Promise<WatchEvent[]> {
  const events: WatchEvent[] = [];
  try {
    const approved = await readJson<{ stories?: NewsStory[] }>(PATHS.approved, { stories: [] });
    const line = pos.cruiseLine.toLowerCase();
    const ship = pos.name.toLowerCase();
    for (const story of approved.stories ?? []) {
      const text = `${story.title ?? ""} ${story.summary ?? ""}`.toLowerCase();
      if (!text.includes(line) && !text.includes(ship)) continue;
      // Only recent stories: prefer an explicit date field, else skip (the
      // approved pool holds weeks of stories — old ones aren't alerts).
      const dateRaw = (story as Record<string, unknown>)["approvedAt"] ??
        (story as Record<string, unknown>)["publishedAt"] ??
        (story as Record<string, unknown>)["date"];
      const ts = Date.parse(String(dateRaw ?? ""));
      if (!Number.isFinite(ts) || Date.now() - ts > 48 * 3_600_000) continue;
      events.push({
        kind: "news",
        hash: eventHash("news", `${watch.id}|${story.id}`),
        title: `${pos.cruiseLine} news: ${story.title ?? "New story"}`,
        body: `${story.summary ?? ""}\n\nRead it on Still Afloat: https://stillafloatcruising.com/news/${storySlug(story)}.html`,
      });
    }
  } catch (err) {
    logger.warn({ err }, "wms-alerts: news check failed");
  }
  return events;
}

// ── Email ────────────────────────────────────────────────────────────────────

function renderAlertEmail(
  watcherName: string, ship: string, events: WatchEvent[], stopUrl: string, lang: string,
): { subject: string; html: string } {
  const es = lang === "es";
  const firstName = watcherName.split(" ")[0] || watcherName;
  const T = es
    ? {
        kicker: "Vigilancia de barco — Still Afloat",
        hi: `Hola ${firstName},`,
        intro: `Novedades sobre <strong>${ship}</strong>, el crucero que estás siguiendo:`,
        cta: "Ver el barco en vivo →",
        stop: "Dejar de seguir este crucero",
        tag: "Navega más inteligente. Ríe más.",
      }
    : {
        kicker: "Ship Watch — Still Afloat",
        hi: `Hey ${firstName},`,
        intro: `An update on <strong>${ship}</strong>, the sailing you're tracking:`,
        cta: "See the ship live →",
        stop: "Stop tracking this sailing",
        tag: "Cruise smarter. Laugh more. Stay Afloat.",
      };
  const subject = events.length === 1
    ? events[0].title
    : (es ? `${events.length} novedades de ${ship}` : `${events.length} updates on ${ship}`);

  const items = events.map((e) => `
    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:18px 20px;margin-bottom:14px;background:#fff;">
      <h2 style="margin:0 0 8px;font-size:16px;color:#0c2035;line-height:1.4;font-weight:800;">${e.title}</h2>
      <p style="margin:0;color:#374151;font-size:14px;line-height:1.7;white-space:pre-line;">${e.body}</p>
    </div>`).join("");

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f0f4f8;padding:0;margin:0;">
  <div style="max-width:600px;margin:32px auto;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);">
    <div style="background:linear-gradient(135deg,#07183f,#0077b6);padding:28px 32px;text-align:center;">
      <p style="margin:0 0 6px;color:rgba(255,255,255,.6);font-size:12px;letter-spacing:.10em;text-transform:uppercase;">${T.kicker}</p>
      <h1 style="margin:0;color:#5dff9a;font-size:22px;font-weight:900;">${ship}</h1>
    </div>
    <div style="background:#f9fafb;padding:26px 32px;">
      <p style="margin:0 0 8px;color:#1e3a5f;font-size:15px;">${T.hi}</p>
      <p style="margin:0 0 20px;color:#374151;font-size:14px;">${T.intro}</p>
      ${items}
      <div style="text-align:center;margin-top:24px;">
        <a href="https://stillafloatcruising.com/${es ? "es/" : ""}wheres-my-ship.html"
           style="display:inline-block;background:linear-gradient(135deg,#0077b6,#07183f);color:#5dff9a;padding:13px 26px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;">${T.cta}</a>
      </div>
    </div>
    <div style="background:#fff;padding:16px 32px;border-top:1px solid #e5e7eb;text-align:center;">
      <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.7;">
        Still Afloat · <em>${T.tag}</em><br>
        <a href="${stopUrl}" style="color:#9ca3af;font-size:11px;">${T.stop}</a>
      </p>
    </div>
  </div>
</body>
</html>`;
  return { subject, html };
}

// ── The sweep ────────────────────────────────────────────────────────────────

export async function runWatchSweep(): Promise<{ checked: number; emailed: number }> {
  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);

  // End watches whose sailing has passed.
  await (supabase.from("ship_watches") as ReturnType<typeof supabase.from>)
    .update({ status: "ended", updated_at: new Date().toISOString() })
    .eq("status", "active")
    .lt("sailing_end", today);

  // Active watches in (or within 5 days of) their sailing window.
  const { data, error } = await supabase
    .from("ship_watches")
    .select("id, subscriber_id, ship_name, sailing_start, sailing_end, status, last_destination, last_destination_at, itinerary_flags, alerted, subscribers ( email, name, lang, status )")
    .eq("status", "active")
    .lte("sailing_start", soon)
    .gte("sailing_end", today);
  if (error) { logger.error({ err: error }, "wms-alerts: watch query failed"); return { checked: 0, emailed: 0 }; }

  let emailed = 0;
  const watches = (data ?? []) as unknown as ShipWatch[];
  for (const watch of watches) {
    const sub = watch.subscribers;
    if (!sub || sub.status !== "confirmed") continue;
    const pos = getPosition(watch.ship_name);
    if (!pos || pos.lat === null) continue; // nothing observed yet

    const { event: itinEvent, newBaseline, newBaselineAt, kind: itinKind, reason: itinReason } = checkItinerary(watch, pos);
    const events = [
      ...(itinEvent ? [itinEvent] : []),
      ...(await checkWeather(watch, pos)),
      ...(await checkNews(watch, pos)),
    ];

    const alreadySent = new Set(watch.alerted ?? []);
    const fresh = events.filter((e) => !alreadySent.has(e.hash));

    // Every destination change is recorded (audit); only REAL ones become events.
    const changed = itinKind !== null && newBaseline !== null && newBaseline !== watch.last_destination;
    const flags = changed
      ? [...(watch.itinerary_flags ?? []), {
          at: new Date().toISOString(), from: watch.last_destination, to: newBaseline, raw: pos.destinationRaw,
          kind: itinKind ?? undefined, reason: itinReason ?? undefined,
        }].slice(-MAX_ALERT_HASHES)
      : watch.itinerary_flags;

    if (fresh.length) {
      const stopUrl = `https://stillafloatcruising.com/api/wms/watch/stop?id=${watch.id}&sig=${makeWatchSig(watch.id)}`;
      const { subject, html } = renderAlertEmail(sub.name, watch.ship_name, fresh, stopUrl, sub.lang ?? "en");
      const ok = await sendMail({ to: sub.email, subject, html, fromName: "Still Afloat Ship Watch" });
      if (ok) {
        emailed++;
        for (const e of fresh) alreadySent.add(e.hash);
      } else {
        logger.warn({ watch: watch.id }, "wms-alerts: email failed — will retry next sweep");
      }
      await new Promise((r) => setTimeout(r, 1200)); // pace the Gmail API
    }

    // Persist baseline/flags/dedup even when nothing was emailed (baseline set).
    if (fresh.length || newBaseline !== watch.last_destination || newBaselineAt !== watch.last_destination_at || changed) {
      const { error: upErr } = await (supabase.from("ship_watches") as ReturnType<typeof supabase.from>)
        .update({
          last_destination: newBaseline,
          last_destination_at: newBaselineAt,
          itinerary_flags: flags,
          alerted: [...alreadySent].slice(-MAX_ALERT_HASHES),
          updated_at: new Date().toISOString(),
        })
        .eq("id", watch.id);
      if (upErr) logger.warn({ err: upErr, watch: watch.id }, "wms-alerts: watch update failed");
    }
  }

  if (watches.length) logger.info({ checked: watches.length, emailed }, "wms-alerts: sweep complete");
  return { checked: watches.length, emailed };
}

// ── Publish → watchers ───────────────────────────────────────────────────────

export interface WatcherNotice { key: string; title: string; body: string }

/**
 * Email everyone actively watching `shipName` (confirmed subscribers, sailing
 * within the sweep's window) about a course change Mark PUBLISHED on a storm
 * alert. Deduped per watch on `key`; respects DISABLE_WMS_ALERTS (dev mirror).
 */
export async function emailWatchersForShip(shipName: string, notice: WatcherNotice): Promise<{ watches: number; emailed: number }> {
  if (process.env["DISABLE_WMS_ALERTS"] === "1") return { watches: 0, emailed: 0 };
  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("ship_watches")
    .select("id, subscriber_id, ship_name, sailing_start, sailing_end, status, last_destination, last_destination_at, itinerary_flags, alerted, subscribers ( email, name, lang, status )")
    .eq("status", "active")
    .ilike("ship_name", shipName)
    .lte("sailing_start", soon)
    .gte("sailing_end", today);
  if (error) { logger.warn({ err: error, ship: shipName }, "wms-alerts: watcher lookup failed"); return { watches: 0, emailed: 0 }; }
  const watches = (data ?? []) as unknown as ShipWatch[];
  let emailed = 0;
  for (const watch of watches) {
    const sub = watch.subscribers;
    if (!sub || sub.status !== "confirmed") continue;
    const hash = eventHash("publish", `${watch.id}|${notice.key}`);
    const alreadySent = new Set(watch.alerted ?? []);
    if (alreadySent.has(hash)) continue;
    const stopUrl = `https://stillafloatcruising.com/api/wms/watch/stop?id=${watch.id}&sig=${makeWatchSig(watch.id)}`;
    const { subject, html } = renderAlertEmail(
      sub.name, watch.ship_name, [{ kind: "itinerary", hash, title: notice.title, body: notice.body }], stopUrl, sub.lang ?? "en",
    );
    const ok = await sendMail({ to: sub.email, subject, html, fromName: "Still Afloat Ship Watch" });
    if (!ok) { logger.warn({ watch: watch.id }, "wms-alerts: publish email failed"); continue; }
    emailed++;
    alreadySent.add(hash);
    await (supabase.from("ship_watches") as ReturnType<typeof supabase.from>)
      .update({ alerted: [...alreadySent].slice(-MAX_ALERT_HASHES), updated_at: new Date().toISOString() })
      .eq("id", watch.id);
    await new Promise((r) => setTimeout(r, 1200)); // pace the Gmail API
  }
  if (watches.length) logger.info({ ship: shipName, watches: watches.length, emailed }, "wms-alerts: publish notice sent");
  return { watches: watches.length, emailed };
}
