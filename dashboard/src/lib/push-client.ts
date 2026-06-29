import { authHeaders } from "./auth-token";

// Client helpers for in-house Web Push. The PWA subscribes to the browser's push
// service using the server's public VAPID key, then hands the subscription to the
// backend (token-gated). One-way only — the device can receive, never be messaged.

export type PushSupport =
  | { supported: true }
  | { supported: false; reason: string; needsInstall?: boolean };

function isIos(): boolean {
  return /iP(hone|ad|od)/.test(navigator.userAgent);
}

function isStandalone(): boolean {
  // iOS exposes navigator.standalone; others use the display-mode media query.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const iosStandalone = (navigator as any).standalone === true;
  const mq = window.matchMedia?.("(display-mode: standalone)").matches;
  return Boolean(iosStandalone || mq);
}

/** Whether this browser can do Web Push right now, with a human reason if not. */
export function pushSupport(): PushSupport {
  if (!("serviceWorker" in navigator)) {
    return { supported: false, reason: "This browser doesn't support service workers." };
  }
  if (!("PushManager" in window) || !("Notification" in window)) {
    // iOS only exposes Push inside an installed (home-screen) PWA.
    if (isIos() && !isStandalone()) {
      return {
        supported: false,
        needsInstall: true,
        reason:
          "On iPhone, add this dashboard to your Home Screen first (Share → Add to Home Screen), then open it from the icon to enable alerts.",
      };
    }
    return { supported: false, reason: "This browser doesn't support push notifications." };
  }
  if (isIos() && !isStandalone()) {
    return {
      supported: false,
      needsInstall: true,
      reason:
        "On iPhone, add this dashboard to your Home Screen (Share → Add to Home Screen) and open it from the icon, then enable alerts.",
    };
  }
  return { supported: true };
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  // index.html registers /sw.js on load; ready resolves once it's active.
  return navigator.serviceWorker.ready;
}

export interface AlertStatus {
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
}

export async function getAlertStatus(): Promise<AlertStatus> {
  const support = pushSupport();
  if (!support.supported) return { permission: "unsupported", subscribed: false };
  const reg = await getRegistration();
  const sub = await reg.pushManager.getSubscription();
  return { permission: Notification.permission, subscribed: Boolean(sub) };
}

/**
 * Request permission, subscribe to push, and register the subscription with the
 * backend. Throws with a readable message on failure.
 */
export async function enableAlerts(): Promise<void> {
  const support = pushSupport();
  if (!support.supported) throw new Error(support.reason);

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  const keyRes = await fetch("/api/push/vapid-public-key");
  if (!keyRes.ok) throw new Error("Server has no VAPID key configured yet.");
  const { key } = (await keyRes.json()) as { key: string };

  const reg = await getRegistration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }

  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  if (!res.ok) {
    const msg = res.status === 401 ? "Unauthorized — set your dashboard token first." : `Subscribe failed (HTTP ${res.status}).`;
    throw new Error(msg);
  }
}

export async function disableAlerts(): Promise<void> {
  const reg = await getRegistration();
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
}

export async function sendTestAlert(): Promise<{ sent: number; pruned: number }> {
  const res = await fetch("/api/push/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
  });
  if (!res.ok) throw new Error(`Test failed (HTTP ${res.status}).`);
  return (await res.json()) as { sent: number; pruned: number };
}
