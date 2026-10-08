#!/usr/bin/env node
// e2e/run.mjs — run the whole-site sweep against one box.
//
//   node e2e/run.mjs --mode dev  --site http://127.0.0.1 --news http://127.0.0.1:3003 --ops http://127.0.0.1:5001
//   node e2e/run.mjs --mode prod --site https://stillafloatcruising.com --news http://127.0.0.1:3003 --ops http://127.0.0.1:5000
//
// Options
//   --mode dev|prod      prod is read-only: any write a check attempts is a failure
//   --site/--news/--ops  base addresses of the three services as seen from where this runs
//   --token-env NAME     environment variable holding the dashboard token (default AGENT_APPROVAL_TOKEN)
//   --only a,b           run only checks whose id starts with one of these (a partial run can never count as a PASS)
//   --json FILE|-        write the full result as JSON
//   --compare FILE       a previous result (same box); report what disappeared or changed
//   --concurrency N      checks in flight at once (default 3 — the sweep must not load the box)
//   --list               print every check and exit
//   --coverage           audit coverage against the source tree (needs the repo around this folder) and exit
//
// Exit code 0 only when every check passed (waived known failures aside), nothing was
// untestable, every check exercised what it claims to cover, and the run was complete.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCheck, lintCheck, redactUrl } from "./lib/harness.mjs";
import { snapshotOf, compareSnapshots, describeComparison } from "./lib/compare.mjs";
import { routeKeyMatches } from "./surface.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function loadChecks(e2eDir = here) {
  const dir = path.join(e2eDir, "checks");
  const checks = []; const problems = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^[a-z0-9][a-z0-9-]*\.mjs$/.test(x)).sort()) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    const list = mod.default;
    if (!Array.isArray(list)) { problems.push(`checks/${f} must export default an array of checks`); continue; }
    for (const c of list) { c.file = `e2e/checks/${f}`; checks.push(c); problems.push(...lintCheck(c)); }
  }
  const ids = checks.map((c) => c.id);
  for (const d of ids.filter((x, i) => ids.indexOf(x) !== i)) problems.push(`check id "${d}" is used twice`);
  return { checks, problems };
}

export function loadKnownFailures(e2eDir = here) {
  const p = path.join(e2eDir, "known-failures.json");
  if (!fs.existsSync(p)) return { list: [], problems: [] };
  const problems = []; let list = [];
  try { list = JSON.parse(fs.readFileSync(p, "utf8")).known || []; } catch (e) { problems.push(`known-failures.json is not valid JSON: ${e.message}`); }
  for (const k of list) {
    if (!k.id || !/^\d{4}-\d{2}-\d{2}$/.test(k.since || "") || !k.reason || k.reason.length < 25 || !k.decision) {
      problems.push(`known-failures.json: every entry needs id, since (YYYY-MM-DD), reason (a sentence) and decision (who accepted it and when): ${JSON.stringify(k).slice(0, 120)}`);
    }
  }
  return { list, problems };
}

function parseArgs(argv) {
  const a = { mode: "", site: "", news: "", ops: "", tokenEnv: "AGENT_APPROVAL_TOKEN", only: [], json: "", compare: "", concurrency: 3, list: false, coverage: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; const v = () => argv[++i];
    if (k === "--mode") a.mode = v(); else if (k === "--site") a.site = v().replace(/\/+$/, ""); else if (k === "--news") a.news = v().replace(/\/+$/, "");
    else if (k === "--ops") a.ops = v().replace(/\/+$/, ""); else if (k === "--token-env") a.tokenEnv = v(); else if (k === "--only") a.only = v().split(",").filter(Boolean);
    else if (k === "--json") a.json = v(); else if (k === "--compare") a.compare = v(); else if (k === "--concurrency") a.concurrency = Math.max(1, Number(v()) || 3);
    else if (k === "--list") a.list = true; else if (k === "--coverage") a.coverage = true;
    else { console.error(`unknown option ${k}`); process.exit(2); }
  }
  return a;
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { checks, problems: loadProblems } = await loadChecks();
  const known = loadKnownFailures();
  const setup = [...loadProblems, ...known.problems];

  if (args.coverage) {
    const { collectSurface, loadDeclared, auditCoverage } = await import("./surface.mjs");
    const repoRoot = path.resolve(here, "..");
    const audit = auditCoverage({ surface: collectSurface(repoRoot), declared: loadDeclared(here), checks });
    console.log(`Surface: ${audit.total} items · covered ${audit.covered} · exempt ${audit.exempt} · admitted gaps ${audit.gaps} (ceiling ${audit.ceiling})`);
    for (const p of [...setup, ...audit.problems]) console.log(`  ✗ ${p}`);
    process.exit(setup.length + audit.problems.length ? 1 : 0);
  }
  if (args.list) {
    for (const c of checks) console.log(`${c.id.padEnd(44)} [${c.modes.join(",")}] ${c.title}`);
    process.exit(setup.length ? 1 : 0);
  }
  if (args.mode !== "dev" && args.mode !== "prod") { console.error("--mode dev|prod is required"); process.exit(2); }
  if (!args.site) { console.error("--site <base address> is required"); process.exit(2); }

  // Record every request each check makes, so "covers" claims can be held to what really ran.
  const made = new Map(); // check id → [{method, pathname}]
  const recordingFetch = (id) => async (url, init = {}) => {
    try { const u = new URL(url); (made.get(id) || made.set(id, []).get(id)).push({ method: (init.method || "GET").toUpperCase(), pathname: u.pathname, host: u.host }); } catch { /* not a URL */ }
    return fetch(url, init);
  };

  const selected = checks.filter((c) => c.modes.includes(args.mode) && (!args.only.length || args.only.some((p) => c.id.startsWith(p))));
  const notForThisMode = checks.filter((c) => !c.modes.includes(args.mode));
  const startedAt = new Date().toISOString();
  const token = process.env[args.tokenEnv] || "";
  const bases = { site: args.site, news: args.news, ops: args.ops };

  const results = await pool(selected, args.concurrency, async (c) => {
    const r = await runCheck(c, { mode: args.mode, bases, token, fetchImpl: recordingFetch(c.id) });
    // a check must actually request every site endpoint and page it claims to cover
    if (r.status === "pass") {
      const reqs = made.get(c.id) || [];
      for (const k of c.covers) {
        const route = /^[A-Z]+ \/api\//.test(k); const page = k.startsWith("page ");
        if (!route && !page) continue;
        const hit = route ? reqs.some((q) => routeKeyMatches(k, q.method, q.pathname))
          : reqs.some((q) => q.method === "GET" && (q.pathname === k.slice(5) || (k.slice(5) === "/index.html" && q.pathname === "/") || (k.slice(5).endsWith("/index.html") && q.pathname === k.slice(5).replace(/index\.html$/, ""))));
        if (!hit) { r.status = "fail"; r.failures.push(`the check claims to cover "${k}" but never requested it — coverage it does not exercise is not coverage`); }
      }
    }
    return r;
  });

  const waivers = new Map(known.list.map((k) => [k.id, k]));
  for (const r of results) {
    const w = waivers.get(r.id);
    if (!w) continue;
    if (r.status === "pass") r.notes.push(`this check is on the known-failures list (since ${w.since}) but PASSES now — remove it from e2e/known-failures.json`);
    else { r.waived = { since: w.since, reason: w.reason, decision: w.decision }; r.statusBeforeWaiver = r.status; r.status = "waived"; }
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  const partial = args.only.length > 0;
  const summary = {
    pass: count("pass"), fail: count("fail"), untestable: count("untestable"), waived: count("waived"),
    total: results.length, notForThisMode: notForThisMode.length, setupProblems: setup.length, partial,
    result: (setup.length === 0 && count("fail") === 0 && count("untestable") === 0 && !partial && results.length > 0) ? "PASS" : "FAIL",
  };
  const run = { meta: { mode: args.mode, bases: Object.fromEntries(Object.entries(bases).map(([k, v]) => [k, redactUrl(v)])), startedAt, finishedAt: new Date().toISOString(), tokenSupplied: Boolean(token), only: args.only }, summary, setupProblems: setup, checks: results };

  if (args.compare) {
    try {
      const before = JSON.parse(fs.readFileSync(args.compare, "utf8"));
      run.comparison = compareSnapshots(snapshotOf(before), snapshotOf(run));
      run.comparison.against = { startedAt: before.meta?.startedAt, mode: before.meta?.mode };
    } catch (e) { setup.push(`could not read the --compare file: ${e.message}`); summary.result = "FAIL"; summary.setupProblems = setup.length; }
  }

  // ── human summary (stderr, so --json - stays clean) ──
  const say = (s = "") => process.stderr.write(`${s}\n`);
  say(`Whole-site sweep · ${args.mode.toUpperCase()} · ${redactUrl(args.site)} · ${startedAt}`);
  for (const p of setup) say(`  SETUP PROBLEM  ${p}`);
  for (const r of results.filter((x) => x.status === "fail" || x.status === "untestable")) {
    say(`  ${r.status === "fail" ? "FAIL      " : "UNTESTABLE"} ${r.id} — ${r.title}`);
    for (const f of r.failures) say(`               ${f}`);
  }
  for (const r of results.filter((x) => x.status === "waived")) say(`  KNOWN      ${r.id} — failing since ${r.waived.since}: ${r.waived.reason} (${r.waived.decision})`);
  for (const r of results) for (const n of r.notes) if (/remove it from/.test(n)) say(`  NOTE       ${r.id}: ${n}`);
  if (run.comparison) {
    const lines = describeComparison(run.comparison);
    say(lines.length ? `  Compared with the sweep of ${run.comparison.against.startedAt}:` : `  Compared with the sweep of ${run.comparison.against.startedAt}: nothing disappeared or changed.`);
    for (const l of lines.slice(0, 80)) say(`    ${l}`);
    if (lines.length > 80) say(`    … and ${lines.length - 80} more (see the JSON)`);
  }
  say(`  ${summary.pass} passed · ${summary.fail} failed · ${summary.untestable} untestable · ${summary.waived} known failures · ${results.reduce((n, r) => n + r.asserts, 0)} assertions · ${results.reduce((n, r) => n + r.requests, 0)} requests`);
  if (partial) say(`  PARTIAL RUN (--only ${args.only.join(",")}): a partial run never counts as a pass for a release.`);
  say(`  RESULT: ${summary.result}`);

  if (args.json) {
    const text = JSON.stringify(run, null, 1);
    if (args.json === "-") process.stdout.write(`${text}\n`); else fs.writeFileSync(args.json, text);
  }
  process.exit(summary.result === "PASS" ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
