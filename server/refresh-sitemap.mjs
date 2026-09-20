// refresh-sitemap.mjs — rewrite <lastmod> in public/sitemap.xml from git history.
//
// The core sitemap is hand-maintained (unlike news-sitemap.xml, which the news
// prerender generates). On 2026-09-20 every one of its 29 entries still claimed
// 2026-06-30 or 2026-07-12 while the pages had changed repeatedly since — a
// sitemap that says "nothing here has changed in three months" is a reason for
// Google not to re-fetch, and stale lastmod is the kind of signal Google learns
// to distrust and then ignores for the whole site.
//
// A date is taken from the newest commit that changed the file by more than a
// `?v=` cache-bust. Those bumps touch ~50 files at once (e759df0 did) and mean
// nothing to a reader, so dating a page from one would be the same lie in the
// other direction.
//
// Run from the server package:  node ./refresh-sitemap.mjs [--check]
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const sitemap = path.join(here, "public", "sitemap.xml");
const ORIGIN = "https://stillafloatcruising.com";
const CACHE_BUST = /^[+-].*\?v=[0-9a-zA-Z._-]+/;

const git = async (...args) =>
  (await pexec("git", args, { cwd: repo, maxBuffer: 32 * 1024 * 1024 })).stdout;

/** Newest commit date where this file changed by more than a ?v= bump. */
async function substantiveDate(file) {
  const log = await git("log", "--format=%H %ad", "--date=short", "--", file);
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha, date] = line.split(" ");
    const diff = await git("show", "--format=", "--unified=0", sha, "--", file);
    const changed = diff
      .split("\n")
      .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
    if (!changed.length) continue;
    if (changed.every((l) => CACHE_BUST.test(l))) continue;
    return date;
  }
  return null;
}

const fileFor = (loc) => {
  const rel = loc.replace(ORIGIN, "");
  return path.join("server", "public", rel.endsWith("/") ? `${rel}index.html` : rel);
};

const xml = await readFile(sitemap, "utf8");
const blocks = xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
let out = xml;
const drift = [];

for (const block of blocks) {
  const loc = block.match(/<loc>(.*?)<\/loc>/)?.[1];
  const was = block.match(/<lastmod>(.*?)<\/lastmod>/)?.[1];
  if (!loc || !was) continue;
  const now = await substantiveDate(fileFor(loc));
  if (!now || now === was) continue;
  drift.push({ loc: loc.replace(ORIGIN, ""), was, now });
  out = out.replace(block, block.replace(/<lastmod>.*?<\/lastmod>/, `<lastmod>${now}</lastmod>`));
}

if (!drift.length) {
  console.log("sitemap lastmod: up to date");
  process.exit(0);
}
for (const d of drift) console.log(`  ${d.loc.padEnd(40)} ${d.was} -> ${d.now}`);
if (process.argv.includes("--check")) {
  console.error(`\n${drift.length} entr${drift.length === 1 ? "y is" : "ies are"} stale — run: node ./refresh-sitemap.mjs`);
  process.exit(1);
}
await writeFile(sitemap, out);
console.log(`\nrewrote ${drift.length} lastmod value(s) in public/sitemap.xml`);
