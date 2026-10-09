// e2e-gate.test.ts — the whole-site suite (e2e/) is held to its own rules INSIDE the unit
// suite, so a broken or hollow check can never merge (Mark, 2026-10-04: "empty is not a
// pass"). This file does not run the checks against a site; it proves the checks are fit to
// run: every check lints, every check can FAIL (vacuity: none passes against a dead, empty,
// hollow or 404 site), the coverage audit is clean (every page/route/job is covered, exempt
// with a reason, or an admitted gap under the ceiling), and known-failures.json names only
// real checks with a reason and a decision.
//
// The e2e modules are plain ESM (.mjs) and are imported at RUNTIME via pathToFileURL, never
// statically: esbuild would otherwise bundle run.mjs and its main() guard into this test.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function findE2E(): string {
  let d = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(d, "e2e", "run.mjs"))) return path.join(d, "e2e");
    d = path.dirname(d);
  }
  throw new Error(`e2e/run.mjs not found above ${process.cwd()} — run the tests from server/ inside the monorepo`);
}
const e2eDir = findE2E();
const repoRoot = path.dirname(e2eDir);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (rel: string): Promise<any> => import(pathToFileURL(path.join(e2eDir, rel)).href);

test("every e2e check file loads, exports an array, and every check passes lint", async () => {
  const { loadChecks } = await load("run.mjs");
  const { checks, problems } = await loadChecks(e2eDir);
  assert.deepEqual(problems, [], "lint problems in e2e/checks");
  assert.ok(checks.length >= 100, `expected the whole-site suite (100+ checks), found ${checks.length}`);
  for (const c of checks) {
    assert.ok(c.modes.includes("dev") || c.prodOnlyBecause, `${c.id} skips dev without saying why`);
  }
});

test("known-failures.json is well-formed and names only checks that still exist", async () => {
  const { loadChecks, loadKnownFailures } = await load("run.mjs");
  const { checks } = await loadChecks(e2eDir);
  const known = loadKnownFailures(e2eDir);
  assert.deepEqual(known.problems, [], "every entry needs id, since, reason and decision");
  const ids = new Set(checks.map((c: { id: string }) => c.id));
  for (const k of known.list) {
    assert.ok(ids.has(k.id), `known-failures.json lists "${k.id}", which is no longer a check — remove the entry`);
    assert.match(k.decision, /Mark/, `${k.id}: the decision must say who accepted it (Mark) and when`);
  }
});

test("coverage audit: every page, API route and job is covered, exempt with a reason, or an admitted gap under the ceiling", async () => {
  const { loadChecks } = await load("run.mjs");
  const { collectSurface, loadDeclared, auditCoverage } = await load("surface.mjs");
  const { checks } = await loadChecks(e2eDir);
  const audit = auditCoverage({ surface: collectSurface(repoRoot), declared: loadDeclared(e2eDir), checks });
  assert.deepEqual(audit.problems, [], "coverage problems");
  assert.ok(audit.total > 200, `surface looks truncated: ${audit.total} items`);
  assert.equal(typeof audit.ceiling, "number", "coverage/_ceiling.json must set max_gaps");
  assert.ok(audit.gaps <= audit.ceiling, `${audit.gaps} admitted gaps exceed the ceiling ${audit.ceiling}`);
});

test("vacuity: no check passes against a dead, empty, hollow or 404 site (dev and prod modes)", async () => {
  const { loadChecks } = await load("run.mjs");
  const { hollowChecks } = await load("lib/vacuity.mjs");
  const { checks } = await loadChecks(e2eDir);
  const bad = [...(await hollowChecks(checks, "dev")), ...(await hollowChecks(checks.filter((c: { modes: string[] }) => !c.modes.includes("dev")), "prod"))];
  assert.deepEqual(bad, [], "these checks PASS when the site returns nothing — they test nothing");
});
