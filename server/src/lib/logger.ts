import pino from "pino";
import { pinoErrorHook } from "./error-ledger";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // every error-level line is counted (lib/error-ledger.ts) for GET /api/healthz/jobs
  hooks: { logMethod: pinoErrorHook as never },
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
