// ship-scores.test.ts — the rules for turning captured cruiser category scores into matcher points.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shipStandings, standingFor, cruiserFit, caresAbout, readDial, DEFAULT_DIAL, type CruiserScoreRow } from "./ship-scores";

const cc = (ship_slug: string, review_count: number, categories: Record<string, number>): CruiserScoreRow =>
  ({ ship_slug, source: "cruise_critic", review_count, categories });
const cl = (ship_slug: string, review_count: number, categories: Record<string, number>): CruiserScoreRow =>
  ({ ship_slug, source: "cruiseline_com", review_count, categories });

test("a ship is read against its own site's fleet, so a site that scores everyone higher gives no one a lead", () => {
  // Site B scores every ship exactly one point above site A. Ship "only-b" is known to B alone.
  const rows = [
    cc("good", 1000, { dining: 4.4 }), cc("poor", 1000, { dining: 3.6 }), cc("only-a", 1000, { dining: 4.0 }),
    cl("good", 1000, { dining: 5.0 }), cl("poor", 1000, { dining: 4.2 }), cl("only-b", 1000, { dining: 4.6 }),
  ];
  const s = shipStandings(rows, 50, 1);
  assert.ok(s.get("good")!.dining! > 0.3 && s.get("poor")!.dining! < -0.3);
  assert.ok(Math.abs(s.get("only-a")!.dining!) < 0.05, "an average ship on the lower-scoring site is average");
  assert.ok(Math.abs(s.get("only-b")!.dining!) < 0.05, "an average ship on the higher-scoring site is average, not ahead");
});

test("a handful of reviews barely moves a ship; hundreds move it nearly in full", () => {
  const base = [cc("a", 1000, { dining: 4.0 }), cc("b", 1000, { dining: 4.0 })];
  const thin = shipStandings([...base, cc("x", 5, { dining: 5.0 })], 50, 1).get("x")!.dining!;
  const thick = shipStandings([...base, cc("x", 800, { dining: 5.0 })], 50, 1).get("x")!.dining!;
  assert.ok(thin < 0.15, `5 reviews moved the ship ${thin}`);
  assert.ok(thick > 0.5, `800 reviews moved the ship only ${thick}`);
});

test("one stray review on the second site cannot overturn hundreds on the first", () => {
  const rows = [
    cc("a", 900, { dining: 4.0 }), cc("b", 900, { dining: 4.0 }), cl("a", 900, { dining: 4.3 }), cl("b", 900, { dining: 4.3 }),
    cc("m", 450, { dining: 4.4 }), cl("m", 1, { dining: 3.0 }),
  ];
  assert.ok(shipStandings(rows, 50, 1).get("m")!.dining! > 0.2);
});

test("several of a site's categories for one topic are averaged; missing, zero and unknown-site rows are ignored", () => {
  const rows = [
    cc("a", 500, { children_programs: 3.0, family: 4.0 }), cc("b", 500, { children_programs: 3.5, family: 3.5 }),
    cc("c", 500, { children_programs: 0, family: 0 }),
    { ship_slug: "a", source: "somewhere_else", review_count: 9999, categories: { dining: 1 } },
    cc("d", 0, { dining: 5 }),
  ];
  const s = shipStandings(rows);
  assert.equal(s.get("a")!.kids, 0, "3.0 and 4.0 average to the same 3.5 as the fleet");
  assert.equal(s.get("c")?.kids, undefined);
  assert.equal(s.get("a")!.dining, undefined);
  assert.equal(s.has("d"), false);
});

test("a ship only one site really knows keeps half its lead; a ship both sites know keeps all of it", () => {
  const fleet = [
    cc("a", 900, { dining: 4.0 }), cc("b", 900, { dining: 4.0 }), cl("a", 900, { dining: 4.3 }), cl("b", 900, { dining: 4.3 }),
  ];
  const oneSite = [...fleet, cc("m", 450, { dining: 4.4 }), cl("m", 1, { dining: 4.7 })];
  const twoSites = [...fleet, cc("m", 450, { dining: 4.4 }), cl("m", 450, { dining: 4.7 })];
  const full = shipStandings(oneSite, 50, 1).get("m")!.dining!;
  const halved = shipStandings(oneSite).get("m")!.dining!;
  assert.ok(halved > full * 0.49 && halved < full * 0.53, `one site: kept ${halved} of ${full}`);
  const both = shipStandings(twoSites).get("m")!.dining!, bothFull = shipStandings(twoSites, 50, 1).get("m")!.dining!;
  assert.equal(both, bothFull, "a ship both sites know is not touched");
  const low = [...fleet, cc("p", 450, { dining: 3.4 })];
  assert.ok(shipStandings(low).get("p")!.dining! > shipStandings(low, 50, 1).get("p")!.dining!, "a one-site deficit is halved too");
});

test("how much a traveler cares follows where they sit, and price runs the other way", () => {
  assert.equal(caresAbout("dining", 2, 2), 1);
  assert.equal(caresAbout("dining", 0.5, 2), 0);
  assert.equal(caresAbout("dining", 0, 2), 0);
  assert.ok(caresAbout("dining", 1, 2) > 0.3 && caresAbout("dining", 1, 2) < 0.4);
  assert.equal(caresAbout("dining", 2, 0.75), 0.5, "a half-hearted answer counts for half");
  assert.equal(caresAbout("price", 0, 2), 1, "value-first: the value score counts in full");
  assert.equal(caresAbout("price", 2, 2), 0, "money is no object: the value score does not count");
});

test("a food lover is paid for a ship's food standing; a 'food is fuel' traveler is not", () => {
  const standing = { dining: 0.4, things_to_do: -0.3 };
  const flat = { energy: 1, price: 1, family: 1, dining: 1, activity: 1, structure: 1, scale: 1, warmth: 1 };
  const w = { energy: 1.5, price: 1.5, family: 1.5, dining: 1.5, activity: 1.5, structure: 1.5, scale: 1.5, warmth: 1.5 };
  const foodie = cruiserFit(standing, { ...flat, dining: 2, activity: 0.5 }, w);
  const fuel = cruiserFit(standing, { ...flat, dining: 0.5, activity: 0.5 }, w);
  assert.equal(foodie.points, 1, "0.4 above the fleet x cares 1 x strength 2.5");
  assert.equal(fuel.points, 0);
  assert.deepEqual(foodie.parts.map((p) => p.topic), ["dining"]);
  const doer = cruiserFit(standing, { ...flat, dining: 0.5, activity: 2 }, w);
  assert.equal(doer.points, -0.75, "a thin things-to-do ship costs the traveler who came to do things");
});

test("caring about many things does not multiply a good ship's lead: the topics are averaged", () => {
  const good = { dining: 0.5, things_to_do: 0.5, kids: 0.5, service: 0.5, entertainment: 0.5, value: 0.5 };
  const w = { energy: 3, price: 3, family: 3, dining: 3, activity: 3, warmth: 3 };
  const everything = cruiserFit(good, { energy: 2, price: 0, family: 2, dining: 2, activity: 2, warmth: 2 }, w);
  const foodOnly = cruiserFit(good, { energy: 0.5, price: 1.5, family: 0.5, dining: 2, activity: 0.5, warmth: 0.5 }, w);
  assert.equal(everything.points, 1.25, "half a point above the fleet on all six is worth 0.5 x strength, not six times that");
  assert.equal(foodOnly.points, 1.25);
  assert.equal(everything.parts.length, 6);
});

test("a ship with no captured scores neither gains nor loses", () => {
  assert.deepEqual(cruiserFit(undefined, { dining: 2 }, { dining: 2 }), { points: 0, parts: [] });
});

test("the dial is read from the matrix file, and nonsense falls back to the default", () => {
  assert.deepEqual(readDial(undefined), DEFAULT_DIAL);
  assert.deepEqual(readDial({ strength: "lots", counts: { dining: "the buffet" } }), DEFAULT_DIAL);
  const d = readDial({ strength: 4, halfTrustReviews: 100, counts: { dining: "dining", warmth: "service" } });
  assert.equal(d.strength, 4); assert.equal(d.halfTrustReviews, 100); assert.equal(d.oneSiteShare, 0.5);
  assert.equal(readDial({ oneSiteShare: 1 }).oneSiteShare, 1, "1 switches the one-site discount off");
  assert.deepEqual(d.counts, { dining: "dining", warmth: "service" });
  assert.equal(readDial({ strength: 0 }).strength, 0, "0 switches the scores off");
});

test("Mark's firsthand verdict replaces the reviews for that ship and that topic, and nothing else", () => {
  const rows = [
    cc("a", 900, { dining: 4.0, service: 4.0 }), cc("b", 900, { dining: 4.0, service: 4.0 }),
    cc("reviewed-low", 900, { dining: 3.2, service: 4.5 }), cl("a", 900, { dining: 4.3 }), cl("b", 900, { dining: 4.3 }), cl("reviewed-low", 900, { dining: 3.5 }),
  ];
  const standings = shipStandings(rows);
  const dial = readDial({ firsthand: { "reviewed-low": { dining: { standing: 0.25, why: "Mark sailed her: the food was better than the reviews say" } }, "never-reviewed": { dining: { standing: 0.1, why: "Mark sailed her" } } } });
  assert.ok(standings.get("reviewed-low")!.dining! < -0.4);
  const seen = standingFor("reviewed-low", standings, dial)!;
  assert.equal(seen.dining, 0.25);
  assert.equal(seen.service, standings.get("reviewed-low")!.service, "her other topics still come from the reviews");
  assert.deepEqual(standingFor("never-reviewed", standings, dial), { dining: 0.1 });
  assert.equal(standingFor("a", standings, dial), standings.get("a"), "a ship he has said nothing about is untouched");
  const foodie = { dining: 2 }, w = { dining: 2 };
  assert.ok(cruiserFit(seen, foodie, w, dial).points > 0 && cruiserFit(standings.get("reviewed-low"), foodie, w, dial).points < 0);
});

test("a firsthand verdict with no reason, an unknown topic or no number is dropped", () => {
  const d = readDial({ firsthand: {
    x: { dining: { standing: 0.3 } }, y: { buffet: { standing: 0.3, why: "sailed her" } },
    z: { dining: { standing: "good", why: "sailed her" } }, ok: { dining: { standing: 9, why: "sailed her" } },
  } });
  assert.deepEqual(d.firsthand, { ok: { dining: 1.5 } });
});
