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
  hubPageHtml,
  hubRailHtml,
  isNoindex,
  railHubs,
  renderParagraphs,
  sitemapXml,
  storyPageHtml,
  storySlug,
  type NewsStory,
} from "./prerender-news";
import { hubBySlug } from "./news-hubs";

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

// ── the hub rail ─────────────────────────────────────────────────────────────
// Mark, 2026-09-12: the pill block above the stories pushed the news down the
// page. The hub links belong in a plain list down the right instead.
const line = (id: string, title: string, day: string): NewsStory => ({
  ...base,
  id,
  title,
  approvedAt: `2026-09-${day}T12:00:00.000Z`,
});
const feed: NewsStory[] = [
  line("c1", "Carnival Cancels a Celebration Key Call", "10"),
  line("c2", "Carnival Raises Its Gratuity Rate", "09"),
  line("c3", "Carnival Jubilee Shifts Its Drydock", "08"),
  line("r1", "Wonder of the Seas Skips Nassau", "07"),
  line("r2", "Royal Caribbean Adds a Perfect Day Pass", "06"),
  line("r3", "Royal Caribbean Trims Its Drink Package", "05"),
  line("p1", "Princess Names a New Captain", "04"),
];
const assignments = {
  c1: ["carnival"], c2: ["carnival"], c3: ["carnival"],
  r1: ["royal-caribbean"], r2: ["royal-caribbean"], r3: ["royal-caribbean"],
  p1: ["princess"],
};

describe("hub rail", () => {
  it("is a plain list of links, not a row of pills", () => {
    const rail = hubRailHtml(feed, "en", assignments);
    assert.match(rail, /<aside class="hub-rail"/);
    assert.doesNotMatch(rail, /hub-nav/, "the pill nav is gone");
    assert.doesNotMatch(rail, /border-radius:999px/, "no pills in the rail");
    assert.doesNotMatch(rail, /style=/, "the rail is styled by class, not inline");
    assert.match(rail, /<a href="\/news\/carnival.html">Carnival Cruise Line<\/a>/);
  });
  it("only lists a line once it has real coverage, best-covered first", () => {
    const hubs = railHubs(feed, assignments).map((h) => h.slug);
    assert.deepEqual(hubs, ["carnival", "royal-caribbean"]);
    assert.ok(!hubs.includes("princess"), "one story is a thin page, not a rail entry");
    assert.equal(hubRailHtml([], "en", {}), "", "no covered lines = no rail");
  });
  it("marks the line the reader is already on", () => {
    const rail = hubRailHtml(feed, "en", assignments, "carnival");
    assert.match(rail, /href="\/news\/carnival.html" aria-current="page"/);
    assert.doesNotMatch(rail, /royal-caribbean.html" aria-current/);
  });
  it("the Spanish rail links to the Spanish hubs", () => {
    const rail = hubRailHtml(feed, "es", assignments);
    assert.match(rail, /href="\/es\/news\/carnival.html"/);
    assert.match(rail, /Noticias por naviera/);
  });
  it("a hub page puts the stories first and the rail after, so it stacks below on a phone", () => {
    const hub = hubBySlug("carnival")!;
    const html = hubPageHtml(hub, feed.slice(0, 3), "en", hubRailHtml(feed, "en", assignments, "carnival"));
    assert.match(html, /<div class="news-cols">/);
    assert.ok(
      html.indexOf('class="news-col-main"') < html.indexOf('class="hub-rail"'),
      "stories come before the rail in the markup",
    );
    assert.match(html, /\.news-cols\{display:grid/, "the two-column rule ships with the page");
  });
});

describe("story page links up to its line", () => {
  const hub = hubBySlug("carnival")!;
  it("offers the line hub beside the feed link, and names the line over the related list", () => {
    const html = storyPageHtml(feed[0]!, storySlug(feed[0]!), "en", feed.slice(1, 3), undefined, [hub]);
    assert.match(html, /<a href="\/news\/carnival.html">More Carnival Cruise Line news<\/a>/);
    assert.match(html, /<h2>More Carnival Cruise Line news<\/h2>/);
  });
  it("falls back to the generic heading when the story is on no line", () => {
    const html = storyPageHtml(feed[0]!, storySlug(feed[0]!), "en", feed.slice(1, 3));
    assert.match(html, /<h2>More cruise news<\/h2>/);
    assert.doesNotMatch(html, /More Carnival/, "no hub link when the story has no line");
  });
  it("the Spanish story page uses the Spanish label and hub", () => {
    const html = storyPageHtml(feed[0]!, storySlug(feed[0]!), "es", feed.slice(1, 3), undefined, [hub]);
    assert.match(html, /href="\/es\/news\/carnival.html">Más noticias de Carnival</);
  });
});
