// sitemap-core.test.ts — invariants for the hand-maintained public/sitemap.xml.
//
// 2026-09-20, task 4a7de4db ("accelerate crawl of the 6 unindexed/unfetched
// pages"). The task said to do it with a sitemap ping; Google retired that
// endpoint (it answers 404 now, Bing answers 410), so the pages were not waiting
// on a ping. Six of them had no <link rel="canonical"> at all — and it was
// exactly six — which is a standing reason for Google to park a URL as
// "discovered, currently not indexed". A seventh problem: /room-concierge.html
// named /es/room-concierge.html as its hreflang alternate while that page had no
// <url> entry of its own, so the annotation was not reciprocal and the Spanish
// page was never actually submitted.
//
// These assertions are cheap and they are the part that silently rots.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "../..");
const publicDir = join(serverDir, "public");
const ORIGIN = "https://stillafloatcruising.com";

const xml = readFileSync(join(publicDir, "sitemap.xml"), "utf8");
const blocks = xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
const locs = blocks.map((b) => b.match(/<loc>(.*?)<\/loc>/)?.[1] ?? "");

// news.html / es/news.html have no file in the repo: the news prerender writes
// them into public/ at run time, and feedPageHtml() emits their canonical. Their
// coverage lives in prerender-news.test.ts.
const GENERATED = new Set([`${ORIGIN}/news.html`, `${ORIGIN}/es/news.html`]);

const fileFor = (loc: string): string => {
  const rel = loc.replace(ORIGIN, "");
  return join(publicDir, rel.endsWith("/") ? `${rel}index.html` : rel);
};

describe("core sitemap", () => {
  it("lists a real file for every URL", () => {
    assert.ok(blocks.length > 0, "sitemap.xml has entries");
    for (const loc of locs) {
      assert.ok(loc.startsWith(ORIGIN), `${loc} is not on ${ORIGIN}`);
      if (GENERATED.has(loc)) continue;
      assert.ok(existsSync(fileFor(loc)), `${loc} has no file at ${fileFor(loc)}`);
    }
  });

  it("names each URL exactly once", () => {
    const dupes = locs.filter((l, i) => locs.indexOf(l) !== i);
    assert.deepEqual(dupes, [], `duplicate <loc> entries: ${dupes.join(", ")}`);
  });

  // The six that were missing one on 2026-09-20 were the six GSC had parked.
  it("every listed page carries a self-referencing canonical", () => {
    const missing: string[] = [];
    const wrong: string[] = [];
    for (const loc of locs) {
      if (GENERATED.has(loc)) continue;
      const html = readFileSync(fileFor(loc), "utf8");
      const href = html.match(/<link[^>]+rel="canonical"[^>]*>/i)?.[0]?.match(/href="([^"]+)"/)?.[1];
      if (!href) { missing.push(loc.replace(ORIGIN, "")); continue; }
      if (href !== loc) wrong.push(`${loc.replace(ORIGIN, "")} -> ${href}`);
    }
    assert.deepEqual(missing, [], `pages in the sitemap with no canonical: ${missing.join(", ")}`);
    assert.deepEqual(wrong, [], `canonical points somewhere else: ${wrong.join(", ")}`);
  });

  // Google only honours sitemap hreflang when the annotation comes back the
  // other way, which means every alternate needs its own <url> block.
  it("every hreflang alternate is itself submitted", () => {
    const orphans: string[] = [];
    for (const b of blocks) {
      const self = b.match(/<loc>(.*?)<\/loc>/)?.[1] ?? "";
      for (const m of b.matchAll(/<xhtml:link[^>]+href="([^"]+)"/g)) {
        if (!locs.includes(m[1] as string)) orphans.push(`${self.replace(ORIGIN, "")} -> ${(m[1] as string).replace(ORIGIN, "")}`);
      }
    }
    assert.deepEqual(orphans, [], `alternates with no <url> entry of their own: ${orphans.join(", ")}`);
  });

  // guides-sitemap.xml has been served with 14 guide pages in it since the
  // Cruising Guides build, and robots.txt named only two of the three sitemaps,
  // so nothing ever told a crawler those pages existed.
  it("robots.txt declares every sitemap we publish", () => {
    const robots = readFileSync(join(publicDir, "robots.txt"), "utf8");
    for (const name of ["sitemap.xml", "news-sitemap.xml", "guides-sitemap.xml"]) {
      assert.ok(
        robots.includes(`Sitemap: ${ORIGIN}/${name}`),
        `robots.txt does not declare ${name}`,
      );
    }
  });
});
