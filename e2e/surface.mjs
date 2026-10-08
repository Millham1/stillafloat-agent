// e2e/surface.mjs — what the site IS, read from the source tree.
//
// "Coverage grows with the site" only works if nobody has to remember to update a list.
// This module derives the surface from the code — every API route, every public page,
// every scheduled job — and the unit suite (server/src/e2e-gate.test.ts) fails the build
// when any item has neither a whole-site check nor a written, dated reason for not having
// one. Add a route, a page or a job and the build tells you what the gate is missing.

import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(p, "utf8");
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};

/** Every `router.<verb>("<path>", …)` in server/src/routes. */
export function collectRoutes(repoRoot) {
  const dir = path.join(repoRoot, "server", "src", "routes");
  const routes = []; const problems = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts").sort()) {
    const src = read(path.join(dir, file));
    // a route whose path is not a plain string cannot be listed — refuse it
    for (const m of src.matchAll(/\brouter\.(get|post|put|patch|delete)\(\s*(?!["'`])([^,\n]{1,60})/g)) {
      problems.push(`${file}: router.${m[1]}(${m[2].trim()}… — the path must be a string literal so the release gate can list it`);
    }
    for (const m of src.matchAll(/\brouter\.use\(\s*["'`]([^"'`]+)["'`]/g)) {
      problems.push(`${file}: router.use("${m[1]}", …) mounts routes under a prefix the release gate cannot follow`);
    }
    const seen = new Set();
    for (const m of src.matchAll(/\brouter\.(get|post|put|patch|delete)\(\s*(["'`])([^"'`]+)\2/g)) {
      const [, verb, , p] = m;
      // the middleware and the first lines of the handler: enough to see a token check
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 400);
      const key = `${verb.toUpperCase()} /api${p}`;
      if (seen.has(key)) { problems.push(`${file}: ${key} is defined twice — the second definition never runs`); continue; }
      seen.add(key);
      routes.push({
        key, method: verb.toUpperCase(), path: `/api${p}`, file: `server/src/routes/${file}`,
        gated: /\brequire[A-Z]\w*|\bcanaryAuth\b|\btokenOk\(|\bverif\w*Token\b|status\(401\)/.test(after.split(/\n\s*router\./)[0]),
      });
    }
  }
  return { routes, problems };
}

/** Every tracked HTML page under server/public (generated story/guide pages are not in git). */
export function collectPages(repoRoot) {
  const dir = path.join(repoRoot, "server", "public");
  return walk(dir)
    .filter((p) => p.endsWith(".html"))
    .map((p) => `/${path.relative(dir, p).split(path.sep).join("/")}`)
    .sort()
    .map((p) => ({ key: `page ${p}`, path: p }));
}

/** Every scheduled job the website server starts (function schedule…() in index.ts). */
export function collectJobs(repoRoot) {
  const src = read(path.join(repoRoot, "server", "src", "index.ts"));
  const names = [...new Set([...src.matchAll(/\bfunction\s+(schedule[A-Z]\w*)\s*\(/g)].map((m) => m[1]))].sort();
  return names.map((name) => ({ key: `job ${name}`, name }));
}

/** The declared extras: things the code reader cannot see (other services, emails, flows). */
export function loadDeclared(e2eDir) {
  const dir = path.join(e2eDir, "coverage");
  const extra = {}; const exempt = {}; const gaps = {}; const problems = [];
  let ceiling = null;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    let j;
    try { j = JSON.parse(read(path.join(dir, f))); } catch (e) { problems.push(`coverage/${f} is not valid JSON: ${e.message}`); continue; }
    if (f === "_ceiling.json") { ceiling = j; continue; }
    const put = (target, key, value, kind) => {
      if (key in extra && kind !== "extra") { /* extras may be exempted or gapped */ }
      if (key in target) problems.push(`coverage/${f}: "${key}" is listed twice as ${kind}`);
      target[key] = value;
    };
    for (const [k, v] of Object.entries(j.extra || {})) put(extra, k, v, "extra");
    for (const [k, v] of Object.entries(j.exempt || {})) put(exempt, k, v, "exempt");
    for (const [k, v] of Object.entries(j.gaps || {})) put(gaps, k, v, "gap");
  }
  return { extra, exempt, gaps, ceiling, problems };
}

export function collectSurface(repoRoot) {
  const { routes, problems } = collectRoutes(repoRoot);
  const pages = collectPages(repoRoot);
  const jobs = collectJobs(repoRoot);
  return { routes, pages, jobs, problems, keys: [...routes.map((r) => r.key), ...pages.map((p) => p.key), ...jobs.map((j) => j.key)] };
}

const EXTRA_PREFIX = /^(ext:|email:|flow:|push:|data:)/;

/**
 * The coverage audit. Returns { problems[], covered, exempt, gaps, total }.
 * A surface item must be exactly one of:
 *   covered — at least one check names it in covers[] and that check runs on DEV
 *   exempt  — a written reason why a whole-site check does not apply
 *   gap     — an admitted hole, with a reason and the date it was admitted
 * Gaps may only shrink: their count is capped by coverage/_ceiling.json.
 */
export function auditCoverage({ surface, declared, checks }) {
  const problems = [...surface.problems, ...declared.problems];
  const all = new Set([...surface.keys, ...Object.keys(declared.extra)]);
  const coveredBy = new Map();
  for (const c of checks) for (const k of c.covers || []) {
    if (!all.has(k)) problems.push(`check ${c.id} says it covers "${k}", which is not a page, endpoint or job in the code and is not declared in coverage/*.json "extra"`);
    if (!coveredBy.has(k)) coveredBy.set(k, []);
    coveredBy.get(k).push(c);
  }
  for (const k of Object.keys(declared.extra)) if (!EXTRA_PREFIX.test(k)) problems.push(`extra surface "${k}" must start with ext:, email:, flow:, push: or data:`);
  for (const [k, why] of Object.entries(declared.exempt)) {
    if (!all.has(k)) problems.push(`exempt entry "${k}" no longer exists in the code — remove it`);
    if (typeof why !== "string" || why.trim().length < 25) problems.push(`exempt entry "${k}" needs a real reason (at least a sentence)`);
    if (coveredBy.has(k)) problems.push(`"${k}" is both exempt and covered by ${coveredBy.get(k).map((c) => c.id).join(", ")} — remove the exemption`);
  }
  for (const [k, g] of Object.entries(declared.gaps)) {
    if (!all.has(k)) problems.push(`gap entry "${k}" no longer exists in the code — remove it`);
    if (!g || typeof g.reason !== "string" || g.reason.trim().length < 25 || !/^\d{4}-\d{2}-\d{2}$/.test(g.since || "")) problems.push(`gap entry "${k}" needs { "reason": "<a sentence>", "since": "YYYY-MM-DD" }`);
    if (coveredBy.has(k)) problems.push(`"${k}" is listed as a gap but ${coveredBy.get(k).map((c) => c.id).join(", ")} covers it — remove the gap`);
    if (k in declared.exempt) problems.push(`"${k}" is listed as both exempt and a gap`);
  }
  let covered = 0;
  for (const k of all) {
    const cs = coveredBy.get(k) || [];
    if (cs.length) {
      covered++;
      if (!cs.some((c) => c.modes.includes("dev"))) problems.push(`"${k}" is only checked on prod — dev is the mirror; it must be checked there before a release`);
      continue;
    }
    if (k in declared.exempt || k in declared.gaps) continue;
    problems.push(`NOT COVERED: "${k}" has no whole-site check. Add a check that covers it, or record why not in e2e/coverage/*.json`);
  }
  const gapCount = Object.keys(declared.gaps).length;
  const max = declared.ceiling?.max_gaps;
  if (typeof max !== "number") problems.push(`coverage/_ceiling.json must set { "max_gaps": <number> }`);
  else if (gapCount > max) problems.push(`there are ${gapCount} admitted gaps but the ceiling is ${max}. Gaps may only shrink: write the missing check instead of adding a gap`);
  return { problems, total: all.size, covered, exempt: Object.keys(declared.exempt).length, gaps: gapCount, ceiling: max ?? null };
}

/** Does a request made during a run exercise a declared route key like "GET /api/storm-watch/:id"? */
export function routeKeyMatches(key, method, pathname) {
  const m = /^([A-Z]+) (\/\S*)$/.exec(key);
  if (!m || m[1] !== method) return false;
  const re = new RegExp(`^${m[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\/:[A-Za-z0-9_]+\\\?/g, "(?:/[^/]+)?").replace(/:[A-Za-z0-9_]+/g, "[^/]+")}/?$`);
  return re.test(pathname);
}
