import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");

const app: Express = express();

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

// Fallback: serve the website index.html for unmatched paths.
app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

export default app;
