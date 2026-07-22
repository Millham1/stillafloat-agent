// run-tests.mjs — bundle src/**/*.test.ts with esbuild and run them with the
// built-in node:test runner. No extra test-framework dependency: tests import
// pure modules (keep heavy I/O out of test dependency graphs).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { build as esbuild } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "src");
const outDir = path.resolve(here, "dist-test");

async function findTests(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findTests(p)));
    else if (entry.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const entryPoints = await findTests(srcDir);
if (!entryPoints.length) {
  console.log("no *.test.ts files found");
  process.exit(0);
}

await rm(outDir, { recursive: true, force: true });
await esbuild({
  entryPoints,
  platform: "node",
  bundle: true,
  format: "esm",
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
  external: ["node:*"],
});

const result = spawnSync(process.execPath, ["--test", outDir], { stdio: "inherit" });
await rm(outDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
