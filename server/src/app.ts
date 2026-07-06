import express, { type Express } from "express";
import cors from "cors";
import compression from "compression";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");

const app: Express = express();

// gzip/deflate text responses (HTML, CSS, JS, JSON, SVG). The static assets
// were shipping uncompressed (only nginx's default text/html was gzipped),
// flagged by the site audit. compression's default filter skips already-binary
// types and honors a `x-no-compression` response header for opt-out.
app.use(compression());

// HSTS: tell browsers to always use HTTPS for a year (incl. subdomains).
// nginx already 301s http->https; this hardens it against downgrade. The
// header is forwarded through the nginx proxy to the client.
app.use((_req, res, next) => {
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains",
  );
  next();
});

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use("/api", router);

const staticOpts: Parameters<typeof express.static>[1] = {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  },
};

// The dashboard is now a standalone app at dashboard.stillafloatcruising.com,
// served as static files by nginx (built with BASE_PATH=/). The backend only
// provides its API (/api) — it no longer serves the dashboard bundle.

// Website static files
app.use(express.static(PUBLIC_DIR, staticOpts));
app.use("/preview-site", express.static(PUBLIC_DIR, staticOpts));

// Brief shell — also reachable on THIS origin so Mark can test brief changes on
// the DEV box before promoting (the dashboard subdomain exists only on prod).
// brief.html is an empty shell; all data comes from the token-gated /api. We
// deliberately do NOT serve sw.js here (its cache-first fetch handler must never
// register against the public website origin).
const BRIEF_DIR = path.resolve(process.cwd(), "../dashboard/public");
for (const f of ["brief.html", "brief-manifest.json", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]) {
  app.get(`/${f}`, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.join(BRIEF_DIR, f));
  });
}

// Fallback: serve the website index.html for unmatched paths.
app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

export default app;
