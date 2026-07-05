import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken, tokenOk } from "../lib/http-auth";
import {
  getVapidPublicKey,
  generateVapidKeys,
  saveSubscription,
  removeSubscription,
  subscriptionCount,
  sendPush,
  type StoredSubscription,
} from "../lib/push";
import { logger } from "../lib/logger";

// In-house Web Push endpoints. The public key is readable so the PWA can
// subscribe; all writes/sends are gated by the dashboard token (requireToken).
const router: IRouter = Router();

// Public: the key the browser needs to create a subscription.
router.get("/push/vapid-public-key", (_req, res) => {
  const key = getVapidPublicKey();
  if (!key) {
    res.status(503).json({ ok: false, error: "VAPID not configured" });
    return;
  }
  res.json({ ok: true, key });
});

// One-time bootstrap: generate a VAPID keypair to paste into shared.env.
// Gated; returns the private key only to an authenticated admin. Safe to ignore
// once the keys are configured.
router.get("/push/generate-keys", requireToken, (_req, res) => {
  const keys = generateVapidKeys();
  res.json({ ok: true, ...keys, note: "Add VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to shared.env, then restart." });
});

// Register this device's push subscription.
router.post("/push/subscribe", requireToken, async (req: Request, res: Response) => {
  try {
    const sub = req.body?.subscription as StoredSubscription | undefined;
    if (!sub) {
      res.status(400).json({ ok: false, error: "missing subscription" });
      return;
    }
    await saveSubscription(sub, req.headers["user-agent"] as string | undefined);
    res.json({ ok: true, devices: await subscriptionCount() });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

// Unregister a device.
router.post("/push/unsubscribe", requireToken, async (req: Request, res: Response) => {
  try {
    const endpoint = req.body?.endpoint as string | undefined;
    await removeSubscription(endpoint || "");
    res.json({ ok: true, devices: await subscriptionCount() });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

// Internal: send a custom push. Used by the ops-manager (Python) to deliver
// alerts now that Telegram is gone. Auth: the dashboard token OR the ops-manager's
// own IDEAS_API_KEY via x-api-key (it already holds that secret).
router.post("/push/notify", async (req: Request, res: Response) => {
  const opsKey = process.env["IDEAS_API_KEY"];
  const viaApiKey = Boolean(opsKey) && req.headers["x-api-key"] === opsKey;
  if (!viaApiKey && !tokenOk(req)) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  try {
    const { title, body, url, tag } = (req.body ?? {}) as {
      title?: string; body?: string; url?: string; tag?: string;
    };
    if (!title && !body) {
      res.status(400).json({ ok: false, error: "title or body required" });
      return;
    }
    const result = await sendPush({
      title: title || "Still Afloat",
      body: body || "",
      url: url || "/brief.html",
      tag,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// Send a test push to all registered devices.
router.post("/push/test", requireToken, async (_req: Request, res: Response) => {
  try {
    const result = await sendPush({
      title: "✅ Alerts are working",
      body: "This is a test from your Still Afloat dashboard. No Telegram required.",
      url: "/brief.html",
      tag: "push-test",
    });
    logger.info(result, "Push test sent");
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
