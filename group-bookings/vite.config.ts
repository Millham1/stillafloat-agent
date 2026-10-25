import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Group Bookings is its own app (Mark 2026-10-25), always served at /groups/ on the same origin as the site's API:
// stillafloatcruising.com/groups/ live, the box address /groups/ on the test site. So the base and the API origin are the
// same everywhere; nothing differs between the two servers. ("the title should be stillafloatcruising.com/groups, not
// workspace. workspace can mean anything")
export default defineConfig({
  base: "/groups/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    // SAF_GB_DIST lets the deploy build into a versioned folder and swap it in atomically, as it does for the site.
    outDir: path.resolve(import.meta.dirname, `${process.env.SAF_GB_DIST || "dist"}/public`),
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.PORT) || 5174,
    host: "0.0.0.0",
    proxy: { "/api": { target: process.env.SAF_API_ORIGIN || "http://localhost:8080", changeOrigin: true } },
  },
});
