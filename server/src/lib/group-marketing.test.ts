import { test } from "node:test";
import assert from "node:assert/strict";
import { campaignSystemPrompt, campaignUserPrompt } from "./group-campaign";
import {
  COPY_FIELDS, COPY_SCHEMA, INTERVIEW, buildFacts, displayName, formatDate, formatMoney, missingAnswers, newShareCode,
  normalizeAnswers, numbersIn, shipSlugCandidate, tidyCopy, userPrompt, validateCopy, type GroupCopy, humanizeAmenity, travelLines, portDisplayName, systemPrompt,
  ANSWER_MAX, HOUSE_VOICE_RULES, LEAD_WITH_RULES, PITCH_FIRST, copyNotes, leadWith, leadWithLines, missingPitchSentences, pitchCoverage, pitchGate, pitchNumberProblems, pitchRules, pitchSentences, retryNote, tooLong, withoutPitch } from "./group-marketing";

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

test("who_for may run to 900 characters (Mark's air/hotel and theme-park day made 716); a longer one is told how to fix itself", () => {
  const f = buildFacts(file(), rating, "en");
  const para = (n: number) => "Good for first-timers. ".repeat(Math.ceil(n / 23)).slice(0, n);
  assert.deepEqual(validateCopy({ ...goodCopy(), who_for: para(716) }, f), [], "716 was refused at 600");
  assert.deepEqual(validateCopy({ ...goodCopy(), who_for: para(900) }, f), []);
  assert.deepEqual(validateCopy({ ...goodCopy(), who_for: para(901) }, f), [{ field: "who_for", problem: "too long: 901 of 900 characters — shorten it, or ask Mark" }]);
  // every "too long" reads the same, whatever the field and its limit
  assert.deepEqual(validateCopy({ ...goodCopy(), headline: "x".repeat(91) }, f), [{ field: "headline", problem: "too long: 91 of 90 characters — shorten it, or ask Mark" }]);
  assert.equal(tooLong(716, 600), "too long: 716 of 600 characters — shorten it, or ask Mark");
  assert.ok(!validateCopy({ ...goodCopy(), cta_label: "x".repeat(60) }, f).some((x) => /too long \(/.test(x.problem)), "the old wording is gone");
});

test("the character limits of each copy field", () => {
  assert.deepEqual(Object.fromEntries(COPY_FIELDS.map((x) => [x.key, x.max])), {
    headline: 90, subhead: 160, intro: 900, why_ship: 900, who_for: 900, organizer_note: 400,
    cta_label: 40, cta_blurb: 220, email_subject: 90, email_body: 1400, social_post: 500,
  });
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
  assert.equal("mark_sailing" in a, false, "the advisor-sailing question is gone (Mark 2026-10-10: leave me out of it)");
  assert.equal("junk" in a, false);
  assert.equal(Object.keys(a).length, INTERVIEW.length);
  assert.deepEqual(missingAnswers(a), ["pitch", "occasion", "why_sailing"]);
  assert.deepEqual(missingAnswers(normalizeAnswers({ pitch: "Come along.", audience: "a", occasion: "b", why_sailing: "c" })), []);
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


test("perks shown to guests come from the fare inclusions, never the organizer's amenities; the prompt names the QR and the upgrades line and never the advisor", () => {
  const f = buildFacts({ group: { ...file().group, inclusions: ["Premium drinks package", " Wi-Fi, one device, first two guests "] }, cabins: [] }, null, "en");
  assert.deepEqual(f.perks, ["Premium drinks package", "Wi-Fi, one device, first two guests"]);
  assert.ok(f.amenities.length > 0, "amenities still exist for the dashboard");
  const prompt = userPrompt(f, { audience: "Veterans", occasion: "A fun week", why_sailing: "Seaside" });
  assert.match(prompt, /Included for every guest: Premium drinks package/);
  assert.doesNotMatch(prompt, /Group perks|onboard credit per stateroom/);
  assert.match(prompt, /Cabin upgrades: available/);
  assert.match(prompt, /919-346-6127/);
  assert.doesNotMatch(prompt, /sailing with the group/);
  const sys = systemPrompt("en");
  assert.match(sys, /never a person/); assert.match(sys, /Scan the QR to join the fun/); assert.match(sys, /cabin upgrades are available/i);
  assert.doesNotMatch(sys, /Mark Millham/);
});


// ── Mark's pitch (2026-10-11): the copy is built around it, sentence for sentence ─────────────────────────

const PITCH = "Four nights out of Miami with the people you already like. Sunset on the beach, then a light show. Reply or scan the code and we will hold you a cabin.";
const withPitch = (extra: Partial<GroupCopy> = {}): GroupCopy => ({ ...goodCopy(), intro: PITCH, ...extra });

test("the interview opens with the pitch (required), the picture, the occasion line and a reference; every old key is still there", () => {
  assert.deepEqual(INTERVIEW.slice(0, 4).map((q) => q.key), ["pitch", "picture", "occasion_line", "reference"]);
  const [pitch, picture, occasionLine, reference] = INTERVIEW;
  assert.equal(pitch!.type, "long"); assert.equal(pitch!.required, true);
  assert.equal(pitch!.label, "Your pitch, as you would say it to them");
  assert.equal(picture!.label, "What should the reader see?"); assert.equal(picture!.type, "long");
  assert.equal(occasionLine!.label, "The occasion, in the group's own words"); assert.equal(occasionLine!.type, "text");
  assert.equal(reference!.label, "A piece you like"); assert.equal(reference!.type, "text"); assert.notEqual(reference!.required, true);
  for (const k of ["audience", "occasion", "why_sailing", "who_fits", "organizer_quote", "extras", "tone", "show_prices", "show_rating"]) assert.ok(INTERVIEW.some((q) => q.key === k), k);
  assert.deepEqual(INTERVIEW.filter((q) => q.required).map((q) => q.key), ["pitch", "audience", "occasion", "why_sailing"]);
});

test("the write routes' gate: no pitch, no copy — whitespace is no pitch", () => {
  assert.equal(PITCH_FIRST, "Write Mark's pitch first (interview question 1) — the copy is built around it.");
  assert.equal(pitchGate(normalizeAnswers({})), PITCH_FIRST);
  assert.equal(pitchGate(normalizeAnswers({ pitch: "   \n " })), PITCH_FIRST);
  assert.equal(pitchGate(normalizeAnswers({ pitch: "Come along." })), null);
});

test("a pitch is kept whole: answers are cut at the limit for every other question, never silently for a short pitch", () => {
  assert.equal(normalizeAnswers({ pitch: "x".repeat(ANSWER_MAX) })["pitch"], "x".repeat(ANSWER_MAX));
  assert.equal((normalizeAnswers({ pitch: PITCH })["pitch"] as string), PITCH);
});

test("pitchSentences splits on . ! ? and line breaks, keeps abbreviations and decimals whole", () => {
  assert.deepEqual(pitchSentences(PITCH), [
    "Four nights out of Miami with the people you already like.", "Sunset on the beach, then a light show.", "Reply or scan the code and we will hold you a cabin."]);
  assert.deepEqual(pitchSentences("Come along!  Bring the family?\nShoes optional"), ["Come along!", "Bring the family?", "Shoes optional"]);
  assert.deepEqual(pitchSentences("Dr. Reyes leads the group. Rooms start at 3.5 stars."), ["Dr. Reyes leads the group.", "Rooms start at 3.5 stars."]);
  assert.deepEqual(pitchSentences('He said "go." Then we went.'), ['He said "go."', "Then we went."]);
  assert.deepEqual(pitchSentences("   "), []);
  assert.deepEqual(pitchSentences(null), []);
});

test("pitchCoverage: the share of pitch sentences found word for word; case, spacing, curly quotes and end punctuation do not count", () => {
  assert.equal(pitchCoverage(PITCH, `Hello.\n${PITCH}\nBye.`), 1);
  assert.equal(pitchCoverage(PITCH, "FOUR  nights out of Miami with the people you already like!\nSunset on the beach, then a light show\nReply or scan the code and we will hold you a cabin"), 1);
  assert.equal(pitchCoverage("We'll hold you a cabin.", "We\u2019ll hold you a cabin."), 1);
  assert.equal(pitchCoverage(PITCH, "Four nights out of Miami with the people you already like. Sunset on the beach, then a light show."), 2 / 3);
  assert.equal(pitchCoverage(PITCH, "Four nights out of Miami with people you like. A sunset and a light show. Reply and we will hold a cabin."), 0);
  assert.equal(pitchCoverage(PITCH, ""), 0);
  assert.equal(pitchCoverage("", "anything"), 1, "no pitch, nothing to keep");
  assert.equal(pitchCoverage("   ", "anything"), 1);
  assert.deepEqual(missingPitchSentences(PITCH, "Sunset on the beach, then a light show."), ["Four nights out of Miami with the people you already like.", "Reply or scan the code and we will hold you a cabin."]);
});

test("a changed word is a missing sentence: tightening Mark's pitch is caught", () => {
  assert.equal(pitchCoverage("Dinner is on us.", "Dinner is on the house."), 0);
  assert.equal(pitchCoverage("Dinner is on us.", "Dinner is on us tonight."), 1, "extra words around a kept sentence are not a cut");
  assert.equal(pitchCoverage("Dinner is on us tonight.", "Dinner is on us."), 0, "a cut sentence is");
  assert.equal(pitchCoverage("Dinner is on us.", "Dinner is on usher duty."), 0, "whole words only");
  assert.equal(pitchCoverage("Dinner is on us.", "Dinner is on us, always."), 1);
});

test("validateCopy reports each pitch sentence that was not kept, on the intro; kept in the intro or the paragraphs after it, it passes", () => {
  const f = buildFacts(file(), rating, "en");
  const answers = { pitch: PITCH };
  assert.deepEqual(validateCopy(withPitch(), f, answers), []);
  // the pitch may run on into why_ship and who_for
  assert.deepEqual(validateCopy(withPitch({ intro: "Four nights out of Miami with the people you already like.", why_ship: "Sunset on the beach, then a light show.", who_for: "Reply or scan the code and we will hold you a cabin." }), f, answers), []);
  const p = validateCopy(withPitch({ intro: "Four nights out of Miami with the people you already like. A sunset, a show." }), f, answers);
  assert.deepEqual(p.map((x) => [x.field, x.problem]), [
    ["intro", "Pitch sentence not kept: 'Sunset on the beach, then a light show.'"],
    ["intro", "Pitch sentence not kept: 'Reply or scan the code and we will hold you a cabin.'"],
  ]);
  // a sentence sitting only in the email or the post does not count as the page carrying the pitch
  assert.equal(validateCopy(withPitch({ intro: "Hello there.", email_body: PITCH, social_post: PITCH }), f, answers).length, 3);
  // no pitch given (copy written before the rule): nothing to check
  assert.deepEqual(validateCopy(withPitch({ intro: "Hello there." }), f, {}), []);
});

test("the Spanish copy is a translation of Mark's English pitch, so it is not matched by sentence", () => {
  const es = buildFacts(file(), rating, "es");
  assert.deepEqual(validateCopy({ ...goodCopy(), intro: "Cuatro noches desde Miami con la gente que ya quiere." }, es, { pitch: PITCH }), []);
});

test("Mark's pitch is fact-checked: a number the group file does not have is reported on the pitch, once; his other answers can vouch for it", () => {
  const f = buildFacts(file(), rating, "en");
  const answers = { pitch: "Seven nights out of Miami. Bus leaves the Post at 6. Bring 40 friends. Bus is at 6 sharp." };
  const bad = pitchNumberProblems(answers, f);
  assert.deepEqual(bad.map((x) => [x.field, x.problem]), [
    ["pitch", "Mark's pitch states a number that is not in the group file: 6"],
    ["pitch", "Mark's pitch states a number that is not in the group file: 40"],
  ]);
  assert.deepEqual(pitchNumberProblems({ ...answers, extras: "Bus leaves the Post at 6 and we are 40 strong" }, f), []);
  assert.deepEqual(pitchNumberProblems({ pitch: "Seven nights, from $849 per person. Call 919-346-6127." }, f), [], "nights, a quoted price and the phone are all in the file");
  assert.deepEqual(pitchNumberProblems({}, f), []);
  // validateCopy reports it once, on 'pitch', and does not also blame the copy for repeating Mark's own number
  const p = validateCopy(withPitch({ intro: "Bus leaves the Post at 6." }), f, { pitch: "Bus leaves the Post at 6." });
  assert.deepEqual(p.map((x) => x.field), ["pitch"]);
});

test("exclamation marks, 'Join Mark' and amenity points fail every field, in both languages", () => {
  const en = buildFacts(file(), rating, "en");
  for (const [field, text, want] of [
    ["headline", "Sunset. Light show. Sunrise!", /exclamation/],
    ["cta_blurb", "Scan the QR to join the fun!", /exclamation/],
    ["subhead", "Join Mark on the Celebration", /Join Mark/],
    ["why_ship", "We have 3 amenity points to spend.", /amenity points/],
    ["who_for", "One amenity point goes to the group.", /amenity points/],
  ] as const) {
    const p = validateCopy({ ...goodCopy(), [field]: text }, en);
    assert.ok(p.some((x) => x.field === field && want.test(x.problem)), `${field}: ${text} -> ${JSON.stringify(p)}`);
  }
  const es = buildFacts(file(), rating, "es");
  for (const text of ["¡Zarpamos en marzo!", "Únase a Mark en el barco", "Tenemos 3 puntos de beneficios", "Join Mark"]) {
    assert.ok(validateCopy({ ...goodCopy(), intro: text }, es).some((x) => x.field === "intro"), text);
  }
  // Mark as the contact is fine
  assert.deepEqual(validateCopy({ ...goodCopy(), cta_blurb: "Scan the QR to join the fun, or call Mark at 919-346-6127." }, en), []);
});

test("both prompts carry the approved house voice verbatim, the exact call to action and the pitch rules", () => {
  const sys = systemPrompt("en");
  for (const rule of HOUSE_VOICE_RULES) assert.ok(sys.includes(rule), rule);
  assert.match(sys, /"Sunset\. Light show\. Sunrise\. Same beach\. Same cruise\."/);
  assert.match(sys, /"Four nights of camaraderie and relaxation\. Shoes optional\."/);
  assert.match(sys, /The only hard decision all week is when to sleep\./);
  assert.match(sys, /"Scan the QR to join the fun" \(exact words\), then the link, then the phone 919-346-6127/);
  assert.match(sys, /Never "Join Mark" as the hook/);
  assert.match(sys, /never "amenity points"/);
  assert.match(sys, /every sentence of it into the intro, word for word, in his order, and cut nothing/);
  assert.match(sys, /character for character/);
  assert.match(sys, /If he wrote an exclamation mark, keep it; if he wrote 'incredible' or 'amazing', keep it/);
  assert.match(sys, /not even a closing exclamation mark becoming a full stop/);
  assert.match(sys, /are for the words WE write around the pitch\. They never apply inside his sentences/);
  assert.doesNotMatch(sys, /The only change allowed is a closing exclamation mark/);
  assert.match(sys, /no exclamation marks anywhere in the words we write\. Mark's pitch sentences are his own words/);
  assert.match(systemPrompt("es"), /sentence for sentence/, "Spanish is a faithful translation of the pitch");
  assert.doesNotMatch(systemPrompt("es"), /every sentence of it into the intro, word for word/);
  assert.ok(pitchRules("email 1", "x").some((r) => r.includes("email 1")));
});

// ── Mark's pitch is verbatim: the house-voice bans are for the words WE write (Mark 2026-10-19, Millham F/F 2027) ────────────

const MARK_PITCH = "Join us for our first Friends and Family cruise to the Bahamas! Enjoy  all that Nassau has to offer, then spend two incredible days at MSC's Ocean Cay, including an amazing evening beach party and light show from the island's lighthouse!";
// what the writer produced from the old prompt: no "!", "incredible" swapped for "amazing", full stops for his marks
const SOFTENED = "Join us for our first Friends and Family cruise to the Bahamas. Enjoy all that Nassau has to offer, then spend two amazing days at MSC's Ocean Cay, including an amazing evening beach party and light show from the island's lighthouse.";
const VERBATIM = "Join us for our first Friends and Family cruise to the Bahamas! Enjoy all that Nassau has to offer, then spend two incredible days at MSC's Ocean Cay, including an amazing evening beach party and light show from the island's lighthouse!";

test("Mark's pitch verbatim passes: his exclamation marks, 'incredible', 'amazing' and 'Join us' are his, not flagged", () => {
  const f = buildFacts(file(), rating, "en");
  const answers = { pitch: MARK_PITCH };
  assert.deepEqual(validateCopy(withPitch({ intro: VERBATIM }), f, answers), []);
  // the same sentences with the curly quotes a word processor makes, an upper-case start and one more space
  assert.deepEqual(validateCopy(withPitch({ intro: VERBATIM.replace(/'/g, "\u2019").replace("Enjoy all", "ENJOY  ALL") }), f, answers), []);
  // the pitch running on into the next paragraph, "!" and all
  assert.deepEqual(validateCopy(withPitch({ intro: "Join us for our first Friends and Family cruise to the Bahamas!", why_ship: VERBATIM.split("! ")[1]! }), f, answers), []);
  // Mark's words in the email and the post are his too
  assert.deepEqual(validateCopy(withPitch({ intro: VERBATIM, email_body: `${VERBATIM}\n\nStill Afloat Cruising`, social_post: VERBATIM }), f, answers), []);
});

test("the same words with only the closing mark changed are still his sentences: a softened copy is not failed on '!' versus '.'", () => {
  const f = buildFacts(file(), rating, "en");
  const answers = { pitch: MARK_PITCH.replace("incredible", "amazing") };
  assert.deepEqual(validateCopy(withPitch({ intro: SOFTENED }), f, answers), []);
  assert.deepEqual(missingPitchSentences(answers.pitch, SOFTENED), []);
});

test("a paraphrase is not his sentence: 'two amazing days' for 'two incredible days' is reported as not kept", () => {
  const f = buildFacts(file(), rating, "en");
  const p = validateCopy(withPitch({ intro: SOFTENED }), f, { pitch: MARK_PITCH });
  // only his second sentence is reported (the first has the same words, only its closing mark differs)...
  assert.deepEqual(p.filter((x) => x.problem.startsWith("Pitch sentence not kept")).map((x) => [x.field, x.problem]), [[
    "intro", "Pitch sentence not kept: 'Enjoy  all that Nassau has to offer, then spend two incredible days at MSC's Ocean Cay, including an amazing evening beach party and light show from the island's lighthouse!'"]]);
  // ...and the paraphrase is the writer's words, not his: its "amazing" is ours to answer for, the first sentence is not touched
  assert.deepEqual(p.filter((x) => !x.problem.startsWith("Pitch sentence not kept")).map((x) => x.problem), ['uses "amazing"']);
  // it is the words that count, not just the banned ones: his 'incredible' dropped for a plain 'two days' is a cut too
  assert.equal(validateCopy(withPitch({ intro: VERBATIM.replace("two incredible days", "two days") }), f, { pitch: MARK_PITCH }).filter((x) => x.problem.startsWith("Pitch sentence not kept")).length, 1);
});

test("the house-voice bans still apply to the words WE write outside the pitch", () => {
  const f = buildFacts(file(), rating, "en");
  const answers = { pitch: MARK_PITCH };
  const p = validateCopy(withPitch({
    intro: `${VERBATIM} What an amazing week!`,
    why_ship: "An unforgettable week, cheaper than you think. Join Mark on the Seaside.",
    cta_blurb: "Scan the QR to join the fun!",
    social_post: `${VERBATIM}\nThree amenity points for the group.`,
  }), f, answers);
  const has = (field: string, re: RegExp) => p.some((x) => x.field === field && re.test(x.problem));
  assert.ok(has("intro", /uses "amazing"/), "our amazing after his pitch");
  assert.ok(has("intro", /exclamation/), "our '!' after his pitch");
  assert.ok(has("why_ship", /unforgettable/) && has("why_ship", /cheaper/) && has("why_ship", /Join Mark/));
  assert.ok(has("cta_blurb", /exclamation/));
  assert.ok(has("social_post", /amenity points/));
  assert.ok(!p.some((x) => x.problem.startsWith("Pitch sentence not kept")), JSON.stringify(p));
  // his "amazing" only counts as his while it sits inside his sentence: the same word beside it is ours
  assert.ok(validateCopy(withPitch({ intro: `${VERBATIM} It will be amazing.` }), f, answers).some((x) => /uses "amazing"/.test(x.problem)));
  // no pitch on the interview: nothing is his, every ban applies as before
  assert.ok(validateCopy(withPitch({ intro: VERBATIM }), f, {}).some((x) => /exclamation/.test(x.problem)));
});

test("withoutPitch takes out each pitch sentence where it is kept, and nothing else", () => {
  assert.equal(withoutPitch("Come along! Bring friends.", "Hello. Come along! Bring friends. Bye!").replace(/\s+/g, " ").trim(), "Hello. Bye!");
  assert.equal(withoutPitch("Come along!", "come   ALONG. Bring friends!").replace(/\s+/g, " ").trim(), "Bring friends!");
  assert.equal(withoutPitch("Come along!", "Come alongside us!"), "Come alongside us!", "whole words only");
  assert.equal(withoutPitch("", "Hello!"), "Hello!");
  assert.equal(withoutPitch(null, "Hello!"), "Hello!");
  assert.equal(withoutPitch("   ", "Hello!"), "Hello!");
  // one pitch sentence inside another: the longer is taken out whole, not left in pieces
  assert.equal(withoutPitch("Come along. Come along and bring us!", "Come along and bring us!").trim(), "");
  // characters that mean something in a pattern are just characters
  assert.equal(withoutPitch("Rooms from $849 (per person)?", "Rooms from $849 (per person)? Yes.").trim(), "Yes.");
});

test("a retry after a not-kept pitch sentence is told to copy it character for character", () => {
  assert.match(retryNote([{ field: "intro", problem: "Pitch sentence not kept: 'Come along!'" }]), /character for character as Mark wrote it/);
  assert.doesNotMatch(retryNote([{ field: "intro", problem: 'uses "amazing"' }]), /character for character/);
});

test("the writer is shown Mark's pitch sentence by sentence, with the picture, the occasion line and the reference; empty fields say so", () => {
  const f = buildFacts(file(), rating, "en");
  const p = userPrompt(f, normalizeAnswers({ pitch: PITCH, picture: "Sunset from the beach chairs", occasion_line: "Post 12 reunion", reference: "the MSC poster", audience: "a", occasion: "b", why_sailing: "c" }));
  assert.match(p, /1\. Four nights out of Miami with the people you already like\.\n2\. Sunset on the beach, then a light show\.\n3\. Reply or scan the code/);
  assert.match(p, /his words, every sentence kept word for word, with his punctuation and word choices exactly as written:/);
  assert.match(p, /The picture the reader should see: Sunset from the beach chairs/);
  assert.match(p, /The occasion, in the group's own words: Post 12 reunion/);
  assert.match(p, /A piece Mark likes \(taste only\): the MSC poster/);
  const bare = userPrompt(f, normalizeAnswers({ audience: "a", occasion: "b", why_sailing: "c" }));
  assert.match(bare, /Mark's pitch: \(not given\)/);
});

// ── Lead with the moments Mark named (Mark 2026-10-19, Millham F/F 2027) ─────────────────────────────────────────
// "it doesn't highlight the sunset to sunrise or properly identify the light show / beach party as an exciting activity"

/** Millham F/F 2027: MSC Seashore out of Port Canaveral, Nassau, then Ocean Cay overnight. */
function seashoreFacts(lang: "en" | "es" = "en") {
  return buildFacts({
    group: {
      id: "g2", name: "Millham F/F 2027", organizer_name: "Mark Millham", cruise_line: "MSC CRUISES", ship_name: "MSC SEASHORE", sail_date: "2027-05-09", return_date: "2027-05-13", nights: 4,
      embark_port: "PCV", deposit_due: "2026-12-01", amenities: [], inclusions: ["Overnight at Ocean Cay"],
      itinerary: [
        { day: 1, date: "2027-05-09", port: "Port Canaveral, Florida", arrive: null, depart: "17:00" },
        { day: 2, date: "2027-05-10", port: "Nassau, Bahamas", arrive: "09:00", depart: "17:00" },
        { day: 3, date: "2027-05-11", port: "Ocean Cay MSC Marine Reserve, Bahamas", arrive: "08:00", depart: null },
        { day: 4, date: "2027-05-12", port: "Ocean Cay MSC Marine Reserve, Bahamas", arrive: null, depart: "15:00" },
        { day: 5, date: "2027-05-13", port: "Port Canaveral, Florida", arrive: "07:00", depart: null },
      ],
    },
    cabins: [],
  }, null, lang);
}
const MARK_ANSWERS = normalizeAnswers({
  pitch: MARK_PITCH,
  picture: "The image of the lighthouse beach party, with the insets of the sunset/sunrise beach images, and an image of Nassau.",
  why_sailing: "Ocean Cay is a private island, and we sleep next to it. Watch the sunset and the sunrise from the same island while walking the beach or relax in a hammock with island breezes.",
  audience: "Friends and family", occasion: "First Friends and Family cruise",
  reference: "https://www.youtube.com/watch?v=msc-seashore",
});
// what the writer produced from the old prompt: the light show but not the beach party, the sunrise but not the sunset
const OLD_SUBHEAD = "Browse Nassau, then watch a lighthouse light show over the beach at Ocean Cay and catch the sunrise from the same sand. Only the ship keeps a schedule.";
const NEW_SUBHEAD = "An evening beach party under a lighthouse light show, then sunset to sunrise on one island. Only the ship keeps a schedule.";

test("Mark's answers give the moments in the order to lead with: the beach party and light show, then sunset to sunrise, then Nassau", () => {
  const lw = leadWith(MARK_ANSWERS, seashoreFacts());
  assert.deepEqual(lw.event, { terms: ["beach party", "light show"], from: ["picture", "pitch sentence 2"] });
  assert.deepEqual(lw.arc, { terms: ["sunset", "sunrise"], from: ["picture", "why_sailing"] });
  assert.deepEqual(lw.ports, { names: ["Nassau"], from: ["picture"] }, "the picture's port; Ocean Cay is where the event is, not a second item");
  assert.deepEqual(lw.scenes, ["lighthouse", "walking the beach", "hammock", "island breezes"]);
});

test("the writer's prompt carries the moments list in that order, with the instruction to lead with them", () => {
  const p = userPrompt(seashoreFacts(), MARK_ANSWERS);
  const block = p.slice(p.indexOf("<lead_with>"), p.indexOf("</lead_with>"));
  assert.match(block, /Lead with these, in this order\./);
  assert.match(block, /the dry beat comes last/);
  const at = (re: RegExp) => { const m = re.exec(block); assert.ok(m, String(re)); return m!.index; };
  const first = at(/1\. The headline activity, named as an event people do: beach party, light show \(picture; pitch sentence 2\)/);
  const second = at(/2\. The arc, sunset to sunrise in the one place: sunset, then sunrise \(picture; why_sailing\)/);
  const third = at(/3\. The port: Nassau \(picture\)/);
  assert.ok(first < second && second < third, "event, then the arc, then the port");
  assert.match(block, /Scene details in his words .*: lighthouse, walking the beach, hammock, island breezes/);
  assert.ok(p.indexOf("</advisor_interview>") < p.indexOf("<lead_with>"), "after his answers, so the numbers refer to them");
  assert.match(p, /2\. Enjoy\s+all that Nassau has to offer, then spend two incredible days/, "his pitch is still shown sentence by sentence");
});

test("both system prompts (page copy and campaign) say what to lead with, in the same words", () => {
  for (const sys of [systemPrompt("en"), systemPrompt("es"), campaignSystemPrompt("en"), campaignSystemPrompt("es")]) {
    for (const rule of LEAD_WITH_RULES) assert.ok(sys.includes(rule), rule.slice(0, 60));
  }
  const sys = systemPrompt("en");
  assert.match(sys, /the headline activity first, named as an event people do \(the evening beach party under the light show\), then the sunset-to-sunrise arc in the one place, then the port/);
  assert.match(sys, /The hook \(4–6 words, full stops\) and the walk-through sentence are BUILT FROM those moments/);
  assert.match(sys, /The dry beat comes LAST and is about the schedule, the sleeping or the shrug, never about the event/);
  assert.match(sys, /Energy comes from concrete, physical, present-tense moments .*never from adjectives/);
  assert.match(sys, /why_ship and who_for echo them as scenes/);
  assert.match(campaignSystemPrompt("en"), /Layout of email 1: the hook as the opening line, then the walk-through sentence \(both built from <lead_with>/);
  assert.match(campaignSystemPrompt("en"), /the campaign's email 1 and Facebook announcement\) open on the headline activity/);
  // the campaign writer sees the same moments list
  const user = campaignUserPrompt(seashoreFacts(), MARK_ANSWERS, "https://stillafloatcruising.com/group.html?g=x");
  assert.match(user, /1\. The headline activity, named as an event people do: beach party, light show/);
  // the bans for our own words are unchanged
  assert.match(sys, /no 'amazing', 'incredible', 'unforgettable' or exclamation marks in the words we write/);
});

test("nothing named in his answers: the writer is told to lead with the picture in his order, not handed an invented list", () => {
  const p = userPrompt(seashoreFacts(), normalizeAnswers({ pitch: "Four nights out of Port Canaveral with the people you already like.", audience: "a", occasion: "b", why_sailing: "c" }));
  assert.match(p, /<lead_with>\nNothing in his answers names an event, a sunset-to-sunrise arc or a port of call\. Lead with the first image/);
  assert.deepEqual(leadWith({}, seashoreFacts()), { event: null, arc: null, ports: null, scenes: [] });
});

test("one half of the arc is a scene detail, not the arc; a port in the pitch alone is found when the picture names none", () => {
  const lw = leadWith(normalizeAnswers({ pitch: "A bonfire on the sand at Ocean Cay. Dinner in Nassau.", why_sailing: "Sunrise from the deck." }), seashoreFacts());
  assert.deepEqual(lw.event, { terms: ["bonfire"], from: ["pitch sentence 1"] }, "the first event he names is the headline; a second one in another sentence is a scene");
  assert.equal(lw.arc, null);
  assert.deepEqual(lw.scenes, ["dinner", "sand", "sunrise"]);
  assert.deepEqual(lw.ports, { names: ["Nassau", "Ocean Cay MSC Marine Reserve"], from: ["pitch sentence 1", "pitch sentence 2"] });
});

test("the gentle check fires on the old subhead (no beach party, no sunset) and stays quiet on one that names the event and the arc", () => {
  const f = seashoreFacts();
  const old = copyNotes({ ...goodCopy(), subhead: OLD_SUBHEAD }, f, MARK_ANSWERS);
  assert.deepEqual(old, [
    { field: "subhead", problem: "the walk-through line does not mention the beach party the pitch names" },
    { field: "subhead", problem: 'the walk-through line does not carry the sunset-to-sunrise arc the why-sailing answer names (it needs both "sunset" and "sunrise")' },
  ]);
  assert.deepEqual(copyNotes({ ...goodCopy(), subhead: NEW_SUBHEAD }, f, MARK_ANSWERS), []);
  // each of the event's words is looked for: the party without the light show names the light show
  assert.deepEqual(copyNotes({ ...goodCopy(), subhead: "A beach party, then sunset and sunrise on one island." }, f, MARK_ANSWERS).map((n) => n.problem),
    ["the walk-through line does not mention the light show the pitch names"]);
});

test("the gentle check is a note, never a problem: the old subhead still passes validateCopy, so approval is not blocked", () => {
  const f = seashoreFacts();
  const copy = { ...goodCopy(), intro: VERBATIM, subhead: OLD_SUBHEAD, why_ship: "Sunset on the beach, a light show from the lighthouse, sunrise on the same sand.", email_body: `${VERBATIM}\n\nStill Afloat Cruising` };
  assert.deepEqual(validateCopy(copy, f, MARK_ANSWERS), []);
  assert.equal(copyNotes(copy, f, MARK_ANSWERS).length, 2);
});

test("the gentle check asks only what his answers name: no pitch moments, no note; Spanish and an empty subhead are not checked", () => {
  const f = seashoreFacts();
  assert.deepEqual(copyNotes({ ...goodCopy(), subhead: OLD_SUBHEAD }, f, normalizeAnswers({ pitch: "Four nights out of Port Canaveral with the people you already like.", audience: "a", occasion: "b", why_sailing: "c" })), []);
  assert.deepEqual(copyNotes({ ...goodCopy(), subhead: OLD_SUBHEAD }, f, {}), []);
  assert.deepEqual(copyNotes({ ...goodCopy(), subhead: OLD_SUBHEAD }, seashoreFacts("es"), MARK_ANSWERS), [], "Mark writes in English; the Spanish copy is a translation");
  assert.deepEqual(copyNotes({ ...goodCopy(), subhead: "" }, f, MARK_ANSWERS), [], "a missing subhead is already a problem");
  assert.deepEqual(copyNotes(null, f, MARK_ANSWERS), []);
});

test("a retry that happens anyway carries the notes; a note alone never reads as a broken rule", () => {
  const notes = copyNotes({ ...goodCopy(), subhead: OLD_SUBHEAD }, seashoreFacts(), MARK_ANSWERS);
  const withNotes = retryNote([{ field: "who_for", problem: "too long: 901 of 900 characters — shorten it, or ask Mark" }], notes);
  assert.match(withNotes, /Fix exactly these and change nothing else:\n- who_for: too long/);
  assert.match(withNotes, /And fix these too \(Mark wants them, though they do not block approval\); lead with the moments in <lead_with>:\n- subhead: the walk-through line does not mention the beach party/);
  assert.doesNotMatch(retryNote([{ field: "who_for", problem: "missing" }]), /And fix these too/);
});
