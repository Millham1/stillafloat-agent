import { readFileSync } from "node:fs";

// Single shared .env is the source of truth for secrets across every Still Afloat
// service (same pattern as stillafloat-newsagent). Imported FIRST in index.ts so
// the whole process sees a populated env regardless of how pm2 was started —
// env lives in the file, decoupled from the process manager. No `dotenv` dep
// (keeps the fragile pnpm-lock untouched); a tiny no-override parser instead.
//
// Precedence (highest first): already-set process.env (pm2/CI) > local .env >
// shared .env. An existing value is never overwritten.
function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // file absent (e.g. a box without the shared file) — skip silently
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue; // never override
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

// Local service config first (PORT/BASE_PATH/DASHBOARD_URL…), then shared secrets.
loadEnvFile(`${process.cwd()}/.env`);
loadEnvFile(process.env["SHARED_ENV_PATH"] ?? "/opt/stillafloat/shared.env");
