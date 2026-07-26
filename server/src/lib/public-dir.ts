import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Locate server/public. Works from both src/lib (tsx) and the bundled dist/
// output by walking up from this module until it finds a `public/index.html`.
export function resolvePublicDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "public");
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("cannot locate server/public");
}
