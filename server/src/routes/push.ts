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
import { notifyMarkDetailed, resolveKind, shapeNotification } from "../lib/notify";

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

// Internal: an agent on this box tells Mark something. Used by the ops-manager (Python)
// and the newsagent, which must not import monorepo code. Auth: the dashboard token OR
// the ops-manager's own IDEAS_API_KEY via x-api-key.
//
// Body: { kind, source, title, body, url, dryRun }
//   kind   "waiting" | "headsup" | "fault" | "activity" (lib/notify.ts — the two phone shapes
//          + the no-push record). Missing kind: resolved from the legacy `tag` (an old
//          caller's "editorial-digest" still means "something to approve"), else "activity".
//   dryRun true → shape only: no push, no record. The release gate uses this on prod so
//          the shapes are tested without buzzing Mark's phone.
// Response: { ok, kind, channel, pushed, sent, recorded, pruned, shaped }
//   recorded = the brief page's record was written (every kind but "waiting"), so a caller whose
//   box has no phone and no email floor (dev) can tell "on the brief page" from "nowhere".
router.post("/push/notify", async (req: Request, res: Response) => {
  const opsKey = process.env["IDEAS_API_KEY"];
  const viaApiKey = Boolean(opsKey) && req.headers["x-api-key"] === opsKey;
  if (!viaApiKey && !tokenOk(req)) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  try {
    const b = (req.body ?? {}) as {
      kind?: unknown; source?: unknown; title?: string; body?: string; url?: string; tag?: unknown; dryRun?: unknown;
    };
    if (!b.title && !b.body) {
      res.status(400).json({ ok: false, error: "title or body required" });
      return;
    }
    const kind = resolveKind(b.kind, b.tag);
    const source = typeof b.source === "string" && b.source.trim()
      ? b.source.trim().slice(0, 60)
      : (viaApiKey ? "ops" : "external");
    const n = { kind, source, title: b.title || "Still Afloat", body: b.body || "", ...(b.url ? { url: b.url } : {}) };
    if (b.dryRun === true) {
      res.json({ ok: true, dryRun: true, kind, shaped: shapeNotification(n) });
      return;
    }
    const out = await notifyMarkDetailed(n);
    const pushed = out.channel === "webpush" || out.channel === "ntfy" || out.channel === "email";
    res.json({
      ok: true,
      kind,
      channel: out.channel,
      pushed,
      sent: out.waiting ? out.waiting.sent : (out.channel === "webpush" ? 1 : 0),
      recorded: out.recorded,
      pruned: out.waiting?.pruned ?? 0,
      ...(out.waiting ? { waiting: { total: out.waiting.total, added: out.waiting.added, title: out.waiting.title } } : {}),
    });
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
