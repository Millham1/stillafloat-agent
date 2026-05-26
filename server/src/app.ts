import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const DASHBOARD_DIR = path.resolve(__dirname, "../../dashboard/dist/public");

const DASHBOARD_TOKEN = process.env.AGENT_APPROVAL_TOKEN ?? "";
const COOKIE_NAME = "saf_dash";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((c) => {
      const [k, ...v] = c.trim().split("=");
      return [k.trim(), decodeURIComponent(v.join("="))];
    }),
  );
}

function dashboardAuth(req: Request, res: Response, next: NextFunction) {
  if (!DASHBOARD_TOKEN) {
    res.status(503).send("Dashboard is disabled: AGENT_APPROVAL_TOKEN is not configured.");
    return;
  }
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE_NAME] === DASHBOARD_TOKEN) {
    next();
    return;
  }
  const next_ = encodeURIComponent(req.originalUrl);
  res.status(401).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Still Afloat — Dashboard Login</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#07183f;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:'Segoe UI',sans-serif}
    .card{background:#0d2454;border:1px solid #1a3a7a;border-radius:14px;padding:40px 36px;max-width:360px;width:100%;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,0.5)}
    h1{color:#ffca4f;font-size:1.35rem;margin-bottom:6px}
    p{color:#8eb4e8;font-size:.85rem;margin-bottom:24px}
    input{width:100%;padding:11px 14px;border-radius:8px;border:1px solid #1a3a7a;background:#07183f;color:#fff;font-size:1rem;margin-bottom:14px;outline:none}
    input:focus{border-color:#5dff9a}
    button{width:100%;padding:11px;border-radius:8px;border:none;background:#5dff9a;color:#07183f;font-weight:700;font-size:1rem;cursor:pointer}
    button:hover{background:#4ae085}
    .err{color:#ff6080;font-size:.82rem;margin-top:10px;display:none}
  </style>
</head>
<body>
<div class="card">
  <h1>Still Afloat Editorial</h1>
  <p>Enter your access token to continue.</p>
  <form method="GET" action="/dashboard-login">
    <input type="hidden" name="next" value="${next_}"/>
    <input type="password" name="token" placeholder="Access token" autofocus autocomplete="current-password"/>
    <button type="submit">Sign In</button>
  </form>
</div>
</body>
</html>`);
}

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

// Dashboard login handler — sets auth cookie then redirects
app.get("/dashboard-login", (req: Request, res: Response) => {
  const { token, next: next_ } = req.query as Record<string, string>;
  const redirect = next_ && next_.startsWith("/dashboard") ? next_ : "/dashboard/";
  if (!DASHBOARD_TOKEN || token !== DASHBOARD_TOKEN) {
    res.redirect(`${redirect}?auth=fail`);
    return;
  }
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(COOKIE_MAX_AGE / 1000)}`,
  );
  res.redirect(redirect);
});

// Serve the static website — must come after /api routes
// HTML files get no-cache so code changes are always picked up immediately.
// Assets (images, CSS, JS bundles) keep default caching for performance.
const staticOpts: Parameters<typeof express.static>[1] = {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  },
};
// Serve the editorial dashboard React app at /dashboard (production build) — auth-gated
app.use("/dashboard", dashboardAuth, express.static(DASHBOARD_DIR, staticOpts));
app.get("/dashboard/{*path}", dashboardAuth, (_req, res) => {
  res.sendFile(path.join(DASHBOARD_DIR, "index.html"));
});

app.use(express.static(PUBLIC_DIR, staticOpts));
app.use("/preview-site", express.static(PUBLIC_DIR, staticOpts));

// Fallback: serve index.html for unmatched paths
app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

export default app;
