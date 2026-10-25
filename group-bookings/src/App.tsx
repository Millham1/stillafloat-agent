import React, { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Router as WouterRouter, Switch } from "wouter";
import { Toaster } from "@/components/ui/toaster";
import { getStoredToken, setStoredToken } from "@/lib/auth-token";
import GroupWorkspace from "@/pages/report";

// Group Bookings — its own app (Mark 2026-10-25: "stop relating it to the dashboard. it is a separate entity"; "the title
// should be stillafloatcruising.com/groups"; "only I have access to it"). Full screen, served at /groups/ behind Mark's
// password (nginx) AND his access key (this sign-in). It reads the site's group API; nothing else.

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

/** Sign in once per browser: a one-tap link (#token=, never sent to the server) or the access key typed in. */
function SignIn({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState(getStoredToken);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const check = async (t: string): Promise<boolean> => {
    try { const r = await fetch("/api/auth-check", { headers: { "x-affiliate-token": t } }); return r.ok; } catch { return false; }
  };
  useEffect(() => {
    if (token) return;
    const m = window.location.hash.match(/[#&]token=([^&]+)/);
    const t = m ? decodeURIComponent(m[1]!).trim() : "";
    if (!t) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    void check(t).then((ok) => { if (ok) { setStoredToken(t); setToken(t); } else setError("That sign-in link was not accepted."); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (token) return <>{children}</>;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = input.trim();
    if (!t) { setError("Please enter your access key."); return; }
    setChecking(true); setError("");
    if (await check(t)) { setStoredToken(t); setToken(t); } else setError("That access key was not accepted.");
    setChecking(false);
  };
  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
      <form onSubmit={submit} className="w-full max-w-sm p-8 rounded-xl border bg-card shadow-sm space-y-4">
        <div className="text-center"><div className="text-2xl font-bold tracking-tight">Still Afloat</div><div className="text-sm text-muted-foreground">Group Bookings</div></div>
        <input type="password" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Access key" autoComplete="current-password"
          className="w-full px-3 py-2 rounded-md border bg-background text-sm" aria-label="Access key" />
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button type="submit" disabled={checking} className="w-full px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-60">{checking ? "Checking…" : "Open Group Bookings"}</button>
      </form>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SignIn>
        <WouterRouter base="/groups">
          <div className="h-screen overflow-hidden bg-background text-foreground p-3 md:p-4 flex flex-col">
            <Switch>
              <Route path="/" component={GroupWorkspace} />
              <Route><GroupWorkspace /></Route>
            </Switch>
          </div>
        </WouterRouter>
      </SignIn>
      <Toaster />
    </QueryClientProvider>
  );
}
