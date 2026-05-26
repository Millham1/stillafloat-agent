import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

// In dev the Vite proxy forwards /api → localhost:8080, so no base URL needed.
// For a standalone deployment set VITE_API_BASE_URL to the production API origin,
// e.g. https://stillafloatcruising.com
const apiBase = import.meta.env.VITE_API_BASE_URL as string | undefined;
if (apiBase) setBaseUrl(apiBase);

createRoot(document.getElementById("root")!).render(<App />);
