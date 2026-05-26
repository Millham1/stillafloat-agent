const TOKEN_KEY = "sa_agent_token";

export function getStoredToken(): string {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setStoredToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function authHeaders(): Record<string, string> {
  const t = getStoredToken();
  return t ? { "x-affiliate-token": t } : {};
}
