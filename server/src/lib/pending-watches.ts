// pending-watches.ts — confirming a subscription switches on the ship watches it was started with.
//
// A "Track this ship" sign-up from someone who is not a confirmed subscriber yet saves the
// watch as 'pending' (routes/track-signup.ts). The moment they click the confirmation link,
// each pending watch of theirs starts and sends its "You're tracking" email. A 15-day watch
// counts its 15 days from that click, not from the sign-up. One that sat unconfirmed past its
// 15 days (or a sailing that finished meanwhile) is closed instead: the storm has moved on.

import { getSupabase } from "./persistence";
import { logger } from "./logger";
import { sendMail } from "./mailer";
import { rollingWindow, trackingEmail, watchStopUrl, type WatchWindow } from "./ship-watch";

export interface PendingWatch {
  id: string;
  ship_name: string;
  sailing_start: string;
  sailing_end: string;
  window_days: number | null;
}

export interface PendingWatchDeps {
  listPending(subscriberId: string): Promise<PendingWatch[]>;
  /** Switch a watch on; a 15-day watch gets a fresh window starting today. */
  activate(watchId: string, window: WatchWindow | null): Promise<void>;
  end(watchId: string): Promise<void>;
  sendTracking(args: { to: string; subject: string; html: string }): Promise<void>;
  today(): string;
}

/** The watches now running, in the order they were started, with each one's last day. */
export async function activatePendingWatches(
  subscriber: { id: string; email: string; name: string; lang: string | null },
  deps: PendingWatchDeps = defaultPendingWatchDeps,
): Promise<{ ship: string; until: string }[]> {
  const today = deps.today();
  const started: { ship: string; until: string }[] = [];
  for (const w of await deps.listPending(subscriber.id)) {
    if (w.sailing_end < today) {
      await deps.end(w.id);
      continue;
    }
    const window = w.window_days ? rollingWindow(today, w.window_days) : null;
    await deps.activate(w.id, window);
    const start = window?.start ?? w.sailing_start;
    const end = window?.end ?? w.sailing_end;
    started.push({ ship: w.ship_name, until: end });
    try {
      const mail = trackingEmail({
        shipName: w.ship_name, sailingStart: start, sailingEnd: end, subscriberName: subscriber.name,
        lang: subscriber.lang ?? "en", stopUrl: watchStopUrl(w.id), windowDays: w.window_days,
      });
      await deps.sendTracking({ to: subscriber.email, ...mail });
    } catch (err) {
      // The watch is on either way; a lost welcome email must not undo it.
      logger.warn({ err, ship: w.ship_name }, "pending-watches: tracking email failed");
    }
  }
  return started;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const table = (name: string): any => getSupabase().from(name);

export const defaultPendingWatchDeps: PendingWatchDeps = {
  async listPending(subscriberId) {
    const { data, error } = await table("ship_watches")
      .select("id, ship_name, sailing_start, sailing_end, window_days")
      .eq("subscriber_id", subscriberId)
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    if (error) throw error;
    return ((data ?? []) as PendingWatch[]).map((w) => ({ ...w, id: String(w.id), window_days: w.window_days ?? null }));
  },
  async activate(watchId, window) {
    const { error } = await table("ship_watches")
      .update({
        status: "active",
        ...(window ? { sailing_start: window.start, sailing_end: window.end } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", watchId);
    if (error) throw error;
  },
  async end(watchId) {
    const { error } = await table("ship_watches").update({ status: "ended", updated_at: new Date().toISOString() }).eq("id", watchId);
    if (error) throw error;
  },
  async sendTracking({ to, subject, html }) {
    await sendMail({ to, subject, fromName: "Still Afloat Ship Watch", html });
  },
  today: () => new Date().toISOString().slice(0, 10),
};
