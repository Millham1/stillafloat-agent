import { test } from "node:test";
import assert from "node:assert/strict";
import { posterSpec, wrap, pickPhotos, fitHeadline, MARK_PHONE } from "./group-package-spec";
import type { GroupFacts, GroupCopy } from "./group-marketing";

const facts = {
  lang: "en", sailDateText: "May 10, 2027", returnDateText: "May 14, 2027", nights: 4, embarkPort: "Miami", ports: ["Nassau, Bahamas", "Ocean Cay MSC Marine Reserve"],
  amenities: ["3 amenity points from the cruise line: group perks (such as onboard credit) that Mark picks for the group before final payment"],
  cabins: [{ category: "IR2 Deluxe Interior", perPersonText: "$575.80", depositPerPersonText: "$99" }], fromPerPersonText: "$575.80", bookByText: "January 10, 2027",
  travel: [{ kind: "flight", text: "Airfare from Raleigh-Durham: $412 per person", included: false, priceText: "$412" }], perks: ["Premium drinks package"], allowedNumbers: [],
} as unknown as GroupFacts;
const copy = { headline: "Four Nights on MSC Seaside for Legion Veterans, Friends and Family" } as GroupCopy;

test("wrap keeps lines under the limit and never drops words", () => {
  const lines = wrap("Four Nights on MSC Seaside for Legion Veterans, Friends and Family", 26);
  assert.ok(lines.every((l) => l.length <= 26), lines.join("|"));
  assert.equal(lines.join(" "), "Four Nights on MSC Seaside for Legion Veterans, Friends and Family");
});

test("the poster says the dates, the ports, the from-price, the deposit, the reserve-by date, the travel offer, the CTA and the credit", () => {
  const spec = posterSpec(facts, copy, { url: "https://stillafloatcruising.com/group.html?g=rj4qhy2xft", credits: ["Photo: Someone · CC BY 4.0 · Wikimedia Commons"] });
  assert.equal(spec.dates, "May 10, 2027 – May 14, 2027 · 4 nights · from Miami");
  assert.deepEqual(spec.facts.slice(0, 4), ["Ports: Nassau, Bahamas, Ocean Cay MSC Marine Reserve", "From $575.80 per person", "Deposit $99 per person", "Reserve by January 10, 2027"]);
  assert.deepEqual(spec.travel, ["Airfare from Raleigh-Durham: $412 per person"]);
  assert.equal(spec.cta, "Use the QR code to book your spot!"); assert.equal(spec.linkCta, "Use the link to book your spot!"); assert.equal(spec.lang, "en"); assert.equal(spec.phone, MARK_PHONE); assert.equal(MARK_PHONE, "919-346-6127");
  assert.ok(spec.facts.includes("Included: Premium drinks package"), "the guest's perk is on the poster");
  assert.ok(spec.facts.includes("Cabin upgrades available"), "the upgrades line is on the poster");
  assert.ok(!spec.facts.some((x) => /amenity point/i.test(x)), "amenity points never reach the poster");
  assert.equal(spec.url, "stillafloatcruising.com/group.html?g=rj4qhy2xft");
  assert.match(spec.credit, /CC BY 4.0/);
  assert.match(spec.footer, /Still Afloat LLC/);
  assert.ok(spec.headline.length >= 2);
});

test("the poster's call to action is Mark's line, or the group's own (cta_line), in either language; the pictures with no QR code get its link twin", () => {
  const args = { url: "https://stillafloatcruising.com/group.html?g=rj4qhy2xft", credits: [] as string[] };
  assert.equal(posterSpec(facts, copy, { ...args, lang: "es" }).cta, "¡Use el código QR para reservar su lugar!");
  assert.equal(posterSpec(facts, copy, { ...args, lang: "es" }).linkCta, "¡Use el enlace para reservar su lugar!");
  const own = posterSpec(facts, copy, { ...args, cta: " Scan the QR to join the fun " });
  assert.equal(own.cta, "Scan the QR to join the fun"); assert.equal(own.linkCta, "Open the link to join the fun");
  assert.equal(posterSpec(facts, copy, { ...args, cta: "Reserve your cabin today" }).linkCta, "Open the link", "a line we have no link twin for");
  assert.equal(posterSpec(facts, copy, { ...args, cta: "   " }).cta, "Use the QR code to book your spot!", "a blank line is no line");
});

test("Mark's rising sentence fits the poster: the headline is its sentence and payoff, wrapped and sized to fit, not a four-word hook", () => {
  const walk = "Imagine shopping Nassau in the morning, dancing under the Ocean Cay lighthouse light show at the beach party that night, then walking that same beach into a Bahamas sunrise…";
  const spec = posterSpec(facts, { headline: walk, subhead: "ALL ON THE SAME CRUISE!" } as GroupCopy, { url: "https://stillafloatcruising.com/group.html?g=rj4qhy2xft", credits: [] });
  assert.equal(spec.headline.join(" "), `${walk} ALL ON THE SAME CRUISE!`, "every word, the payoff last");
  assert.ok(spec.headline.length <= 7, `${spec.headline.length} lines`);
  assert.ok(spec.headlineSize < 136 && spec.headlineSize >= 80, `size ${spec.headlineSize}`);
  // a short headline keeps the big type; a long old-style subhead is not the payoff and stays off the poster
  assert.equal(posterSpec(facts, copy, { url: "u", credits: [] }).headlineSize, 136);
  const old = posterSpec(facts, { headline: "Sunset. Light show. Sunrise.", subhead: "Watch a Caribbean sunset, dance under a lighthouse light show, then walk that same beach at sunrise. The only hard decision is when to sleep." } as GroupCopy, { url: "u", credits: [] });
  assert.equal(old.headline.join(" "), "Sunset. Light show. Sunrise.");
});

test("fitHeadline picks the biggest size that fits in the lines allowed, and the smallest when nothing does; no word is lost", () => {
  const text = "Imagine shopping Nassau in the morning, dancing under the Ocean Cay lighthouse light show at the beach party that night, then walking that same beach into a Bahamas sunrise… ALL ON THE SAME CRUISE!";
  const sizes = [136, 118, 104, 92, 80];
  const a = fitHeadline(text, 2310, sizes, 7);
  assert.equal(a.lines.join(" "), text);
  assert.ok(a.lines.length <= 7 && a.lines.every((l) => l.length <= Math.floor(2310 / (a.size * 0.66))));
  assert.ok(a.size < 136);
  assert.deepEqual(fitHeadline("Four nights", 2310, sizes, 6), { size: 136, lines: ["Four nights"] });
  const tight = fitHeadline(text, 2310, sizes, 2);
  assert.equal(tight.size, 80, "nothing fits in two lines: the smallest type, however many lines it takes");
  assert.equal(tight.lines.join(" "), text);
});

test("pickPhotos: Mark's choice leads; else the ship first and a destination second; credits follow the photos used", () => {
  const a = (id: string, subject: string) => ({ id, subject, attribution: `Photo ${id}` }) as never;
  const assets = [a("s1", "ship"), a("d1", "destination:Ocean Cay"), a("d2", "destination:Nassau")];
  let p = pickPhotos(assets, []);
  assert.equal(p.hero!.id, "s1"); assert.equal(p.second!.id, "d1"); assert.deepEqual(p.credits, ["Photo s1", "Photo d1"]);
  p = pickPhotos(assets, ["d2"]);
  assert.equal(p.hero!.id, "d2"); assert.equal(p.second!.id, "s1");
  assert.equal(pickPhotos([], []).hero, null);
});
