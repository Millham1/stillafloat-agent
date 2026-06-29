import webpush from "web-push";
import { readJson, writeJson } from "./persistence";
import { logger } from "./logger";

// ── In-house Web Push ─────────────────────────────────────────────────────────
// Replaces Telegram. The server originates every notification and signs it with a
// VAPID keypair Mark holds (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in shared.env).
// The browser's push transport only relays an encrypted blob it cannot read, and
// there is NO inbound channel — nothing for a spammer to target. No third-party
// service, no account, no phone number.
//
// Subscriptions (one per installed PWA / device) live in platform_state under
// PUSH_KEY. Sending prunes any that the push service reports as gone (404/410).

const PUSH_KEY = "push-subscriptions";

export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  ua?: string;
  addedAt?: string;
}

interface PushStore {
  subs: StoredSubscription[];
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string; // dashboard path to open on tap, e.g. "/today"
  tag?: string; // collapses/replaces same-tag notifications
}

let vapidReady = false;

/** Configure web-push from env. Returns false (and logs once) if keys are unset. */
function ensureVapid(): boolean {
  if (vapidReady) return true;
  const publicKey = process.env["VAPID_PUBLIC_KEY"];
  const privateKey = process.env["VAPID_PRIVATE_KEY"];
  const subject = process.env["VAPID_SUBJECT"] || "mailto:mmillham1@gmail.com";
  if (!publicKey || !privateKey) {
    logger.warn("Web Push disabled — VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set");
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidReady = true;
  return true;
}

/** The public VAPID key the browser needs for pushManager.subscribe(). */
export function getVapidPublicKey(): string | null {
  return process.env["VAPID_PUBLIC_KEY"] || null;
}

/** Generate a fresh VAPID keypair (one-time bootstrap helper; does not persist). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}

async function loadStore(): Promise<PushStore> {
  return readJson<PushStore>(PUSH_KEY, { subs: [] });
}

/** Register (or refresh) a device subscription, de-duped by endpoint. */
export async function saveSubscription(sub: StoredSubscription, ua?: string): Promise<void> {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    throw new Error("invalid subscription");
  }
  const store = await loadStore();
  const others = store.subs.filter((s) => s.endpoint !== sub.endpoint);
  others.push({
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    ua: ua?.slice(0, 200),
    addedAt: new Date().toISOString(),
  });
  await writeJson(PUSH_KEY, { subs: others });
  logger.info({ count: others.length }, "Push subscription saved");
}

/** Remove a device subscription by endpoint. */
export async function removeSubscription(endpoint: string): Promise<void> {
  if (!endpoint) return;
  const store = await loadStore();
  const remaining = store.subs.filter((s) => s.endpoint !== endpoint);
  if (remaining.length !== store.subs.length) {
    await writeJson(PUSH_KEY, { subs: remaining });
    logger.info({ count: remaining.length }, "Push subscription removed");
  }
}

/** How many devices are currently subscribed. */
export async function subscriptionCount(): Promise<number> {
  return (await loadStore()).subs.length;
}

/**
 * Push a notification to every subscribed device. No-ops cleanly when VAPID is
 * unconfigured or there are no subscribers. Expired subscriptions (404/410) are
 * pruned automatically. Returns how many devices were reached.
 */
export async function sendPush(payload: PushPayload): Promise<{ sent: number; pruned: number }> {
  if (!ensureVapid()) return { sent: 0, pruned: 0 };
  const store = await loadStore();
  if (store.subs.length === 0) return { sent: 0, pruned: 0 };

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url || "/today",
    tag: payload.tag,
  });

  const dead: string[] = [];
  let sent = 0;

  await Promise.all(
    store.subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body,
          { TTL: 60 * 60 * 12 }, // 12h — a brief/alert is stale after that
        );
        sent += 1;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          dead.push(sub.endpoint); // gone — drop it
        } else {
          logger.warn({ err, status }, "Push send failed for one device");
        }
      }
    }),
  );

  if (dead.length) {
    const remaining = store.subs.filter((s) => !dead.includes(s.endpoint));
    await writeJson(PUSH_KEY, { subs: remaining });
  }

  return { sent, pruned: dead.length };
}
