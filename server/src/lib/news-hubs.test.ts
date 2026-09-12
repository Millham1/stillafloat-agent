// news-hubs.test.ts — a story lands on the right line's hub, or on neither.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NEWS_HUBS, hubBySlug, matchesHub, storiesForHub, hubPath, MIN_HUB_STORIES } from "./news-hubs";

const carnival = hubBySlug("carnival")!;
const royal = hubBySlug("royal-caribbean")!;
const s = (title: string, extra: Record<string, unknown> = {}) => ({ id: title.slice(0, 24), title, approvedAt: "2026-09-10T12:00:00Z", ...extra });

describe("hub matching", () => {
  it("matches the line by name", () => {
    assert.ok(matchesHub(s("Carnival Raises Its Gratuity Rates Again"), carnival));
    assert.ok(matchesHub(s("Royal Caribbean Adds a Fourth Private Destination"), royal));
  });
  it("matches by ship name when the headline never says the line", () => {
    assert.ok(matchesHub(s("Mardi Gras Returns to Port Canaveral After Repairs"), carnival), "Mardi Gras is Carnival's alone");
    assert.ok(matchesHub(s("Icon of the Seas Sells Out Her First Winter"), royal), "'of the Seas' is Royal's naming convention");
    assert.ok(matchesHub(s("Utopia of the Seas Adds a New Short Sailing"), royal));
    assert.ok(matchesHub(s("Hero of the Seas Floats Out at Meyer Turku"), royal), "covers hulls not yet delivered");
  });

  // The real failures from rendering the 345 published stories on 2026-09-11.
  it("a bare ship word shared with another line does NOT match", () => {
    assert.ok(!matchesHub(s("Disney Magic's Very Merrytime Cruise Gains a Cozumel Stop for Christmas"), carnival), "Disney Magic is not Carnival Magic");
    assert.ok(!matchesHub(s("Disney Dream Returns From Dry Dock"), carnival), "Disney Dream is not Carnival Dream");
    assert.ok(!matchesHub(s("Royal Caribbean Names New Chief Dog Officer, Dolly"), carnival), "'Adventure of the Seas' must not read as Carnival Adventure");
    assert.ok(!matchesHub(s("Water Leak Creates Indoor Waterfall on Quantum of the Seas"), carnival));
    assert.ok(!matchesHub(s("Power Outage Affects Guests on Royal Caribbean's Adventure of the Seas"), carnival));
  });
  it("a shared Carnival Corporation island does not make a Princess story Carnival news", () => {
    assert.ok(!matchesHub(s("Sun Princess Swaps Princess Cays for Half Moon Cay on Nov. 22, 2026 Sailing"), carnival), "Half Moon Cay is Holland America's island");
  });
  it("the real Carnival stories still land", () => {
    assert.ok(matchesHub(s("Carnival Adjusts 2026, 2027, and 2028 Itineraries for Carnival Elation"), carnival));
    assert.ok(matchesHub(s("Carnival Tropicale Bookings Open, Galveston Debut Set for April 2028"), carnival));
    assert.ok(matchesHub(s("Carnival Venezia Guests Warned Against Early Arrival at Manhattan Cruise Terminal"), carnival));
  });
  it("the real Royal stories still land, and only there", () => {
    for (const title of [
      "Royal Caribbean Names New Chief Dog Officer, Dolly",
      "Water Leak Creates Indoor Waterfall on Quantum of the Seas",
      "Royal Caribbean Cancels Serenade of the Seas Alaska Cruise",
      "Royal Caribbean's Hero of the Seas Floats Out at Meyer Turku Shipyard",
    ]) {
      assert.ok(matchesHub(s(title), royal), title);
      assert.ok(!matchesHub(s(title), carnival), `${title} must not be on Carnival`);
    }
  });
  it("matches the private islands each line markets", () => {
    assert.ok(matchesHub(s("Celebration Key Opens Ahead of Schedule"), carnival));
    assert.ok(matchesHub(s("Perfect Day at CocoCay Raises Cabana Prices"), royal));
  });
  it("does not put one line's story on the other's hub", () => {
    assert.ok(!matchesHub(s("Royal Caribbean Adds a Fourth Private Destination"), carnival));
    assert.ok(!matchesHub(s("Carnival Raises Its Gratuity Rates Again"), royal));
  });
  it("a sister brand under the same parent is not this line's news", () => {
    assert.ok(!matchesHub(s("Princess Cruises Overhauls Its Loyalty Program", { summary: "Carnival Corporation brand Princess is changing tiers." }), carnival), "Princess is not Carnival Cruise Line");
    assert.ok(!matchesHub(s("Celebrity Cruises Makes Big Changes to Loyalty Program", { summary: "Royal Caribbean Group brand Celebrity is changing tiers." }), royal), "Celebrity is not Royal Caribbean International");
  });
  it("but a headline that names the line itself still counts, sister brand or not", () => {
    assert.ok(matchesHub(s("Carnival Cancels a Celebration Sailing, Princess Picks Up the Guests"), carnival));
  });
  it("an unrelated line is on neither hub", () => {
    for (const h of NEWS_HUBS) assert.ok(!matchesHub(s("Norwegian Prima Shuts Down Its Hot Tubs"), h));
    for (const h of NEWS_HUBS) assert.ok(!matchesHub(s("MSC World America Debuts in Miami"), h));
  });
  it("the cliffnote counts when the headline names no line at all", () => {
    assert.ok(matchesHub(s("A Fee Change Worth Knowing About", { summary: "Royal Caribbean is raising its daily gratuity." }), royal));
  });
  it("a passing mention does not drag a story onto the other line's hub", () => {
    const st = s("Royal Caribbean Trims Revenue Outlook Amid Middle East Booking Impact", { summary: "Carnival reported a stronger quarter over the same period." });
    assert.ok(matchesHub(st, royal), "the headline names Royal");
    assert.ok(!matchesHub(st, carnival), "Carnival is only a comparison in the body");
  });
  it("a genuine industry story naming no line in the headline appears on every line it covers", () => {
    const st = s("Port Canaveral Tops Off Massive 13-Story Cruise Parking Garage", { summary: "The garage serves Carnival and Royal Caribbean terminals." });
    assert.ok(matchesHub(st, carnival));
    assert.ok(matchesHub(st, royal));
  });
});

describe("storiesForHub", () => {
  const stories = [
    s("Carnival Raises Its Gratuity Rates Again", { approvedAt: "2026-09-08T12:00:00Z" }),
    s("Icon of the Seas Sells Out Her First Winter", { approvedAt: "2026-09-09T12:00:00Z" }),
    s("Mardi Gras Returns to Port Canaveral After Repairs", { approvedAt: "2026-09-11T12:00:00Z" }),
    s("Norwegian Prima Shuts Down Its Hot Tubs", { approvedAt: "2026-09-11T13:00:00Z" }),
    { ...s("Carnival Raises Its Gratuity Rates Again"), approvedAt: "2026-09-01T12:00:00Z" }, // same id again
  ];
  it("returns only that line's stories, newest first, once each", () => {
    const got = storiesForHub(stories, carnival);
    assert.deepEqual(got.map((x) => x.title), [
      "Mardi Gras Returns to Port Canaveral After Repairs",
      "Carnival Raises Its Gratuity Rates Again",
    ]);
  });
  it("the other hub gets its own", () => {
    assert.deepEqual(storiesForHub(stories, royal).map((x) => x.title), ["Icon of the Seas Sells Out Her First Winter"]);
  });
});

describe("hub configuration", () => {
  it("every hub has both languages, a path, and copy that names the search it answers", () => {
    for (const h of NEWS_HUBS) {
      assert.ok(h.en.title.length > 20 && h.es.title.length > 20, h.slug);
      assert.ok(h.en.desc.length >= 120 && h.en.desc.length <= 320, `${h.slug} meta description length ${h.en.desc.length}`);
      assert.ok(h.es.desc.length >= 120 && h.es.desc.length <= 320, `${h.slug} ES meta description length ${h.es.desc.length}`);
      assert.equal(hubPath(h.slug, "en"), `/news/${h.slug}.html`);
      assert.equal(hubPath(h.slug, "es"), `/es/news/${h.slug}.html`);
    }
    assert.equal(hubBySlug("carnival")!.en.h1, "Carnival Cruise News");
    assert.equal(hubBySlug("royal-caribbean")!.en.h1, "Royal Caribbean News");
    assert.ok(MIN_HUB_STORIES >= 1);
  });
  it("no banned words in the published copy", () => {
    for (const h of NEWS_HUBS) {
      for (const copy of [h.en, h.es]) {
        for (const v of Object.values(copy)) assert.ok(!/\bactually\b/i.test(v), `${h.slug}: ${v}`);
      }
    }
  });
});
