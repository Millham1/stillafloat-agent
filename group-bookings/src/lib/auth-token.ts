// Group Bookings' own sign-in (Mark 2026-10-25: a separate entity from the dashboard). The browser keeps the access key
// under the app's own name; the site's API checks it exactly as it does for any of Mark's tools.
const TOKEN_KEY = "saf_group_bookings_token";

export function getStoredToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function setStoredToken(token: string): void {
  try { localStorage.setItem(TOKEN_KEY, token.trim()); } catch { /* private window: signed in for this visit only */ }
}
export function clearStoredToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* nothing kept */ }
}
export function authHeaders(): Record<string, string> {
  const t = getStoredToken();
  return t ? { "x-affiliate-token": t } : {};
}
