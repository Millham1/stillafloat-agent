import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const DASHBOARD_DIR = path.resolve(__dirname, "../../dashboard/dist/public");
const DASHBOARD_HOST = "stillafloat-agent.replit.app";

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

// Dashboard — served at /dashboard on the Replit domain only.
// Dev: no hostname check (Replit preview needs it at this path).
// Production: only responds on stillafloat-agent.replit.app, not on stillafloatcruising.com.
app.use("/dashboard", (req, res, next) => {
  if (process.env.NODE_ENV === "production" && req.hostname !== DASHBOARD_HOST) {
    return next();
  }
  express.static(DASHBOARD_DIR, staticOpts)(req, res, () => {
    res.sendFile(path.join(DASHBOARD_DIR, "index.html"));
  });
});

// Website static files
app.use(express.static(PUBLIC_DIR, staticOpts));
app.use("/preview-site", express.static(PUBLIC_DIR, staticOpts));

// Fallback: serve index.html for unmatched paths (but not /dashboard which is its own app)
app.get("/{*path}", (req, res) => {
  if (req.path.startsWith("/dashboard")) {
    res.status(404).send("Not found");
    return;
  }
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

export default app;
