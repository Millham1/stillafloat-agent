import { useEffect, useState } from "react";
import { setStoredToken } from "@/lib/auth-token";

export function TokenGate({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState(() => {
    try { return localStorage.getItem("sa_agent_token") || ""; } catch { return ""; }
  });

  // One-tap device enrolment: accept #token= from the URL FRAGMENT, validate it
  // server-side, store it, and scrub it from the address bar. A fragment — unlike a
  // ?query — is never sent to the server, so the token cannot land in nginx access
  // logs or referer headers. Typing a 64-char machine token on a phone is not a real
  // workflow — this is how the second gate stops locking Mark's new devices out
  // (found 2026-08-28: desktop only worked because localStorage had held the token
  // for months).
  useEffect(() => {
    if (token) return;
    const m = window.location.hash.match(/[#&]token=([^&]+)/);
    const t = m ? decodeURIComponent(m[1]).trim() : "";
    if (!t) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    (async () => {
      try {
        const res = await fetch("/api/auth-check", { headers: { "x-affiliate-token": t } });
        if (res.ok) { setStoredToken(t); setToken(t); }
      } catch { /* fall through to the manual form */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  if (token) return <>{children}</>;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const t = input.trim();
    if (!t) { setError("Please enter your access token."); return; }
    setChecking(true);
    setError("");
    try {
      // Validate server-side before storing, so a wrong token is rejected here
      // instead of silently failing on every later admin request.
      const res = await fetch("/api/auth-check", { headers: { "x-affiliate-token": t } });
      if (!res.ok) { setError("Invalid access token."); return; }
      setStoredToken(t);
      setToken(t);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm p-8 rounded-xl border bg-card shadow-sm">
        <div className="mb-6 text-center">
          <div className="text-2xl font-bold tracking-tight mb-1">Still Afloat</div>
          <div className="text-sm text-muted-foreground">Enter your dashboard access token to continue</div>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            autoFocus
            placeholder="Access token"
            value={input}
            onChange={e => { setInput(e.target.value); setError(""); }}
            className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={checking}
            className="w-full py-2 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60"
          >
            {checking ? "Checking…" : "Unlock Dashboard"}
          </button>
        </form>
      </div>
    </div>
  );
}
