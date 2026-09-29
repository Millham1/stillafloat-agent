// site-identity.test.ts — one entity graph across the whole site (2026-09-29).
//
// The generated pages (guides, news) only REFERENCE the Person and the
// Organization by @id; the full nodes live in four hand-edited static pages.
// A reference to an @id nobody declares, or a static page whose Organization
// quietly disagrees with the one the generators point at, is exactly the split
// identity this program set out to fix — so the static pages are parsed here
// and held to lib/site-identity.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ORG_ID, PERSON_ID, ORG_NAME, ORG_LEGAL_NAME, PERSON_NAME, SAME_AS, PERSON_SAME_AS, WORK_WITH_MARK,
  authorRef, organizationNode, publisherRef,
} from "./site-identity";
import { guideJsonLd, type Guide } from "./prerender-guides";
import { storyPageHtml, storySlug, type NewsStory } from "./prerender-news";

// Built to dist-test/lib/, so the site is two levels up.
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "../../public");

type Node = Record<string, unknown>;

function ldBlocks(html: string): Node[] {
  const out: Node[] = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const data = JSON.parse(m[1]!) as Node;
    const graph = data["@graph"];
    if (Array.isArray(graph)) out.push(...(graph as Node[]));
    else out.push(data);
  }
  return out;
}

function page(rel: string): { html: string; nodes: Node[] } {
  const html = readFileSync(join(PUBLIC, rel), "utf8");
  return { html, nodes: ldBlocks(html) };
}

function byId(nodes: Node[], id: string): Node | undefined {
  return nodes.find((n) => n["@id"] === id);
}

/** The Organization fields every page must agree on (index pages add a description). */
function orgCore(n: Node | undefined): Node {
  assert.ok(n, "Organization node missing");
  const { description: _d, ...rest } = n;
  return rest;
}

describe("static pages declare the same Organization", () => {
  for (const rel of ["index.html", "es/index.html", "work-with-mark.html", "es/work-with-mark.html"]) {
    it(rel, () => {
      const { nodes } = page(rel);
      assert.deepEqual(orgCore(byId(nodes, ORG_ID)), organizationNode());
    });
  }

  it("the home pages' WebSite nodes are published by it", () => {
    for (const rel of ["index.html", "es/index.html"]) {
      const site = page(rel).nodes.find((n) => n["@type"] === "WebSite");
      assert.deepEqual(site?.["publisher"], { "@id": ORG_ID }, rel);
    }
    const es = page("es/index.html").nodes.find((n) => n["@type"] === "WebSite");
    assert.equal(es?.["inLanguage"], "es-419");
  });
});

describe("work-with-mark declares Mark", () => {
  for (const rel of ["work-with-mark.html", "es/work-with-mark.html"]) {
    it(`${rel}: Person, affiliation, service`, () => {
      const { nodes } = page(rel);
      const mark = byId(nodes, PERSON_ID);
      assert.ok(mark, "Person node missing");
      assert.equal(mark["@type"], "Person");
      assert.equal(mark["name"], PERSON_NAME);
      assert.equal(mark["url"], WORK_WITH_MARK);
      assert.equal(mark["jobTitle"], "Independent Cruise Advisor");
      assert.deepEqual(mark["worksFor"], { "@type": "Organization", name: "Cornerstone Collective" });
      assert.deepEqual(mark["affiliation"], { "@id": ORG_ID });
      assert.deepEqual(mark["sameAs"], [...PERSON_SAME_AS]);
      // Mark's own languages: English only until he confirms Spanish (the Spanish
      // site is served by the advisory service, which keeps ["en","es"] below).
      assert.deepEqual(mark["knowsLanguage"], ["en"]);

      const service = nodes.find((n) => n["@type"] === "TravelAgency");
      assert.ok(service, "TravelAgency node missing");
      assert.equal(service["url"], WORK_WITH_MARK);
      assert.equal(service["areaServed"], "US");
      assert.deepEqual(service["employee"], { "@id": PERSON_ID });
      assert.deepEqual((service["contactPoint"] as Node)["availableLanguage"], ["en", "es"]);
    });
  }

  it("both languages carry the identical graph", () => {
    assert.deepEqual(page("work-with-mark.html").nodes, page("es/work-with-mark.html").nodes);
  });

  it("never states a years-of-experience number in the markup", () => {
    const json = JSON.stringify(page("work-with-mark.html").nodes);
    assert.doesNotMatch(json, /\d+\+?\s*(years|años)/i);
  });

  it("the English page now has the hreflang pair the Spanish page already had", () => {
    const { html } = page("work-with-mark.html");
    assert.match(html, /<link rel="alternate" hreflang="en" href="https:\/\/stillafloatcruising\.com\/work-with-mark\.html">/);
    assert.match(html, /<link rel="alternate" hreflang="es-419" href="https:\/\/stillafloatcruising\.com\/es\/work-with-mark\.html">/);
    assert.match(html, /<link rel="alternate" hreflang="x-default" href="https:\/\/stillafloatcruising\.com\/work-with-mark\.html">/);
  });
});

describe("generated pages credit Mark and reference the declared nodes", () => {
  it("the references point at @ids the static pages declare", () => {
    assert.equal(authorRef()["@id"], PERSON_ID);
    assert.equal(publisherRef()["@id"], ORG_ID);
    assert.equal(publisherRef()["name"], ORG_NAME);
    assert.ok(byId(page("work-with-mark.html").nodes, PERSON_ID));
    assert.ok(byId(page("index.html").nodes, ORG_ID));
    assert.equal(organizationNode()["legalName"], ORG_LEGAL_NAME);
  });

  it("a guide: author = Mark, publisher = the Organization, the rest kept", () => {
    const guide: Guide = { slug: "drink-packages", title: "Are Drink Packages Worth It?", hook: "Run the numbers first.", bodyHtml: "<p>x</p>", updatedAt: "2026-09-20T00:00:00.000Z" };
    for (const lang of ["en", "es"] as const) {
      const ld = JSON.parse(guideJsonLd({ ...guide, title_es: "¿Vale la pena?", bodyHtml_es: "<p>x</p>" }, "drink-packages", lang)) as Node;
      assert.equal(ld["@type"], "Article");
      assert.deepEqual(ld["author"], [authorRef()]);
      assert.deepEqual(ld["publisher"], publisherRef());
      assert.equal(ld["dateModified"], "2026-09-20T00:00:00.000Z");
      assert.equal(ld["inLanguage"], lang === "es" ? "es-419" : "en-US");
    }
  });

  it("a news story: author = Mark, publisher = the Organization, the rest kept", () => {
    const story: NewsStory = {
      id: "https://example.com/story-1",
      title: "Royal Caribbean Cancels Serenade Alaska Sailing",
      summary: "Summary text.",
      approvedAt: "2026-09-10T12:00:00.000Z",
      originalLink: "https://example.com/story-1",
    };
    const [ld] = ldBlocks(storyPageHtml(story, storySlug(story), "en", []));
    assert.equal(ld?.["@type"], "NewsArticle");
    assert.deepEqual(ld?.["author"], [authorRef()]);
    assert.deepEqual(ld?.["publisher"], publisherRef());
    assert.equal(ld?.["isBasedOn"], "https://example.com/story-1");
    assert.equal(ld?.["datePublished"], "2026-09-10T12:00:00.000Z");
  });
});
