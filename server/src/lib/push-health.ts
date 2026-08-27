// push-health.ts — notice when the notification channel has quietly died.
//
// On 2026-08-26 platform_state's push-subscriptions held ZERO devices, so every
// one of the 14 notifyMark() call sites had been delivering nothing. Nobody was
// told, because a channel with no subscribers fails exactly like a channel with
// nothing to say: sendPush returns {sent:0} and the caller shrugs.
//
// How it got to zero is not a bug — sendPush prunes subscriptions that 403 under
// a rotated VAPID keypair, which is correct. The bug is that pruning the LAST
// device left the system with no way to reach Mark and no way to say so.
//
// So: check the device count on a schedule and raise an action when it hits zero.
// The action is priority:"high", which unlocks the email floor in notify.ts —
// the one channel that still works when push is dead. createAction dedups on
// (type, source_ref) while a row is pending, so this is one email, not a drip.
//
// This is the first of the self-checks the master reference calls for: the brief
// reports queue DEPTH but never whether the step that fills a queue still runs.

import { subscriptionCount, getVapidPublicKey } from "./push";
import { createAction } from "./actions";
import { logger } from "./logger";

/** Stable source_ref so a pending "channel is dead" row never duplicates. */
const SOURCE_REF = "push-channel-empty";

export interface PushHealth {
  devices: number;
  vapidConfigured: boolean;
  raised: boolean;
}

/**
 * Seams for tests. Production passes nothing and gets the real implementations;
 * a test supplies fakes and asserts on what the check DOES, not on its types.
 */
export interface PushHealthDeps {
  count?: () => Promise<number>;
  vapid?: () => string | null;
  ntfyLive?: () => boolean;
  raise?: typeof createAction;
}

/**
 * Raise an action if no device can receive a push. Never throws — a health
 * check that takes down the caller is worse than the condition it reports.
 */
export async function checkPushHealth(deps: PushHealthDeps = {}): Promise<PushHealth> {
  const count = deps.count ?? subscriptionCount;
  const vapid = deps.vapid ?? getVapidPublicKey;
  const raise = deps.raise ?? createAction;
  const ntfyConfigured =
    deps.ntfyLive ?? (() => Boolean(process.env["NTFY_URL"] && process.env["NTFY_TOPIC"]));

  const out: PushHealth = { devices: 0, vapidConfigured: false, raised: false };
  try {
    out.vapidConfigured = Boolean(vapid());
    out.devices = await count();

    if (out.devices > 0) {
      logger.info({ devices: out.devices }, "push health: channel has devices");
      return out;
    }

    // ntfy, once deployed, is an independent path — a zero device count is only
    // a total outage while web push is the only tier that can actually deliver.
    if (ntfyConfigured()) {
      logger.warn("push health: no push devices, but ntfy is configured — not raising");
      return out;
    }

    const body = out.vapidConfigured
      ? "No device is subscribed to Web Push, so agent nudges are reaching nobody. " +
        "Open the dashboard → Alerts and re-enable notifications on your phone. " +
        "(A subscription is dropped automatically when the VAPID keypair rotates.)"
      : "Web Push has no devices AND no VAPID keypair is configured. " +
        "Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in shared.env, restart, then re-subscribe.";

    const r = await raise({
      type: "system-fault",
      title: "🔕 Push notifications are reaching nobody",
      body,
      source_ref: SOURCE_REF,
      priority: "high",
    });
    out.raised = r.created;
    logger.error({ raised: r.created, vapid: out.vapidConfigured },
      "push health: ZERO subscribed devices — agent nudges are going nowhere");
  } catch (err) {
    logger.error({ err }, "push health check failed");
  }
  return out;
}
