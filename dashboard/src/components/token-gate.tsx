import { useState } from "react";
import { setStoredToken } from "@/lib/auth-token";

export function TokenGate({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState(() => {
    try { return localStorage.getItem("sa_agent_token") || ""; } catch { return ""; }
  });
  const [input, setInput] = useState("");
  const [error, setError] = useState("");

  if (token) return <>{children}</>;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) { setError("Please enter your access token."); return; }
    setStoredToken(input.trim());
    setToken(input.trim());
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
            className="w-full py-2 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
          >
            Unlock Dashboard
          </button>
        </form>
      </div>
    </div>
  );
}
