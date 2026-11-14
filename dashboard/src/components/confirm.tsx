import React, { useEffect, useRef, useState } from "react";

// The site's own "are you sure?" box (Mark 2026-11-13: "none of the action buttons are working. i tried to send the paperwork and it is dead").
// The browser's built-in confirm box can be switched off for a page (Chrome's "don't let this page show more dialogs", or a browser extension
// answering it), and then every button behind one does nothing and says nothing. This box is part of the page, so it always shows.
// One <ConfirmHost /> sits in App.tsx; any page calls `await ask("…")` (yes/no) or `await askTyped("…")` (the typed text, or null).

type Pending = { text: string; typed: boolean; done: (v: boolean | string | null) => void };
let open: ((p: Pending) => void) | null = null;

export function ask(text: string): Promise<boolean> {
  return new Promise((ok) => { if (!open) { ok(false); return; } open({ text, typed: false, done: (v) => ok(v === true) }); });
}
export function askTyped(text: string): Promise<string | null> {
  return new Promise((ok) => { if (!open) { ok(null); return; } open({ text, typed: true, done: (v) => ok(typeof v === "string" ? v : null) }); });
}

export function ConfirmHost() {
  const [p, setP] = useState<Pending | null>(null);
  const [typed, setTyped] = useState("");
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => { open = (next) => { setTyped(""); setP(next); }; return () => { open = null; }; }, []);
  useEffect(() => { if (p && !p.typed) yes.current?.focus(); }, [p]);
  if (!p) return null;
  const close = (v: boolean | string | null) => { setP(null); p.done(v); };
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4" role="alertdialog" aria-modal="true" aria-label="Please confirm"
      onKeyDown={(e) => { if (e.key === "Escape") close(p.typed ? null : false); }}>
      <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xl">
        <p className="text-lg leading-relaxed whitespace-pre-line" data-confirm-text>{p.text}</p>
        {p.typed && <input autoFocus className="mt-4 w-full rounded-md border bg-background px-3 py-2 text-base" value={typed} onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") close(typed); }} aria-label="Type here to confirm" />}
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" className="text-base px-5 py-2.5 rounded-md border bg-card hover:bg-muted/40" onClick={() => close(p.typed ? null : false)}>Cancel</button>
          <button type="button" ref={yes} className="text-base font-semibold px-5 py-2.5 rounded-md bg-primary text-primary-foreground" onClick={() => close(p.typed ? typed : true)} data-confirm-yes>Yes, go ahead</button>
        </div>
      </div>
    </div>
  );
}
