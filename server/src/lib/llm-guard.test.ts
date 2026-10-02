// llm-guard.test.ts — no Claude call can leave this repo untagged or ungated.
//
// TypeScript enforces the job tag on llmText/llmJson. This test closes the other door:
// a hand-rolled fetch to api.anthropic.com anywhere else (a route, a cabin-advisor script,
// a shell loop) would skip the tag AND the bulk-run gate, so outside the three wrappers
// the API host may not appear at all. It also checks that every job tag a script uses is
// registered, and that no retired Sonnet id is hard-coded.
//
// Reads source files only. No network.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import JOBS from "./llm-jobs.json";

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "cabin-advisor")) && existsSync(join(dir, "server", "src"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error(`cannot find the repo root from ${process.cwd()}`);
}

const ROOT = repoRoot();
const CODE = /\.(ts|tsx|mjs|js|py|sh)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-test", "data", "advice", "context", "geometry", "noise", "carnival", "ncl", "widgety-cache", "logs", "__fixtures__", ".git"]);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name) && !name.startsWith("dist")) walk(p, out);
    } else if (CODE.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const FILES = ["server/src", "cabin-advisor", "scripts", "dashboard/src", "lib"]
  .flatMap((d) => walk(join(ROOT, d)))
  .map((p) => ({ rel: relative(ROOT, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));

/** The only files that may speak to the API directly. Each one stamps the job tag. */
const WRAPPERS = new Set([
  "server/src/lib/llm.ts",
  "server/src/lib/claude-core.mjs",
  "cabin-advisor/claude_bulk.py",
]);
const isTest = (rel: string) => /\.test\.ts$/.test(rel) || /(^|\/)test_[^/]+\.py$/.test(rel);

test("the guard actually sees the code it guards", () => {
  for (const must of ["server/src/lib/llm.ts", "cabin-advisor/generate-advice.mjs", "cabin-advisor/geometry-carnival.py"]) {
    assert.ok(FILES.some((f) => f.rel === must), `${must} was not scanned`);
  }
});

test("no Claude call outside the wrappers: api.anthropic.com appears only in llm.ts, claude-core.mjs and claude_bulk.py", () => {
  const offenders = FILES
    .filter((f) => !WRAPPERS.has(f.rel) && !isTest(f.rel) && f.text.includes("api.anthropic.com"))
    .map((f) => f.rel);
  assert.deepEqual(offenders, [], `hand-rolled Anthropic calls bypass the job tag and the bulk gate: ${offenders.join(", ")}`);
});

test("every job tag a script or route names is registered in llm-jobs.json", () => {
  const registered = new Set(Object.keys(JOBS.site));
  const used = new Set<string>();
  for (const f of FILES) {
    if (isTest(f.rel) || f.rel.endsWith("llm-guard.test.ts")) continue;
    for (const m of f.text.matchAll(/\bjob:\s*"([a-z][a-z0-9._-]*)"/g)) used.add(m[1]!);
    for (const m of f.text.matchAll(/(?:sync_call|interactive_call|run_bulk|preview|gate_or_exit|submit_batches|gate)\(\s*[^"')]*?"((?:cabin|site)\.[a-z0-9._-]+)"/g)) used.add(m[1]!);
    for (const m of f.text.matchAll(/(?:anthropicMessages|opinionJson)\(\s*"([a-z][a-z0-9._-]*)"/g)) used.add(m[1]!);
    for (const m of f.text.matchAll(/--job\s+([a-z][a-z0-9._-]*)/g)) used.add(m[1]!);
  }
  const missing = [...used].filter((j) => !registered.has(j));
  assert.deepEqual(missing, [], `unregistered job tags: ${missing.join(", ")}`);
  assert.ok(used.size >= 20, `expected to find the job tags in use, found ${used.size}`);
});

test("no retired Sonnet id is hard-coded as a model (Sonnet 5.5 is the workhorse since 2026-10-02)", () => {
  const offenders: string[] = [];
  for (const f of FILES) {
    if (WRAPPERS.has(f.rel) || isTest(f.rel)) continue; // the price tables name every model on purpose
    if (/["'`]claude-sonnet-(?:5|4[-\d]*|3[-\d.]*)["'`]/.test(f.text)) offenders.push(f.rel);
  }
  assert.deepEqual(offenders, []);
});
