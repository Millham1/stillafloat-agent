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
  CARD_TEASER_CHARS,
  FEED_BATCH,
  cardTeaser,
  feedPageHtml,
  teaser,
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
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
  it("on a phone the rail lifts back above the stories instead of falling to the page bottom", () => {
    // DOM order puts the rail last, which on one column would bury it under
    // every story and the archive — roughly 20,000px down on the live feed.
    const css = hubPageHtml(hubBySlug("carnival")!, feed.slice(0, 3), "en", hubRailHtml(feed, "en", assignments));
    assert.match(css, /@media\(max-width:900px\)\{\.news-cols\{display:flex;flex-direction:column\}\.hub-rail\{order:-1/);
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

// A TDZ hole tsc will not catch: the hub assignments are read inside the
// story-page loop, which is a nested block, so a use BEFORE the declaration
// compiles clean and then throws "Cannot access 'hubAssignmentsForPages'
// before initialization" at the first prerender tick on the box — which is how
// this shipped to dev on 2026-09-12. The order is the contract.
describe("prerender order", () => {
  it("classifies stories before any page reads the assignments", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../src/lib/prerender-news.ts"),
      "utf8",
    );
    const declared = src.indexOf("const hubAssignmentsForPages = classified.assignments");
    const firstUse = src.indexOf("hubAssignmentsForPages[");
    assert.ok(declared > 0, "the assignments are still declared in runNewsPrerender");
    assert.ok(firstUse > 0, "a page still reads the assignments");
    assert.ok(declared < firstUse, "assignments must be computed before the first page reads them");
  });
});

// ── the original mapping ─────────────────────────────────────────────────────
// Mark, 2026-09-13: news.html is the homepage's news compilation with every
// approved story; "Open Story Detail" opens the cliffnote, which carries his
// paragraph of the gist and the link to the source. On 2026-07-13 the card was
// switched to that full gist paragraph for SEO, which made the cliffnote a
// repeat of the feed. These tests hold the mapping in place.
describe("teaser", () => {
  it("passes short text through untouched", () => {
    assert.equal(teaser("Call the line before Friday."), "Call the line before Friday.");
    assert.equal(teaser(""), "");
  });
  it("packs whole sentences up to the limit and never ends mid-sentence", () => {
    const a = "The ship skips Nassau on both October sailings.";
    const b = "Guests get a $50 onboard credit per stateroom.";
    const c = "Anyone booked on a Bahamas excursion should rebook with the line directly, because third-party refunds are not guaranteed.";
    const out = teaser(`${a} ${b} ${c}`, 120);
    assert.equal(out, `${a} ${b}`);
    assert.ok(out.length <= 120);
  });
  it("does not treat an abbreviation as the end of a sentence", () => {
    const out = teaser("The U.S. Coast Guard held the ship for six hours at St. Maarten. Guests missed the island entirely. The line has not offered compensation yet.", 70);
    assert.ok(out.startsWith("The U.S. Coast Guard held the ship for six hours at St. Maarten"), out);
    assert.doesNotMatch(out, /^The U\.S\.$/);
  });
  it("starts a Spanish sentence at an inverted question mark", () => {
    const out = teaser("El barco cambia de puerto. ¿Qué significa para tu crucero? Llama a la naviera antes del viernes para confirmar tu excursión.", 60);
    assert.equal(out, "El barco cambia de puerto. ¿Qué significa para tu crucero?");
  });
  it("cuts one overlong sentence on a word, with an ellipsis", () => {
    const long = "Travelers booked on any of the affected sailings between October and December ".repeat(6).trim() + ".";
    const out = teaser(long, 100);
    assert.ok(out.length <= 100, String(out.length));
    assert.ok(out.endsWith("…"));
    assert.doesNotMatch(out, /\s…$/, "no dangling space before the ellipsis");
    assert.ok(long.startsWith(out.slice(0, -1)), "a cut, not a rewrite");
  });
  it("collapses paragraph breaks", () => {
    assert.equal(teaser("One.\n\nTwo."), "One. Two.");
  });
});

const gist = (id: string, n: number): NewsStory => ({
  ...base,
  id: `https://example.com/g${id}`,
  title: `Story ${id} headline`,
  summary: `GIST-${id}: Mark's paragraph of the gist for story ${id}, which belongs on the cliffnote page only.`,
  travelerImpact: `IMPACT-${id}: If you are booked, call the line. The change applies to every sailing this fall. Anyone on a shore excursion should rebook directly with the line rather than a third party.`,
  editorialReasoning: `TAKE-${id}: My read is that this sticks.`,
  approvedAt: new Date(Date.UTC(2026, 8, 1) - n * 3600_000).toISOString(),
});

describe("feed card", () => {
  it("shows the opening of what it means for you, never the gist", () => {
    const s = gist("a", 0);
    const text = cardTeaser(s, "en");
    assert.ok(text.startsWith("IMPACT-a: If you are booked, call the line."), text);
    assert.ok(text.length <= CARD_TEASER_CHARS);
    assert.doesNotMatch(text, /GIST-a/);
  });
  it("falls back to Mark's take, then to the gist only so a card is never blank", () => {
    assert.match(cardTeaser({ ...gist("b", 0), travelerImpact: "" }, "en"), /^TAKE-b/);
    assert.match(cardTeaser({ ...gist("c", 0), travelerImpact: "", editorialReasoning: "" }, "en"), /^GIST-c/);
  });
  it("the Spanish card uses the Spanish field", () => {
    const s = { ...gist("d", 0), travelerImpact_es: "IMPACTO-d: Si tienes reserva, llama a la naviera." } as NewsStory;
    assert.match(cardTeaser(s, "es"), /^IMPACTO-d/);
  });
});

describe("feed page", () => {
  const stories = Array.from({ length: 25 }, (_, i) => gist(String(i), i));
  const cardCount = (html: string): number => (html.match(/<article class="story[" ]/g) || []).length;

  for (const lang of ["en", "es"] as const) {
    const html = feedPageHtml(stories, lang);
    it(`${lang}: no story's gist appears anywhere on the feed`, () => {
      for (const s of stories) assert.doesNotMatch(html, new RegExp(`GIST-${s.id!.slice(-2).replace(/^g/, "")}:`));
      assert.doesNotMatch(html, /GIST-/);
    });
    it(`${lang}: every story is a card, and every story page stays linked`, () => {
      assert.equal(cardCount(html), stories.length);
      assert.doesNotMatch(html, /class="archive"/, "no bare link list");
      for (const s of stories) assert.ok(html.includes(`/news/${storySlug(s)}.html`), storySlug(s));
    });
    it(`${lang}: the first ${FEED_BATCH} show, the rest wait behind Load More`, () => {
      assert.equal((html.match(/<article class="story">/g) || []).length, FEED_BATCH);
      assert.equal((html.match(/<article class="story is-later">/g) || []).length, stories.length - FEED_BATCH);
      assert.match(html, /id="load-more-news"/);
      assert.match(html, lang === "es" ? />Cargar más historias</ : />Load More Stories</);
      assert.match(html, /\.js article\.story\.is-later\{display:none\}/, "hidden only when JavaScript runs");
      assert.ok(html.indexOf('classList.add("js")') < html.indexOf("<body>"), "the flag is set before the body parses");
    });
  }
  it("no Load More button when everything already fits", () => {
    const html = feedPageHtml(stories.slice(0, FEED_BATCH), "en");
    assert.doesNotMatch(html, /load-more-news/);
    assert.doesNotMatch(html, /<article class="story is-later">/, "no card is held back");
  });
});

describe("hub page follows the same mapping", () => {
  const stories = Array.from({ length: 14 }, (_, i) => gist(`h${i}`, i));
  const html = hubPageHtml(hubBySlug("carnival")!, stories, "en");
  it("teaser cards, no gist, Load More, no link list", () => {
    assert.doesNotMatch(html, /GIST-/);
    assert.match(html, /IMPACT-h0:/);
    assert.match(html, /id="load-more-news"/);
    assert.doesNotMatch(html, /class="archive"/);
  });
});

describe("cliffnote page carries the gist", () => {
  it("gist first, then what it means for you, then Mark's take, then the source", () => {
    const s = gist("p", 0);
    const page = storyPageHtml(s, storySlug(s), "en", []);
    // Measure inside the story body: the page's own meta description may quote
    // the gist too, which is correct — it is this page's description.
    const html = page.slice(page.indexOf('<div class="story-content">'));
    const at = (needle: string): number => {
      const i = html.indexOf(needle);
      assert.ok(i > 0, `missing: ${needle}`);
      return i;
    };
    const order = [at("GIST-p:"), at("IMPACT-p:"), at("TAKE-p:"), at(">Read Full Article<")];
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });
});
