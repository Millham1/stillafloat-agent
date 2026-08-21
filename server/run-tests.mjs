// run-tests.mjs — bundle src/**/*.test.ts with esbuild and run them with the
// built-in node:test runner. No extra test-framework dependency: tests import
// pure modules (keep heavy I/O out of test dependency graphs).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, rm, cp } from "node:fs/promises";
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
  // Optional native deps (ws etc.) that must not be resolved at bundle time.
  external: ["node:*", "bufferutil", "utf-8-validate", "fsevents"],
  banner: {
    js: `import { createRequire as __trCrReq } from 'node:module';\nglobalThis.require = __trCrReq(import.meta.url);`,
  },
});

// Fixtures are READ at runtime, not bundled: the cabin-pool fixture is a gzipped
// 12MB dump of every room on all 138 hulls, so esbuild cannot inline it the way it
// did when the fixture was small enough to `import`. Copy it next to the bundle so
// the relative path resolves from dist-test/.
await cp(path.join(srcDir, "lib", "__fixtures__"), path.join(outDir, "__fixtures__"), { recursive: true });

// Pass the built files EXPLICITLY rather than the directory. `node --test <dir>`
// does not scan for test files on every Node 22.x — on 22.11 it tries to load the
// directory as a module and the whole suite fails before a single test runs, which
// is what was happening on the Mac (2026-08-17). Naming the files works everywhere.
const built = (await readdir(outDir)).filter((f) => f.endsWith(".mjs")).map((f) => path.join(outDir, f));
if (!built.length) { console.error("build produced no test files"); process.exit(1); }

// NODE_ENV=production keeps the logger on the plain pino path (no pino-pretty
// worker transport, which does not resolve from a bundled test file).
const result = spawnSync(process.execPath, ["--test", ...built], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production" },
});
await rm(outDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
