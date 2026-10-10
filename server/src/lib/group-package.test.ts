import { test } from "node:test";
import assert from "node:assert/strict";
import { posterSpec, wrap, pickPhotos, MARK_PHONE } from "./group-package-spec";
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
  assert.equal(spec.cta, "Scan the QR to join the fun"); assert.equal(spec.phone, MARK_PHONE); assert.equal(MARK_PHONE, "919-346-6127");
  assert.ok(spec.facts.includes("Included: Premium drinks package"), "the guest's perk is on the poster");
  assert.ok(spec.facts.includes("Cabin upgrades available"), "the upgrades line is on the poster");
  assert.ok(!spec.facts.some((x) => /amenity point/i.test(x)), "amenity points never reach the poster");
  assert.equal(spec.url, "stillafloatcruising.com/group.html?g=rj4qhy2xft");
  assert.match(spec.credit, /CC BY 4.0/);
  assert.match(spec.footer, /Still Afloat LLC/);
  assert.ok(spec.headline.length >= 2);
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
