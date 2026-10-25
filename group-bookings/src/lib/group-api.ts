import { authHeaders, clearStoredToken } from "@/lib/auth-token";
import type { WorkspaceData } from "@/lib/group-workspace";

/** Calls the site's group-bookings API on this same origin (the app is served at /groups/ beside /api/). */
export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...authHeaders() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (r.status === 401) { clearStoredToken(); throw new Error("This browser's sign-in was not accepted. Reload the page and sign in again."); }
  if (!r.ok) throw new Error(json?.error || `Request failed (${r.status})`);
  return json as T;
}

/** The one dataset behind every page of Group Bookings. */
export const ANALYTICS_KEY = ["groups-analytics"] as const;
export const fetchAnalytics = () => api<WorkspaceData & { success: boolean }>("/groups/analytics");
export const ANALYTICS_STALE_MS = 60_000;

/** Where a group's file lives (editing a file's fields stays there): the dashboard, opened in a new tab. */
export const groupFileHref = (groupId: string, section = ""): string => {
  const live = /(^|\.)stillafloatcruising\.com$/i.test(window.location.hostname);
  const base = live ? "https://dashboard.stillafloatcruising.com" : `${window.location.origin}/dashboard`;
  return `${base}/groups/${groupId}${section ? `#${section}` : ""}`;
};
