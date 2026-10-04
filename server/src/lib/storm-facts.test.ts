// storm-facts.test.ts — the alert's geometry is computed, never left to the model.
// Cases are the real storms the local model got wrong on 2026-10-03.
import test from "node:test";
import assert from "node:assert/strict";
import {
  compassWord, abbrevToDeg, ktToMph, milesBetween, roundMiles, anchorsFor, motionRelative,
  relateToGrounds, relationLines, headingFrom, intensityLine, bottomLine, checkDraft,
} from "./storm-facts";
import { REGION_LABELS } from "./storm-grounds";

test("headings become the compass word NHC prints", () => {
  assert.equal(compassWord(100), "east");            // Hanna — the box said "northeast"
  assert.equal(compassWord(240), "west-southwest");  // Fay — the box said "west-northwest"
  assert.equal(compassWord(300), "west-northwest");  // Rachel, advisory 28: "WNW OR 300 DEGREES"
  assert.equal(compassWord(275), "west");            // Nolo, advisory 54: "W OR 275 DEGREES"
  assert.equal(compassWord(359), "north");
  assert.equal(compassWord(-90), "west");
});

test("compass abbreviations convert back to degrees", () => {
  assert.equal(abbrevToDeg("E"), 90);
  assert.equal(abbrevToDeg("wnw"), 292.5);
  assert.equal(abbrevToDeg("XYZ"), null);
});

test("knots convert to the mph NHC prints", () => {
  assert.equal(ktToMph(80), 90);    // Rachel advisory 28: 90 MPH
  assert.equal(ktToMph(100), 115);  // Nolo advisory 54: 115 MPH
  assert.equal(ktToMph(35), 40);
});

test("distances are great-circle miles, said in round figures", () => {
  const mi = milesBetween(25.77, -80.19, 25.08, -77.35);   // Miami → Nassau, about 185 miles
  assert.ok(mi > 170 && mi < 200, String(mi));
  assert.equal(roundMiles(183), 200);
  assert.equal(roundMiles(912), 900);
  assert.equal(roundMiles(44), 40);
  assert.equal(roundMiles(3), 10);
});

test("every cruising ground has anchor ports, and every gazetteer slug resolves", () => {
  for (const region of Object.keys(REGION_LABELS)) {
    const anchors = anchorsFor(region);
    assert.ok(anchors.length >= 1, `${region} has no anchors`);
    for (const a of anchors) assert.ok(Number.isFinite(a.lat) && Number.isFinite(a.lon), `${region}/${a.name}`);
  }
  assert.equal(anchorsFor("e_caribbean").length, 8);   // a typo'd slug would drop one silently
  assert.equal(anchorsFor("nowhere").length, 0);
});

test("motion relative to a port: toward, away, across", () => {
  assert.equal(motionRelative(90, 90), "toward");
  assert.equal(motionRelative(90, 270), "away");
  assert.equal(motionRelative(0, 90), "across");
  assert.equal(motionRelative(350, 20), "toward");   // wraps through north
  assert.equal(motionRelative(60, 0), "toward");     // closing at half speed: still toward
  assert.equal(motionRelative(61, 0), "across");
  assert.equal(motionRelative(120, 0), "away");
  assert.equal(motionRelative(null, 20), "unknown");
});

test("Hanna: far east of Canada & New England and moving away, not 'approaching'", () => {
  const [r] = relateToGrounds(36.6, -50.4, 100, ["canada_new_england"]);
  assert.equal(r!.motion, "away");
  assert.ok(r!.miles >= 700, `expected well offshore, got ${r!.miles}`);
  assert.match(r!.stormIs, /southeast|east/);
});

test("Nolo: west of Hawaii and moving away", () => {
  const [r] = relateToGrounds(23.3, -167.8, 280, ["hawaii"]);
  assert.equal(r!.port, "Nawiliwili, Kauai");
  assert.equal(r!.motion, "away");
  assert.ok(r!.miles >= 450 && r!.miles <= 650, String(r!.miles));
});

test("Norbert: 700 miles off Cabo heading west is moving away; Rachel running up the coast is passing", () => {
  assert.equal(relateToGrounds(16.4, -117.9, 280, ["mexican_riviera"])[0]!.motion, "away");
  assert.equal(relateToGrounds(17.3, -106.8, 315, ["mexican_riviera"])[0]!.motion, "across");
});

test("Fay: about a thousand miles out — never 'near' the Eastern Caribbean", () => {
  const [r] = relateToGrounds(23.7, -48.2, 240, ["e_caribbean"]);
  assert.ok(r!.miles >= 900, String(r!.miles));
  assert.equal(r!.motion, "toward");
});

test("fact lines state distance, direction and motion in words", () => {
  const lines = relationLines(relateToGrounds(36.6, -50.4, 100, ["canada_new_england"]));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^Distance — Canada & New England: the centre is about [\d,]+ miles \S+ of .+, moving AWAY from it right now\.$/);
});

test("heading comes from the feed's degrees or a marine movement string", () => {
  assert.equal(headingFrom(300, null), 300);
  assert.equal(headingFrom(null, "E at 5 kt"), 90);
  assert.equal(headingFrom(null, "stationary"), null);
  assert.equal(headingFrom(undefined, null), null);
});

test("tropical intensity gains an mph figure; marine intensity passes through", () => {
  assert.equal(intensityLine("80 kt"), "maximum sustained winds 80 kt (about 90 mph)");
  assert.equal(intensityLine("982 mb, winds 25–35 kt"), "982 mb, winds 25–35 kt");
});

test("the verdict is decided in code: quiet, watch, close", () => {
  const hanna = bottomLine(relateToGrounds(36.6, -50.4, 100, ["canada_new_england"]))!;
  assert.equal(hanna.verdict, "quiet");
  assert.match(hanna.line, /moving away from Canada & New England/);
  const fay = bottomLine(relateToGrounds(23.7, -48.2, 240, ["e_caribbean"]))!;
  assert.equal(fay.verdict, "watch");
  assert.match(fay.line, /still about 1,000 miles from Antigua\. Worth watching, nothing to do yet/);
  const rachel = bottomLine(relateToGrounds(17.3, -106.8, 315, ["mexican_riviera"]))!;
  assert.equal(rachel.verdict, "close");
  assert.match(rachel.line, /within about 250 miles of Puerto Vallarta/);
  assert.equal(bottomLine(relateToGrounds(59, -161, 90, ["alaska"]), true)!.verdict, "close");
  assert.equal(bottomLine([]), null);
});

test("the draft check catches a wrong motion word and uninvited forecasts", () => {
  const facts = { motionWord: "east", hasForecastText: false };
  const bad = checkDraft({ headline: "Hanna", body_md: "Hanna is moving away at 17 mph on a northeast track and is expected to weaken. Its outer bands may bring rain." }, facts);
  assert.equal(bad.length, 3);
  assert.match(bad[0]!, /moving "northeast" but the Movement fact says "east"/);
  const good = checkDraft({ headline: "Hanna moving away", body_md: "Hanna is about 850 miles southeast of Sydney, Nova Scotia, moving east at 17 mph. The forecast can change and we are watching it." }, facts);
  assert.deepEqual(good, []);
});

test("the draft check leaves bearings alone and allows forecasts that were supplied", () => {
  assert.deepEqual(checkDraft({ headline: "x", body_md: "The centre is 250 miles south-southwest of Puerto Vallarta, moving northwest at 12 mph." }, { motionWord: "northwest", hasForecastText: false }), []);
  assert.deepEqual(checkDraft({ headline: "x", body_md: "The low is expected to weaken over the next 48 hours, moving east." }, { motionWord: "east", hasForecastText: true }), []);
  assert.equal(checkDraft({ headline: "x", body_md: "The storm will not affect your cruise plans." }, { motionWord: "west", hasForecastText: false }).length, 1);
  assert.deepEqual(checkDraft({ headline: "x", body_md: "Moving west-northwest at 5 mph." }, { motionWord: "west-northwest", hasForecastText: false }), []);
});
