// prerender-news.test.ts — the index policy and the deeper sections (2026-09-09).
//
// Search Console showed the site-wide collapse tracked Google refusing story pages
// outright ("Crawled - currently not indexed" on everything since mid-August). Two
// things changed in the prerender: Low-impact stories are no longer submitted to the
// index, and the two original sections render as paragraphs with a real
// modified-date signal, so the deepened back catalogue is re-read as new content.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isNoindex,
  renderParagraphs,
  sitemapXml,
  storyPageHtml,
  storySlug,
  type NewsStory,
} from "./prerender-news";

const base: NewsStory = {
  id: "https://example.com/story-1",
  title: "Royal Caribbean Cancels Serenade Alaska Sailing",
  summary: "Summary text.",
  travelerImpact: "If you are booked on the September 12 sailing, call the line before Friday.",
  editorialReasoning: "My read is that the propulsion fault is the real story.\n\nI would hold the booking.",
  impactLevel: "Medium",
  approvedAt: "2026-09-01T12:00:00.000Z",
  link: "https://example.com/story-1",
};
const low: NewsStory = { ...base, id: "https://example.com/story-2", title: "Line Names Chief Dog Officer", impactLevel: "Low" };

describe("index policy", () => {
  it("keeps Low-impact stories out of the index, Medium/High in", () => {
    assert.equal(isNoindex(low, storySlug(low), "en"), true);
    assert.equal(isNoindex(low, storySlug(low), "es"), true);
    assert.equal(isNoindex(base, storySlug(base), "en"), false);
    assert.equal(isNoindex({ ...base, impactLevel: "High" }, "x", "en"), false);
    assert.equal(isNoindex({ ...base, impactLevel: "" }, "x", "en"), false, "no level = no verdict = indexable");
  });
  it("an explicit seo-override pins a story either way", () => {
    assert.equal(isNoindex(low, "x", "en", { noindex: false }), false);
    assert.equal(isNoindex(base, "x", "en", { noindex: true }), true);
  });
  it("keeps the legacy zero-intent ES page out", () => {
    assert.equal(isNoindex(base, "carnival-s-website-is-down-for-18-hours-abc123", "es"), true);
    assert.equal(isNoindex(base, "carnival-s-website-is-down-for-18-hours-abc123", "en"), false);
  });
});

describe("story page", () => {
  it("writes the robots noindex meta only for pages the policy excludes", () => {
    assert.match(storyPageHtml(low, storySlug(low), "en", []), /<meta name="robots" content="noindex">/);
    assert.doesNotMatch(storyPageHtml(base, storySlug(base), "en", []), /<meta name="robots" content="noindex">/);
  });
  it("renders the two original sections as paragraphs, escaped", () => {
    const html = storyPageHtml({ ...base, travelerImpact: "Call <the> line.\n\nThen wait." }, storySlug(base), "en", []);
    assert.match(html, /<div class="traveler-impact-panel"><div class="tip-label">💡 What This Means For You<\/div><p>Call &lt;the&gt; line\.<\/p><p>Then wait\.<\/p><\/div>/);
    assert.match(html, /<div class="editorial-panel"><div class="tip-label">📝 Mark's Take<\/div><p>My read is that the propulsion fault is the real story\.<\/p><p>I would hold the booking\.<\/p><\/div>/);
  });
  it("carries contentUpdatedAt into dateModified so a rewritten page is re-read", () => {
    const html = storyPageHtml({ ...base, contentUpdatedAt: "2026-09-10T00:00:00.000Z" }, storySlug(base), "en", []);
    assert.match(html, /"dateModified":"2026-09-10T00:00:00.000Z"/);
    assert.doesNotMatch(storyPageHtml(base, storySlug(base), "en", []), /dateModified/);
  });
  it("the newer of contentUpdatedAt and the override's updatedAt wins", () => {
    const newerOverride = storyPageHtml({ ...base, contentUpdatedAt: "2026-09-10T00:00:00.000Z" }, storySlug(base), "en", [], { updatedAt: "2026-09-11T00:00:00.000Z" });
    assert.match(newerOverride, /"dateModified":"2026-09-11T00:00:00.000Z"/);
    const newerBody = storyPageHtml({ ...base, contentUpdatedAt: "2026-09-12T00:00:00.000Z" }, storySlug(base), "en", [], { updatedAt: "2026-09-11T00:00:00.000Z" });
    assert.match(newerBody, /"dateModified":"2026-09-12T00:00:00.000Z"/);
  });
});

describe("renderParagraphs", () => {
  it("splits on blank lines, joins single newlines, escapes, drops empties", () => {
    assert.equal(renderParagraphs("a\nb\n\n\n  c & d  \n\n"), "<p>a b</p><p>c &amp; d</p>");
    assert.equal(renderParagraphs(""), "");
  });
});

describe("news sitemap", () => {
  it("does not submit noindex pages, and dates rewritten pages by contentUpdatedAt", () => {
    const xml = sitemapXml([{ ...base, contentUpdatedAt: "2026-09-10T00:00:00.000Z" }, low]);
    const baseSlug = storySlug(base);
    const lowSlug = storySlug(low);
    assert.match(xml, new RegExp(`<loc>https://stillafloatcruising.com/news/${baseSlug}.html</loc><lastmod>2026-09-10</lastmod>`));
    assert.match(xml, new RegExp(`<loc>https://stillafloatcruising.com/es/news/${baseSlug}.html</loc>`));
    assert.doesNotMatch(xml, new RegExp(lowSlug), "a Low-impact story is not submitted in either language");
    assert.match(xml, /<loc>https:\/\/stillafloatcruising.com\/news.html<\/loc>/);
  });
  it("an override can pull a Low story back into the sitemap", () => {
    const xml = sitemapXml([low], { [String(low.id)]: { noindex: false } });
    assert.match(xml, new RegExp(storySlug(low)));
  });
});
