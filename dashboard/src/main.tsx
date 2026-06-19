import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

// In dev the Vite proxy forwards /api → localhost:8080, so no base URL needed.
// For a standalone deployment set VITE_API_BASE_URL to the production API origin,
// e.g. https://stillafloatcruising.com
const apiBase = import.meta.env.VITE_API_BASE_URL as string | undefined;
if (apiBase) setBaseUrl(apiBase);

// Standalone dashboard (separate host): pages that call the API via the generated
// client get `apiBase` prepended automatically. A few pages use raw `fetch("/api/…")`,
// which would otherwise hit THIS static host and return index.html. Prefix those
// relative /api paths with the same PROD origin so every page talks to the one API.
// (Absolute URLs from the client are untouched; in dev apiBase is unset → Vite proxy.)
if (apiBase) {
  const base = apiBase.replace(/\/+$/, "");
  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    typeof input === "string" && input.startsWith("/api/")
      ? nativeFetch(base + input, init)
      : nativeFetch(input, init)) as typeof window.fetch;
}

createRoot(document.getElementById("root")!).render(<App />);
