import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COPY_FIELDS, COPY_SCHEMA, INTERVIEW, buildFacts, displayName, formatDate, formatMoney, missingAnswers, newShareCode,
  normalizeAnswers, numbersIn, shipSlugCandidate, tidyCopy, userPrompt, validateCopy, type GroupCopy, humanizeAmenity, travelLines, portDisplayName } from "./group-marketing";

test("displayName fixes all-capital contract names and leaves normal ones alone", () => {
  assert.equal(displayName("MSC SEASIDE"), "MSC Seaside");
  assert.equal(displayName("MSC CRUISES"), "MSC Cruises");
  assert.equal(displayName("CARNIVAL CRUISE LINE"), "Carnival Cruise Line");
  assert.equal(displayName("Carnival Celebration"), "Carnival Celebration");
  assert.equal(displayName("ICON OF THE SEAS"), "Icon of the Seas");
  assert.equal(displayName(null), "");
  assert.equal(shipSlugCandidate("MSC SEASIDE"), "msc-seaside");
  assert.equal(shipSlugCandidate("Carnival Celebration"), "carnival-celebration");
});

test("share codes are 10 characters with no look-alike letters", () => {
  const code = newShareCode((n) => Uint8Array.from({ length: n }, (_, i) => i * 37));
  assert.match(code, /^[a-hjkmnp-z2-9]{10}$/);
});

test("dates and money format per language", () => {
  assert.equal(formatDate("2027-05-10", "en"), "May 10, 2027");
  assert.equal(formatDate("2027-05-10", "es"), "10 de mayo de 2027");
  assert.equal(formatDate("nope", "en"), null);
  assert.equal(formatMoney(1249), "$1,249");
  assert.equal(formatMoney(849.5), "$849.50");
  assert.equal(formatMoney(null), null);
});

test("numbersIn folds separators and decimals", () => {
  assert.deepEqual(numbersIn("From $1,249.00 for 7 nights on May 10, 2027"), ["1249", "7", "10", "2027"]);
});

function file() {
  return {
    group: {
      id: "g1", name: "Post 12 Cruise", organizer_name: "Robert Alvarez", cruise_line: "CARNIVAL CRUISE LINE", ship_name: "CARNIVAL CELEBRATION",
      ship_slug: "carnival-celebration", sail_date: "2027-03-14", return_date: "2027-03-21", nights: 7, embark_port: "Miami, Florida",
      deposit_due: "2026-11-01", recall_date: "2026-10-15", final_payment_due: "2026-12-14",
      amenities: ["$50 onboard credit per stateroom", "", "Private cocktail party"],
      itinerary: [
        { day: 1, date: "2027-03-14", port: "Miami, Florida", arrive: null, depart: "16:00" },
        { day: 2, date: "2027-03-15", port: "At Sea", arrive: null, depart: null },
        { day: 3, date: "2027-03-16", port: "Cozumel, Mexico", arrive: "08:00", depart: "17:00" },
        { day: 4, date: "2027-03-17", port: "Cozumel, Mexico", arrive: "08:00", depart: "17:00" },
        { day: 8, date: "2027-03-21", port: "Miami, Florida", arrive: "08:00", depart: null },
      ],
    },
    cabins: [
      { status: "held", category: "Balcony", category_code: "8C", price_total: 2498, deposit_amount: 500 },
      { status: "booked", category: "Balcony", category_code: "8C", price_total: 2498, deposit_amount: 500 },
      { status: "held", category: "Interior", category_code: "4B", price_total: 1698, deposit_amount: 500 },
      { status: "released", category: "Interior", category_code: "4B", price_total: 1698, deposit_amount: 500 },
      { status: "held", category: null, price_total: null, deposit_amount: null },
    ],
  };
}
const rating = { status: "published", rating: 4.3, comment: "Lively ship.", comment_es: "Barco animado.", salty_mark_take: "Loud by the pool.", salty_mark_take_es: "Ruidoso junto a la piscina." };

test("buildFacts derives every figure from the file, in the page's language", () => {
  const f = buildFacts(file(), rating, "en");
  assert.equal(f.ship, "Carnival Celebration");
  assert.equal(f.line, "Carnival Cruise Line");
  assert.equal(f.sailDateText, "March 14, 2027");
  assert.deepEqual(f.ports, ["Cozumel"]);                       // home port and sea days excluded, repeats folded
  assert.equal(f.itinerary.length, 5);
  assert.equal(f.itinerary[1]!.seaDay, true);
  assert.equal(f.itinerary[2]!.timesText, "8:00 AM – 5:00 PM");
  assert.equal(f.itinerary[0]!.timesText, "depart 4:00 PM");
  assert.deepEqual(f.amenities, ["$50 onboard credit per stateroom", "Private cocktail party"]);
  // Cheapest first; per person = cabin total / 2; booked cabins are not "available".
  assert.deepEqual(f.cabins.map((c) => [c.category, c.perPersonText, c.depositPerPersonText, c.available, c.total]), [
    ["Interior", "$849", "$250", 1, 1],
    ["Balcony", "$1,249", "$250", 1, 2],
  ]);
  assert.equal(f.fromPerPersonText, "$849");
  assert.equal(f.cabinsTotal, 4);                               // released cabin not counted
  assert.equal(f.cabinsAvailable, 3);
  assert.equal(f.bookByText, "October 15, 2026");               // the earlier of deposit deadline and recall
  assert.equal(f.rating!.scoreText, "4.3");
  assert.equal(f.business.legalName, "Still Afloat LLC dba Still Afloat Cruising");
  const es = buildFacts(file(), rating, "es");
  assert.equal(es.sailDateText, "14 de marzo de 2027");
  assert.equal(es.itinerary[2]!.timesText, "08:00 – 17:00");
  assert.equal(es.rating!.comment, "Barco animado.");
});

test("an unpublished rating never reaches the page", () => {
  assert.equal(buildFacts(file(), { ...rating, status: "draft" }, "en").rating, null);
  assert.equal(buildFacts(file(), null, "en").rating, null);
});

function goodCopy(): GroupCopy {
  return {
    headline: "Post 12 goes to sea",
    subhead: "Seven nights out of Miami on Carnival Celebration, with the people you already like.",
    intro: "Robert asked me to put a week together for the Post, and this is the one I would pick.",
    why_ship: "Celebration is big enough that nobody gets bored and easy enough to get around. Cabins start at $849 per person.",
    who_for: "Good for first-timers and for anyone who wants company at dinner. If stairs are hard, tell me early so I can place you near the lifts.",
    organizer_note: null,
    cta_label: "Tell Mark you're interested",
    cta_blurb: "No payment here. I will call you, answer questions, and hold a cabin while you decide.",
    email_subject: "A week at sea with Post 12",
    email_body: "Friends,\n\nWe are sailing March 14, 2027.\n\nMark",
    social_post: "Post 12 is going cruising in March. Details at the link.",
  };
}

test("good copy passes; the copy schema requires every field", () => {
  const f = buildFacts(file(), rating, "en");
  assert.deepEqual(validateCopy(goodCopy(), f), []);
  assert.deepEqual((COPY_SCHEMA as { required: string[] }).required, COPY_FIELDS.map((x) => x.key));
});

test("a number that is not in the group file fails the copy", () => {
  const f = buildFacts(file(), rating, "en");
  const bad = { ...goodCopy(), why_ship: "Cabins start at $799 per person and there are 20 restaurants." };
  const problems = validateCopy(bad, f).map((p) => p.problem);
  assert.ok(problems.some((p) => p.includes("799")));
  assert.ok(problems.some((p) => p.includes(": 20")));
  // ...unless Mark himself said it in the interview.
  assert.deepEqual(validateCopy({ ...goodCopy(), intro: "Abuela turns 91 this year." }, f, { occasion: "Her 91st birthday" }), []);
  assert.equal(validateCopy({ ...goodCopy(), intro: "Abuela turns 91 this year." }, f).length, 1);
});

test("hype, promises and banned words fail the copy, in English and Spanish", () => {
  const f = buildFacts(file(), rating, "en");
  for (const phrase of ["an amazing week", "the ultimate escape", "guaranteed sunshine", "cheaper than you think", "it is actually great", "hurry, cabins are selling fast", "perfect for families", "pure luxury"]) {
    assert.ok(validateCopy({ ...goodCopy(), intro: phrase }, f).length >= 1, phrase);
  }
  const es = buildFacts(file(), rating, "es");
  for (const phrase of ["una semana increíble", "se lo garantizamos", "más barato de lo que cree", "un viaje inolvidable", "apúrese, se agotan"]) {
    assert.ok(validateCopy({ ...goodCopy(), intro: phrase }, es).length >= 1, phrase);
  }
});

test("missing, over-long and marked-up fields are reported; the organizer line may be empty", () => {
  const f = buildFacts(file(), rating, "en");
  const p = validateCopy({ ...goodCopy(), headline: "", cta_label: "x".repeat(60), intro: "Hello <b>there</b>" }, f);
  assert.deepEqual(p.map((x) => x.field).sort(), ["cta_label", "headline", "intro"]);
  assert.deepEqual(validateCopy({ ...goodCopy(), organizer_note: null }, f), []);
});

test("tidyCopy trims, nulls the optional field, and never returns undefined", () => {
  const t = tidyCopy({ headline: "  Hi  ", organizer_note: "  " });
  assert.equal(t.headline, "Hi");
  assert.equal(t.organizer_note, null);
  assert.equal(t.intro, "");
});

test("interview answers are normalised with defaults, and the three core answers gate writing", () => {
  const a = normalizeAnswers({ audience: " The Post ", tone: "shouty", show_prices: false, junk: 1 });
  assert.equal(a["audience"], "The Post");
  assert.equal(a["tone"], "warm-humor");
  assert.equal(a["show_prices"], false);
  assert.equal(a["show_rating"], true);
  assert.equal(a["mark_sailing"], false);
  assert.equal("junk" in a, false);
  assert.equal(Object.keys(a).length, INTERVIEW.length);
  assert.deepEqual(missingAnswers(a), ["occasion", "why_sailing"]);
});

test("the prompt hides prices and the score when Mark switches them off", () => {
  const f = buildFacts(file(), rating, "en");
  const on = userPrompt(f, normalizeAnswers({ audience: "a", occasion: "b", why_sailing: "c" }));
  assert.ok(on.includes("$849 per person"));
  assert.ok(on.includes("4.3 out of 5"));
  const off = userPrompt(f, normalizeAnswers({ audience: "a", occasion: "b", why_sailing: "c", show_prices: false, show_rating: false }));
  assert.ok(!off.includes("$849"));
  assert.ok(!off.includes("4.3"));
});


test("the home port's code becomes its city, and the city is not a port of call (the poster read 'FROM MIA' and listed Miami)", () => {
  assert.equal(portDisplayName("MIA"), "Miami, Florida");
  assert.equal(portDisplayName("Galveston, Texas"), "Galveston, Texas");
  assert.equal(portDisplayName(""), null);
  const f = buildFacts({ group: { ...file().group, embark_port: "MIA", itinerary: [
    { day: 1, date: "2027-05-10", port: "Miami, Florida", arrive: null, depart: "16:00" },
    { day: 2, date: "2027-05-11", port: "Nassau, Bahamas", arrive: "08:00", depart: "18:00" },
    { day: 5, date: "2027-05-14", port: "Miami, Florida", arrive: "07:00", depart: null },
  ] }, cabins: [] }, null, "en");
  assert.equal(f.embarkPort, "Miami, Florida");
  assert.deepEqual(f.ports, ["Nassau"]);
});

test("a quote's '3 AMENITY POINTS' shorthand becomes a plain sentence on the page, in both languages; plain perks pass through", () => {
  assert.equal(humanizeAmenity("3 AMENITY POINTS", "en"), "3 amenity points from the cruise line: group perks (such as onboard credit) that Mark picks for the group before final payment");
  assert.equal(humanizeAmenity("1 amenity point", "en"), "1 amenity point from the cruise line: group perks (such as onboard credit) that Mark picks for the group before final payment");
  assert.match(humanizeAmenity("3 AMENITY POINTS", "es"), /^3 puntos de beneficios de la naviera/);
  assert.equal(humanizeAmenity("$50 onboard credit per stateroom", "en"), "$50 onboard credit per stateroom");
});


test("the group's air / hotel / transfer offer reads as plain lines (EN and ES); per-traveler rows are not the group's offer", () => {
  const rows = [
    { kind: "flight", direction: "pre", provider: "Round trip from RDU", from_place: "Raleigh-Durham", price_per_person: 412, included: false, traveler_id: null, cabin_id: null },
    { kind: "hotel", direction: "pre", provider: "Hampton Inn Miami Airport", from_place: "Miami", reference: "1 night", price_per_person: "89.5", included: false, traveler_id: null, cabin_id: null },
    { kind: "transfer", direction: "pre", provider: "MSC motorcoach", from_place: "Hotel", to_place: "Cruise port", price_per_person: null, included: true, traveler_id: null, cabin_id: null },
    { kind: "flight", direction: "pre", provider: "AA 1234", from_place: "RDU", traveler_id: "t1", cabin_id: null },
  ];
  const en = travelLines(rows, "en");
  assert.equal(en.length, 3, "the traveler's own flight is not the group's offer");
  assert.equal(en[0]!.text, "Airfare from Raleigh-Durham (Round trip from RDU): $412 per person");
  assert.equal(en[1]!.text, "Hotel the night before in Miami (Hampton Inn Miami Airport, 1 night): $89.50 per person");
  assert.equal(en[2]!.text, "Transfer Hotel → Cruise port (MSC motorcoach): included in the cruise price");
  const es = travelLines(rows, "es");
  assert.match(es[0]!.text, /^Vuelos desde Raleigh-Durham/);
  assert.match(es[2]!.text, /incluido en el precio del crucero$/);
});
