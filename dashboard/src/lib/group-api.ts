import { authHeaders } from "@/lib/auth-token";
import type { WorkspaceData } from "@/lib/group-workspace";

/** The dashboard's call to the group-bookings API (same token header as every other dashboard page). */
export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...authHeaders() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error("This browser's access token was not accepted. Open the sign-in link again.");
  if (!r.ok) throw new Error(json?.error || `Request failed (${r.status})`);
  return json as T;
}

/** The one dataset behind the Group Bookings Workspace and the big picture on the Group Bookings tab. */
export const ANALYTICS_KEY = ["groups-analytics"] as const;
export const fetchAnalytics = () => api<WorkspaceData & { success: boolean }>("/groups/analytics");
export const ANALYTICS_STALE_MS = 60_000;

/** Where the workspace lives, as a full address (for "open in a new tab"; the page is served under /dashboard/ on the dev box). */
export const workspaceHref = (query = ""): string => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/groups/workspace${query ? `?${query}` : ""}`;
