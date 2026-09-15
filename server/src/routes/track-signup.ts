// routes/track-signup.ts — the storm pages' "Track this ship": subscribe and start a 15-day
// ship watch in one step, and restart one when it ends.
//
// Mark, 2026-09-15, on the storm pages' "Track this ship" buttons: "the CTA is still too
// deep. the track my ship still only opens the tracker page, i like the placement, but it
// should be a direct link to sign up to the tracker with subscription." The tracker's own
// form turns away anyone who is not already a confirmed subscriber and sends them off to
// subscribe first. Here a confirmed subscriber is tracking at once; anyone else gets one
// confirmation email, and confirming it switches the watch on (subscribe.ts verify-email).
//
// Then: "A storm tracker is only good for the duration of the storm. I think we can remove
// the start and end dates, but need to give the user an option in the email to stop
// tracking, maybe set a 15 day cap then restart." So there are no dates to enter: the watch
// runs 15 days (ship-watch.ts), and the "keep tracking?" email at the end links back to the
// sign-up page, whose button calls POST /api/wms/watch/restart.
//
// Dependencies are injected (same pattern as go.ts) so the tests never touch Supabase or email.

import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "node:crypto";
import { getSupabase } from "../lib/persistence";
import { logger } from "../lib/logger";
import { sendMail } from "../lib/mailer";
import { sendVerificationEmail } from "./subscribe";
import {
  makeWatchSig, rollingWindow, signupPath, trackingEmail, watchStopUrl, WATCH_WINDOW_DAYS, type WatchWindow,
} from "../lib/ship-watch";

export interface SubscriberRow {
  id: string;
  name: string;
  lang: string | null;
  status: string;
  token: string | null;
}

export interface OpenWatch {
  id: string;
  status: string;
  sailing_end: string;
}

export interface RestartableWatch {
  id: string;
  subscriber_id: string;
  ship_name: string;
  window_days: number | null;
  subscriber_status: string | null;
}

export interface TrackSignupDeps {
  findSubscriber(email: string): Promise<SubscriberRow | null>;
  createSubscriber(row: { email: string; name: string; lang: "en" | "es"; token: string }): Promise<{ id: string }>;
  /** Back to pending with a fresh confirmation token (after unsubscribing, or a pending row with no token). */
  reopenSubscriber(id: string, patch: { name: string; lang: "en" | "es"; token: string }): Promise<void>;
  findShip(name: string): Promise<{ name: string } | null>;
  /** A pending or active watch for the same subscriber and ship whose window includes today, active first. */
  findOpenWatch(subscriberId: string, shipName: string, today: string): Promise<OpenWatch | null>;
  /** The watch a restart link names. */
  findWatch(id: string): Promise<RestartableWatch | null>;
  createWatch(row: {
    subscriber_id: string; ship_name: string; sailing_start: string; sailing_end: string;
    window_days: number; status: "active" | "pending"; source: string;
  }): Promise<{ id: string }>;
  /** Switch a watch on for a fresh window: starting a pending one, or restarting one that ended. */
  activateWatch(id: string, window: WatchWindow): Promise<void>;
  sendVerification(args: { name: string; email: string; token: string; lang: "en" | "es"; shipName: string }): Promise<void>;
  sendTracking(args: { to: string; subject: string; html: string }): Promise<void>;
  today(): string;
  newToken(): string;
  rateLimited(ip: string): boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SOURCE_RE = /^[a-z-]{1,24}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clientIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
}

export function createTrackSignupRouter(deps: TrackSignupDeps = defaultTrackSignupDeps): IRouter {
  const router: IRouter = Router();

  router.post("/wms/track-signup", async (req: Request, res: Response) => {
    try {
      if (deps.rateLimited(clientIp(req))) return res.status(429).json({ ok: false, error: "too_many_attempts" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Honeypot: a bot fills every field. Answer like a normal sign-up and do nothing.
      if (typeof body["website"] === "string" && body["website"]) return res.json({ ok: true, state: "confirm_email" });

      const name = String(body["name"] ?? "").trim();
      const email = String(body["email"] ?? "").trim().toLowerCase();
      const shipName = String(body["ship"] ?? "").trim();
      const lang: "en" | "es" = body["lang"] === "es" ? "es" : "en";
      const source = typeof body["source"] === "string" && SOURCE_RE.test(body["source"]) ? body["source"] : "tracker";

      if (name.length < 2) return res.status(400).json({ ok: false, error: "name_required" });
      if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: "email_invalid" });
      if (!shipName) return res.status(400).json({ ok: false, error: "ship_required" });

      const ship = await deps.findShip(shipName);
      if (!ship) return res.status(404).json({ ok: false, error: "unknown_ship" });

      const today = deps.today();
      const existing = await deps.findSubscriber(email);
      const path = signupPath(existing?.status);
      if (path === "unreachable") return res.status(409).json({ ok: false, error: "email_unreachable" });

      if (path === "watch_now" && existing) {
        const open = await deps.findOpenWatch(existing.id, ship.name, today);
        if (open?.status === "active") {
          return res.json({ ok: true, state: "tracking", ship: ship.name, until: open.sailing_end, already: true });
        }
        const window = rollingWindow(today);
        let watchId: string;
        if (open) {
          await deps.activateWatch(open.id, window);
          watchId = open.id;
        } else {
          watchId = (await deps.createWatch({
            subscriber_id: existing.id, ship_name: ship.name, sailing_start: window.start, sailing_end: window.end,
            window_days: WATCH_WINDOW_DAYS, status: "active", source,
          })).id;
        }
        const mail = trackingEmail({
          shipName: ship.name, sailingStart: window.start, sailingEnd: window.end, subscriberName: existing.name,
          lang: existing.lang ?? lang, stopUrl: watchStopUrl(watchId), windowDays: WATCH_WINDOW_DAYS,
        });
        await deps.sendTracking({ to: email, ...mail });
        logger.info({ ship: ship.name, watchId, source }, "track-signup: subscriber is tracking");
        return res.json({ ok: true, state: "tracking", ship: ship.name, until: window.end });
      }

      // Not confirmed yet: the watch waits, and the confirmation email switches it on.
      let subscriberId: string;
      let token: string;
      if (!existing) {
        token = deps.newToken();
        subscriberId = (await deps.createSubscriber({ email, name, lang, token })).id;
      } else if (existing.status === "pending" && existing.token) {
        token = existing.token;
        subscriberId = existing.id;
      } else {
        token = deps.newToken();
        await deps.reopenSubscriber(existing.id, { name, lang, token });
        subscriberId = existing.id;
      }
      if (!(await deps.findOpenWatch(subscriberId, ship.name, today))) {
        // Dated from today so an unconfirmed sign-up lapses with its 15 days; confirming restarts the count.
        const window = rollingWindow(today);
        await deps.createWatch({
          subscriber_id: subscriberId, ship_name: ship.name, sailing_start: window.start, sailing_end: window.end,
          window_days: WATCH_WINDOW_DAYS, status: "pending", source,
        });
      }
      await deps.sendVerification({ name: existing?.name || name, email, token, lang, shipName: ship.name });
      logger.info({ ship: ship.name, source, returning: Boolean(existing) }, "track-signup: confirmation sent");
      return res.json({ ok: true, state: "confirm_email", ship: ship.name });
    } catch (err) {
      logger.error({ err }, "track-signup failed");
      return res.status(500).json({ ok: false, error: "unexpected" });
    }
  });

  // The "Keep tracking" button on the sign-up page, opened from the email a 15-day watch sends
  // when it ends. A POST behind a button, so a mail scanner opening the link restarts nothing.
  router.post("/wms/watch/restart", async (req: Request, res: Response) => {
    try {
      if (deps.rateLimited(clientIp(req))) return res.status(429).json({ ok: false, error: "too_many_attempts" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const id = String(body["id"] ?? "").trim();
      const sig = String(body["sig"] ?? "").trim();
      if (!UUID_RE.test(id) || !sig || sig !== makeWatchSig(id, "restart")) {
        return res.status(400).json({ ok: false, error: "invalid_link" });
      }
      const watch = await deps.findWatch(id);
      if (!watch || !watch.window_days) return res.status(404).json({ ok: false, error: "invalid_link" });
      if (watch.subscriber_status !== "confirmed") {
        return res.status(409).json({ ok: false, error: "subscription_inactive", ship: watch.ship_name });
      }
      const today = deps.today();
      const other = await deps.findOpenWatch(watch.subscriber_id, watch.ship_name, today);
      if (other && other.id !== watch.id && other.status === "active") {
        return res.json({ ok: true, state: "tracking", ship: watch.ship_name, until: other.sailing_end, already: true });
      }
      const window = rollingWindow(today, watch.window_days);
      await deps.activateWatch(watch.id, window);
      logger.info({ ship: watch.ship_name, watchId: watch.id, until: window.end }, "track-signup: watch restarted");
      return res.json({ ok: true, state: "restarted", ship: watch.ship_name, until: window.end });
    } catch (err) {
      logger.error({ err }, "watch restart failed");
      return res.status(500).json({ ok: false, error: "unexpected" });
    }
  });

  return router;
}

// ── Production dependencies ──────────────────────────────────────────────────

const attempts = new Map<string, { count: number; resetAt: number }>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const table = (name: string): any => getSupabase().from(name);

export const defaultTrackSignupDeps: TrackSignupDeps = {
  async findSubscriber(email) {
    const { data, error } = await table("subscribers").select("id, name, lang, status, token").eq("email", email).maybeSingle();
    if (error) throw error;
    return data ? { id: String(data.id), name: String(data.name ?? ""), lang: data.lang ?? null, status: String(data.status), token: data.token ?? null } : null;
  },
  async createSubscriber({ email, name, lang, token }) {
    const { data, error } = await table("subscribers").insert({ email, name, lang, token, status: "pending" }).select("id").single();
    if (error) throw error;
    return { id: String(data.id) };
  },
  async reopenSubscriber(id, { name, lang, token }) {
    const { error } = await table("subscribers").update({ status: "pending", name, lang, token }).eq("id", id);
    if (error) throw error;
  },
  async findShip(name) {
    const { data } = await table("ships").select("name").eq("active", true).ilike("name", name).maybeSingle();
    return data ? { name: String(data.name) } : null;
  },
  async findOpenWatch(subscriberId, shipName, today) {
    const { data, error } = await table("ship_watches")
      .select("id, status, sailing_end")
      .eq("subscriber_id", subscriberId)
      .eq("ship_name", shipName)
      .in("status", ["pending", "active"])
      .lte("sailing_start", today)
      .gte("sailing_end", today)
      .order("status", { ascending: true }) // "active" sorts before "pending"
      .limit(1);
    if (error) throw error;
    const row = (data ?? [])[0];
    return row ? { id: String(row.id), status: String(row.status), sailing_end: String(row.sailing_end) } : null;
  },
  async findWatch(id) {
    const { data, error } = await table("ship_watches")
      .select("id, subscriber_id, ship_name, window_days, subscribers ( status )")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      id: String(data.id), subscriber_id: String(data.subscriber_id), ship_name: String(data.ship_name),
      window_days: data.window_days ?? null, subscriber_status: data.subscribers?.status ?? null,
    };
  },
  async createWatch(row) {
    const { data, error } = await table("ship_watches").insert(row).select("id").single();
    if (error) throw error;
    return { id: String(data.id) };
  },
  async activateWatch(id, window) {
    const { error } = await table("ship_watches")
      .update({ status: "active", sailing_start: window.start, sailing_end: window.end, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
  },
  async sendVerification({ name, email, token, lang, shipName }) {
    const baseUrl = process.env["PUBLIC_URL"]?.replace(/\/$/, "") || "https://stillafloatcruising.com";
    await sendVerificationEmail(name, email, token, baseUrl, lang, shipName);
  },
  async sendTracking({ to, subject, html }) {
    await sendMail({ to, subject, fromName: "Still Afloat Ship Watch", html });
  },
  today: () => new Date().toISOString().slice(0, 10),
  newToken: () => crypto.randomUUID(),
  rateLimited(ip) {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || now > entry.resetAt) {
      attempts.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
      return false;
    }
    if (entry.count >= 10) return true;
    entry.count++;
    return false;
  },
};

export default createTrackSignupRouter();
