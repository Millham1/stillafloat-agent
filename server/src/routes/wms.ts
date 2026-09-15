// wms.ts — "Where's My Ship?" API.
//
// Funnel (Mark, 2026-07-12): the live position view is PUBLIC — a one-time
// peek is the hook. The sale is the ongoing watch service (itinerary changes,
// weather, cruise-line news by email), which requires a confirmed subscriber
// (free during the launch window; subscribers.tier is the future paywall
// flag). Positions come from the in-process AIS tracker (lib/ship-tracker.ts);
// watches are swept by lib/wms-alerts.ts.

import { Router, type IRouter, type Request, type Response } from "express";
import { getSupabase } from "../lib/persistence";
import { logger } from "../lib/logger";
import { sendMail } from "../lib/mailer";
import {
  getPosition, allPositions, trackerEnabled, trackerHealthy,
  requestShip, isSubscribed, inRegistry, subscribedNames, capacity,
} from "../lib/ship-tracker";
import { trackingEmail, verifyWatchSig, watchStopUrl } from "../lib/ship-watch";
import { portBySlug } from "../lib/ports";

const router: IRouter = Router();

// ── Rate limiting (same in-memory pattern as subscribe.ts) ───────────────────
const rateMap = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string, max = 30): boolean {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return false;
  }
  if (entry.count >= max) return true;
  entry.count++;
  return false;
}
function clientIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
    || req.socket?.remoteAddress || "unknown";
}

// ── Subscriber verification (10-min cache so polling doesn't hammer the DB) ──
interface SubInfo { id: string; name: string; lang: string; tier: string }
const subCache = new Map<string, { sub: SubInfo | null; expiresAt: number }>();

async function confirmedSubscriber(email: string): Promise<SubInfo | null> {
  const key = email.toLowerCase().trim();
  if (!key) return null;
  const cached = subCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.sub;
  const supabase = getSupabase();
  const { data } = await supabase
    .from("subscribers")
    .select("id, name, lang, tier, status")
    .eq("email", key)
    .eq("status", "confirmed")
    .maybeSingle();
  const sub = data
    ? { id: String(data.id), name: String(data.name), lang: String(data.lang ?? "en"), tier: String((data as { tier?: string }).tier ?? "free") }
    : null;
  subCache.set(key, { sub, expiresAt: Date.now() + 10 * 60 * 1000 });
  return sub;
}

// ── GET /api/wms/ships — the full searchable registry (public) ───────────────
// Every registry ship is searchable; `live` marks the ones in the current AIS
// subscription (everything else wakes on request). Short cache: liveness moves.
router.get("/wms/ships", async (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("ships")
      .select("name, cruise_line, mmsi")
      .eq("active", true)
      .order("cruise_line")
      .order("name");
    if (error) throw new Error(error.message);
    const live = subscribedNames();
    const ships = ((data ?? []) as { name: string; cruise_line: string; mmsi: string | null }[])
      .map((s) => ({
        name: s.name,
        cruiseLine: s.cruise_line,
        tracked: Boolean(s.mmsi),
        live: live.has(s.name.toLowerCase()),
      }));
    res.json({ ok: true, trackerOnline: trackerEnabled() && trackerHealthy(), capacity: capacity(), ships });
  } catch (err) {
    logger.error({ err }, "wms: ships list failed");
    res.status(500).json({ ok: false, error: "Could not load ships" });
  }
});

// ── POST /api/wms/request — wake tracking for a registry ship (public) ───────
// Stamps last_requested_at (retention) and pulls the ship into the active
// subscription immediately. Rate-limited: it's a public write-ish action.
router.post("/wms/request", async (req: Request, res: Response) => {
  if (rateLimited(clientIp(req), 20)) return res.status(429).json({ ok: false, error: "Too many requests" });
  const ship = String((req.body as Record<string, string>)?.ship ?? "").trim();
  if (!ship) return res.status(400).json({ ok: false, error: "ship required" });
  try {
    const state = await requestShip(ship);
    if (state === "unknown") return res.status(404).json({ ok: false, error: "Unknown ship" });
    return res.json({ ok: true, state }); // live | waking
  } catch (err) {
    logger.error({ err }, "wms: request failed");
    return res.status(500).json({ ok: false, error: "Request failed" });
  }
});

// ── GET /api/wms/position?ship= — the live view (public: the hook) ───────────
router.get("/wms/position", async (req: Request, res: Response) => {
  try {
    const shipName = String(req.query["ship"] ?? "").trim();
    if (!shipName) return res.status(400).json({ ok: false, error: "ship required" });

    if (!trackerEnabled()) {
      return res.json({ ok: true, tracking: false, reason: "tracker_offline" });
    }
    const pos = getPosition(shipName);
    if (!pos || pos.lat === null || !pos.lastPosAt) {
      // Distinguish "subscribed, just hasn't reported" from "not yet in the
      // active set" so the page can show the wake-up message vs the coverage one.
      const reason = !inRegistry(shipName) ? "unknown_ship"
        : isSubscribed(shipName) ? "no_signal" : "waking";
      return res.json({ ok: true, tracking: false, reason });
    }

    const ageMin = Math.round((Date.now() - Date.parse(pos.lastPosAt)) / 60000);
    const destination = pos.destinationSlug ? portBySlug(pos.destinationSlug) : null;
    const lastPort = pos.lastPortSlug ? portBySlug(pos.lastPortSlug) : null;
    return res.json({
      ok: true,
      tracking: true,
      ship: pos.name,
      cruiseLine: pos.cruiseLine,
      position: { lat: pos.lat, lon: pos.lon },
      courseDeg: pos.cogDeg,
      headingDeg: pos.headingDeg,
      speedKn: pos.sogKn,
      destination: destination
        ? { slug: destination.slug, name: destination.name, lat: destination.lat, lon: destination.lon }
        : null,
      destinationRaw: pos.destinationRaw,
      etaUtc: pos.etaUtc,
      departed: lastPort && pos.lastPortDepartedAt
        ? { port: lastPort.name, at: pos.lastPortDepartedAt }
        : null,
      lastReportedAt: pos.lastPosAt,
      lastReportedMinAgo: ageMin,
      stale: ageMin > 90, // out of terrestrial AIS coverage — page shows the caveat
    });
  } catch (err) {
    logger.error({ err }, "wms: position failed");
    return res.status(500).json({ ok: false, error: "Position lookup failed" });
  }
});

// ── POST /api/wms/watch — save a sailing + enroll in email updates ───────────
router.post("/wms/watch", async (req: Request, res: Response) => {
  try {
    if (rateLimited(clientIp(req), 10)) return res.status(429).json({ ok: false, error: "Too many attempts" });
    const { email, ship, sailingStart, sailingEnd } = req.body as Record<string, string>;
    const cleanEmail = String(email ?? "").trim().toLowerCase();
    const shipName = String(ship ?? "").trim();
    if (!cleanEmail || !shipName || !sailingStart || !sailingEnd) {
      return res.status(400).json({ ok: false, error: "email, ship, sailingStart, sailingEnd required" });
    }
    const start = Date.parse(sailingStart);
    const end = Date.parse(sailingEnd);
    const today = new Date(new Date().toISOString().slice(0, 10)).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      return res.status(400).json({ ok: false, error: "Invalid sailing dates" });
    }
    if (end < today) return res.status(400).json({ ok: false, error: "That sailing has already ended" });
    if (end - start > 40 * 86_400_000) return res.status(400).json({ ok: false, error: "Sailing window too long (40-day max)" });

    const sub = await confirmedSubscriber(cleanEmail);
    if (!sub) return res.status(403).json({ ok: false, error: "subscriber_required" });

    const supabase = getSupabase();
    // Ship must be one we curate (and ideally track).
    const { data: shipRow } = await supabase
      .from("ships").select("name, mmsi").eq("active", true).ilike("name", shipName).maybeSingle();
    if (!shipRow) return res.status(404).json({ ok: false, error: "Unknown ship" });

    // One active watch per subscriber+ship+start date.
    const { data: dupe } = await supabase
      .from("ship_watches")
      .select("id")
      .eq("subscriber_id", sub.id)
      .eq("ship_name", String(shipRow.name))
      .eq("sailing_start", sailingStart)
      .eq("status", "active")
      .maybeSingle();
    if (dupe) return res.json({ ok: true, already: true, watchId: String(dupe.id) });

    const { data: inserted, error: insErr } = await (supabase.from("ship_watches") as ReturnType<typeof supabase.from>)
      .insert({
        subscriber_id: sub.id,
        ship_name: String(shipRow.name),
        sailing_start: sailingStart,
        sailing_end: sailingEnd,
      })
      .select("id")
      .single();
    if (insErr || !inserted) {
      logger.error({ err: insErr }, "wms: watch insert failed");
      return res.status(500).json({ ok: false, error: "Could not save your watch" });
    }

    const watchId = String((inserted as { id: string }).id);
    const mail = trackingEmail({
      shipName: String(shipRow.name),
      sailingStart,
      sailingEnd,
      subscriberName: sub.name,
      lang: sub.lang,
      stopUrl: watchStopUrl(watchId),
    });
    await sendMail({ to: cleanEmail, subject: mail.subject, fromName: "Still Afloat Ship Watch", html: mail.html });

    logger.info({ ship: shipRow.name, watchId }, "wms: watch saved");
    return res.json({ ok: true, watchId, tracked: Boolean(shipRow.mmsi) });
  } catch (err) {
    logger.error({ err }, "wms: watch save failed");
    return res.status(500).json({ ok: false, error: "An unexpected error occurred" });
  }
});

// ── GET /api/wms/watch/stop?id=&sig= — one-click stop from any email ─────────
router.get("/wms/watch/stop", async (req: Request, res: Response) => {
  const { id, sig } = req.query as Record<string, string>;
  if (!id || !verifyWatchSig(id, "stop", sig)) {
    return res.redirect("/wheres-my-ship.html?watch=invalid");
  }
  try {
    const supabase = getSupabase();
    await (supabase.from("ship_watches") as ReturnType<typeof supabase.from>)
      .update({ status: "stopped", updated_at: new Date().toISOString() })
      .eq("id", id);
    return res.redirect("/wheres-my-ship.html?watch=stopped");
  } catch (err) {
    logger.error({ err }, "wms: watch stop failed");
    return res.redirect("/wheres-my-ship.html?watch=error");
  }
});

// Debug/ops: current cache freshness across all tracked ships (no positions).
router.get("/wms/health", (_req: Request, res: Response) => {
  const ships = allPositions().map((p) => ({
    name: p.name,
    hasFix: p.lat !== null,
    lastPosAt: p.lastPosAt,
    destination: p.destinationSlug,
  }));
  res.json({ ok: true, enabled: trackerEnabled(), healthy: trackerHealthy(), ships });
});

export default router;
