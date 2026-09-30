// llms-txt.test.ts — /llms.txt built from the published guides and live news
// hubs (2026-09-29). Holds the order (Work with Mark first), the approved bio
// sentence verbatim, and that every link is absolute and points at a page the
// site actually serves.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLlmsTxt, liveHubs, LLMS_SUMMARY, type LlmsHub } from "./llms-txt";
import { publishedGuides, type Guide } from "./prerender-guides";

const GUIDES: Guide[] = [
  {
    slug: "drink-packages", sort: 2, title: "Are Drink Packages Worth It?", hook: "Run the numbers\nbefore you buy.",
    bodyHtml: "<p>x</p>", title_es: "¿Vale la pena el paquete de bebidas?", hook_es: "Saca las cuentas.", bodyHtml_es: "<p>x</p>",
  },
  { slug: "first-cruise", sort: 1, title: "Your [First] Cruise", seoDesc: "Where to start.", bodyHtml: "<p>x</p>" },
  { slug: "como-elegir", sort: 3, title_es: "Cómo elegir tu primer crucero", hook_es: "Paso a paso.", bodyHtml_es: "<p>x</p>" },
  // A tool tile: its page is listed under Tools, never as a guide.
  { slug: "room-concierge", sort: 0, title: "Room Concierge", toolHref: "/room-concierge.html" },
  { slug: "draft", title: "Unpublished draft", bodyHtml: "<p>x</p>", published: false },
];

const HUBS: LlmsHub[] = [
  {
    slug: "carnival",
    en: { title: "Carnival Cruise News", desc: "Carnival Cruise news, read the way a cruiser needs it." },
    es: { title: "Noticias de Carnival", desc: "Noticias de Carnival Cruise Line." },
  },
  { slug: "royal-caribbean", en: { title: "Royal Caribbean News", desc: "Royal Caribbean news." } },
];

const text = buildLlmsTxt({ guides: publishedGuides(GUIDES), hubs: HUBS });
const lines = text.split("\n");
const headings = lines.filter((l) => l.startsWith("#"));

describe("buildLlmsTxt", () => {
  it("opens with the H1 and the approved bio sentence, verbatim", () => {
    assert.equal(lines[0], "# Still Afloat Cruising");
    assert.equal(lines[2], LLMS_SUMMARY);
    assert.ok(LLMS_SUMMARY.startsWith("> Still Afloat is a cruise travel-advisory and content brand run by Mark — a retired IT manager"));
  });

  it("puts Work with Mark first, then guides, hubs, content, tools, gear, Spanish, policies", () => {
    assert.deepEqual(headings, [
      "# Still Afloat Cruising",
      "## Work with Mark",
      "## Guides",
      "## Cruise line news hubs",
      "## Content",
      "## Tools",
      "## Gear (affiliate)",
      "## Spanish (es-419)",
      "## Policies",
    ]);
  });

  it("links both advisor pages and the offer under Work with Mark", () => {
    const section = text.split("## Work with Mark")[1]!.split("## Guides")[0]!;
    assert.match(section, /\(https:\/\/stillafloatcruising\.com\/work-with-mark\.html\)/);
    assert.match(section, /\(https:\/\/stillafloatcruising\.com\/work-with-mark\.html#contact\)/);
    assert.match(section, /\(https:\/\/stillafloatcruising\.com\/es\/work-with-mark\.html\)/);
    assert.match(section, /Cornerstone Collective/);
  });

  it("lists every published guide in each language it exists in, in display order", () => {
    const section = text.split("## Guides")[1]!.split("## Cruise line news hubs")[0]!;
    const links = [...section.matchAll(/\((https:[^)]+)\)/g)].map((m) => m[1]);
    assert.deepEqual(links, [
      "https://stillafloatcruising.com/guides.html",
      "https://stillafloatcruising.com/guides/first-cruise.html",
      "https://stillafloatcruising.com/guides/drink-packages.html",
      "https://stillafloatcruising.com/es/guides.html",
      "https://stillafloatcruising.com/es/guides/drink-packages.html",
      "https://stillafloatcruising.com/es/guides/como-elegir.html",
    ]);
    assert.match(section, /- \[Are Drink Packages Worth It\?\]\(https:\/\/stillafloatcruising\.com\/guides\/drink-packages\.html\): Run the numbers before you buy\.\n/);
    // No hook: the SEO description stands in. Brackets in a title would end the link text.
    assert.match(section, /- \[Your First Cruise\]\([^)]+\): Where to start\./);
    assert.doesNotMatch(section, /Unpublished draft|room-concierge/);
  });

  it("lists each hub in the languages it has a page in", () => {
    const section = text.split("## Cruise line news hubs")[1]!.split("## Content")[0]!;
    const links = [...section.matchAll(/\((https:[^)]+)\)/g)].map((m) => m[1]);
    assert.deepEqual(links, [
      "https://stillafloatcruising.com/news/carnival.html",
      "https://stillafloatcruising.com/news/royal-caribbean.html",
      "https://stillafloatcruising.com/es/news/carnival.html",
    ]);
  });

  it("names the tools", () => {
    const section = text.split("## Tools")[1]!.split("## Gear")[0]!;
    for (const p of ["wheres-my-ship.html", "room-concierge.html", "weather.html", "webcams.html"]) {
      assert.ok(section.includes(`(https://stillafloatcruising.com/${p})`), p);
    }
  });

  it("every link is an absolute stillafloatcruising.com URL", () => {
    const links = [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!);
    assert.ok(links.length > 20);
    for (const l of links) assert.match(l, /^https:\/\/stillafloatcruising\.com\//, l);
  });

  it("with no data yet, still a complete file: no hub section, guide index links kept", () => {
    const empty = buildLlmsTxt({ guides: [], hubs: [] });
    assert.ok(!empty.includes("## Cruise line news hubs"));
    assert.ok(empty.includes("(https://stillafloatcruising.com/guides.html)"));
    assert.ok(empty.includes("## Work with Mark"));
    assert.ok(empty.endsWith("\n"));
  });
});

describe("liveHubs", () => {
  it("lists only hubs whose page is on disk, per language", () => {
    const dir = mkdtempSync(join(tmpdir(), "llms-"));
    try {
      mkdirSync(join(dir, "news"), { recursive: true });
      mkdirSync(join(dir, "es", "news"), { recursive: true });
      writeFileSync(join(dir, "news", "carnival.html"), "");
      writeFileSync(join(dir, "es", "news", "carnival.html"), "");
      writeFileSync(join(dir, "news", "royal-caribbean.html"), "");
      const hubs = liveHubs(dir);
      const got = hubs.map((h) => [h.slug, Boolean(h.en), Boolean(h.es)]).sort();
      assert.deepEqual(got, [["carnival", true, true], ["royal-caribbean", true, false]]);
      assert.match(hubs.find((h) => h.slug === "carnival")!.en!.title, /Carnival/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
