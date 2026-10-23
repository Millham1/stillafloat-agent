import { test } from "node:test";
import assert from "node:assert/strict";
import { campaignSystemPrompt, campaignUserPrompt } from "./group-campaign";
import {
  COPY_FIELDS, COPY_SCHEMA, INTERVIEW, buildFacts, displayName, formatDate, formatMoney, missingAnswers, newShareCode,
  normalizeAnswers, numbersIn, shipSlugCandidate, tidyCopy, userPrompt, validateCopy, type GroupCopy, humanizeAmenity, travelLines, portDisplayName, systemPrompt,
  ANSWER_MAX, DEFAULT_CTA, HOUSE_BANNED, HOUSE_VOICE_RULES, LEAD_WITH_RULES, PITCH_FIRST, ctaLine, ctaRule, copyNotes, leadWith, leadWithLines, missingPitchSentences, pitchCoverage, pitchGate, pitchNumberProblems, pitchRules, pitchSentences, retryNote, tooLong, withoutPitch, plannedForGroup, publicFacts, DIGITAL_CTA, QR_PROBLEM, ctaForFacebook, mentionsQr, withDisplayNames,
  IMAGE_URL_MAX, creditedPictureLinks, creditsForPictures, ignoredPictureAnswers, pageLook, validEmail, validPhone, safeImageUrl, DEFAULT_HOST_NAMES, HOST_NAMES_MAX, PITCH_NOTE, WELCOME_RULES, cabinPrices, hostNames, priceUnitOf, priceUnitText, travelLabel, pageLabel, PAGE_LABEL_MAX } from "./group-marketing";

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
    welcome: "We put this week together for the Post, and we would love to sail it with you. Have a look around, then tell us you are in…",
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

test("promises, sales pressure and banned words fail the copy, in English and Spanish", () => {
  const f = buildFacts(file(), rating, "en");
  for (const phrase of ["guaranteed sunshine", "cheaper than you think", "it is actually great", "hurry, cabins are selling fast", "perfect for families", "pure luxury", "a once-in-a-lifetime week", "the best price on the sea"]) {
    assert.ok(validateCopy({ ...goodCopy(), intro: phrase }, f).length >= 1, phrase);
  }
  const es = buildFacts(file(), rating, "es");
  for (const phrase of ["se lo garantizamos", "más barato de lo que cree", "apúrese, se agotan", "puro lujo"]) {
    assert.ok(validateCopy({ ...goodCopy(), intro: phrase }, es).length >= 1, phrase);
  }
});

test("Mark's register is not banned: his adjectives and exclamation marks pass in the words we write, in English and Spanish (Mark 2026-10-19)", () => {
  const f = buildFacts(file(), rating, "en");
  for (const phrase of ["an amazing week", "two incredible days", "the most beautiful sunrise!", "an unforgettable, breathtaking, world-class ultimate week", "ALL ON THE SAME CRUISE!"]) {
    assert.deepEqual(validateCopy({ ...goodCopy(), intro: phrase }, f), [], phrase);
  }
  const es = buildFacts(file(), rating, "es");
  for (const phrase of ["una semana increíble", "un viaje inolvidable e impresionante", "¡TODO EN EL MISMO CRUCERO!", "¡Zarpamos en marzo!"]) {
    assert.deepEqual(validateCopy({ ...goodCopy(), intro: phrase }, es), [], phrase);
  }
  // no exclamation-mark ban is left in the group-piece rules, in either language
  for (const lang of ["en", "es"] as const) assert.ok(!HOUSE_BANNED[lang].some((b) => b.re.test("Sunset!")), `${lang}: exclamation ban`);
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
  assert.deepEqual(validateCopy({ ...goodCopy(), headline: "x".repeat(221) }, f), [{ field: "headline", problem: "too long: 221 of 220 characters — shorten it, or ask Mark" }]);
  assert.deepEqual(validateCopy({ ...goodCopy(), headline: "x".repeat(220) }, f), [], "the one rising sentence may run to 220");
  assert.equal(tooLong(716, 600), "too long: 716 of 600 characters — shorten it, or ask Mark");
  assert.ok(!validateCopy({ ...goodCopy(), cta_label: "x".repeat(60) }, f).some((x) => /too long \(/.test(x.problem)), "the old wording is gone");
});

test("the character limits of each copy field", () => {
  assert.deepEqual(Object.fromEntries(COPY_FIELDS.map((x) => [x.key, x.max])), {
    welcome: 700, headline: 220, subhead: 160, intro: 900, why_ship: 900, who_for: 900, organizer_note: 400,
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


test("the group's air / hotel / transfer offer reads as plain lines (EN and ES) without a vendor name; per-traveler rows are not the group's offer", () => {
  const rows = [
    { kind: "flight", direction: "pre", provider: "Round trip from RDU", from_place: "Raleigh-Durham", price_per_person: 412, included: false, traveler_id: null, cabin_id: null },
    { kind: "hotel", direction: "pre", provider: "Hampton Inn Miami Airport", from_place: "Miami", reference: "1 night", price_per_person: "89.5", included: false, traveler_id: null, cabin_id: null },
    { kind: "transfer", direction: "pre", provider: "MSC motorcoach", from_place: "Hotel", to_place: "Cruise port", price_per_person: null, included: true, traveler_id: null, cabin_id: null },
    { kind: "flight", direction: "pre", provider: "AA 1234", from_place: "RDU", traveler_id: "t1", cabin_id: null },
  ];
  const en = travelLines(rows, "en");
  assert.equal(en.length, 3, "the traveler's own flight is not the group's offer");
  assert.equal(en[0]!.text, "Flight from Raleigh-Durham: $412 per person");
  assert.equal(en[1]!.text, "Hotel the night before in Miami (1 night): $89.50 per room", "a hotel with no unit of its own is per room");
  assert.equal(en[2]!.text, "Hotel to Cruise port: included in the cruise price");
  const es = travelLines(rows, "es");
  assert.equal(es[0]!.text, "Vuelo desde Raleigh-Durham: $412 por persona");
  assert.equal(es[1]!.text, "Hotel la noche anterior en Miami (1 noche): $89.50 por habitación");
  assert.equal(es[2]!.text, "Hotel a puerto de cruceros: incluido en el precio del crucero");
  // never the vendor: not the airline, the hotel or the transfer company, in either language, in any field of the line
  for (const line of [...en, ...es]) for (const vendor of ["Round trip", "Hampton", "MSC motorcoach", "motorcoach"]) assert.ok(!JSON.stringify(line).includes(vendor), `${vendor} must not reach a client: ${JSON.stringify(line)}`);
  assert.deepEqual(en.map((t) => [t.kind, t.label, t.priceText, t.priceUnit]), [
    ["flight", "Flight from Raleigh-Durham", "$412", "person"], ["hotel", "Hotel the night before in Miami (1 night)", "$89.50", "room"], ["transfer", "Hotel to Cruise port", null, "person"]]);
});

test("travel labels: every kind and direction, with and without places, in both languages; a flight may name where it lands", () => {
  const L = (r: Record<string, unknown>, lang: "en" | "es" = "en") => travelLabel(r, lang);
  // flights
  assert.equal(L({ kind: "flight", from_place: "Raleigh-Durham" }), "Flight from Raleigh-Durham");
  assert.equal(L({ kind: "flight", from_place: "Raleigh-Durham", to_place: "Miami" }), "Flight from Raleigh-Durham to Miami");
  assert.equal(L({ kind: "flight", to_place: "Miami" }), "Flight to Miami");
  assert.equal(L({ kind: "flight" }), "Flight");
  assert.equal(L({ kind: "flight", from_place: "Raleigh-Durham", to_place: "Miami" }, "es"), "Vuelo desde Raleigh-Durham a Miami");
  assert.equal(L({ kind: "flight" }, "es"), "Vuelo");
  // hotels: the night before is the default, after the cruise when the row says post
  assert.equal(L({ kind: "hotel", direction: "pre", from_place: "Miami" }), "Hotel the night before in Miami");
  assert.equal(L({ kind: "hotel", from_place: "Miami" }), "Hotel the night before in Miami", "no direction: the offer is the night before");
  assert.equal(L({ kind: "hotel", direction: "post", from_place: "Miami", reference: "2 nights" }), "Hotel after the cruise in Miami (2 nights)");
  assert.equal(L({ kind: "hotel", direction: "pre" }), "Hotel the night before");
  assert.equal(L({ kind: "hotel", direction: "post", from_place: "Miami", reference: "1 night" }, "es"), "Hotel después del crucero en Miami (1 noche)");
  assert.equal(L({ kind: "hotel", direction: "pre", from_place: "Miami", reference: "2 nights" }, "es"), "Hotel la noche anterior en Miami (2 noches)");
  assert.equal(L({ kind: "hotel", direction: "pre", from_place: "Miami", reference: "Pool view" }, "es"), "Hotel la noche anterior en Miami (Pool view)", "Mark's own words are left as he typed them");
  // transfers
  assert.equal(L({ kind: "transfer", from_place: "Hotel", to_place: "Cruise port" }), "Hotel to Cruise port");
  assert.equal(L({ kind: "transfer", from_place: "Cruise port", to_place: "Airport" }), "Cruise port to Airport");
  assert.equal(L({ kind: "transfer", from_place: "Cruise port", to_place: "Airport" }, "es"), "Puerto de cruceros a aeropuerto");
  assert.equal(L({ kind: "transfer", from_place: "Hotel", to_place: "Cruise port" }, "es"), "Hotel a puerto de cruceros");
  assert.equal(L({ kind: "transfer", from_place: "Gran Hotel", to_place: "Muelle 4" }, "es"), "Gran Hotel a Muelle 4", "Mark's own place names are left as typed");
  assert.equal(L({ kind: "transfer", from_place: "Hotel" }), "Transfer", "one end only: just the word");
  assert.equal(L({ kind: "transfer" }, "es"), "Traslado");
  // the provider is never read, whatever the kind
  for (const kind of ["flight", "hotel", "transfer"]) {
    for (const lang of ["en", "es"] as const) assert.ok(!L({ kind, provider: "Zzyzx Airways", from_place: "A", to_place: "B", reference: "x" }, lang).includes("Zzyzx"), `${kind} ${lang}`);
  }
});

test("a travel price says what it is per: a hotel is per room, a flight and a transfer per person, an explicit unit wins (EN and ES)", () => {
  assert.equal(priceUnitOf({ kind: "hotel" }), "room");
  assert.equal(priceUnitOf({ kind: "flight" }), "person");
  assert.equal(priceUnitOf({ kind: "transfer", price_unit: "person" }), "person");
  assert.equal(priceUnitOf({ kind: "hotel", price_unit: "person" }), "person", "Mark can set a hotel back to per person");
  assert.equal(priceUnitOf({ kind: "flight", price_unit: "room" }), "room");
  assert.equal(priceUnitOf({ kind: "hotel", price_unit: "bogus" }), "room", "an unknown unit falls back to the kind's own");
  assert.deepEqual(["person", "room"].flatMap((u) => (["en", "es"] as const).map((l) => priceUnitText(u as "person" | "room", l))), ["per person", "por persona", "per room", "por habitación"]);
  const rows = [
    { kind: "hotel", price_per_person: 125, price_unit: "room", included: false, from_place: "Miami", reference: "1 night" },
    { kind: "transfer", price_per_person: 45, price_unit: "person", included: false, from_place: "Hotel", to_place: "Cruise port" },
    { kind: "flight", price_per_person: 350, included: false, from_place: "Raleigh-Durham" },
    { kind: "hotel", price_per_person: 99, included: false, from_place: "Fort Lauderdale" },
    { kind: "hotel", price_per_person: null, included: false, from_place: "Tampa" },
  ];
  assert.deepEqual(travelLines(rows, "en").map((t) => t.text), [
    "Hotel the night before in Miami (1 night): $125 per room",
    "Hotel to Cruise port: $45 per person",
    "Flight from Raleigh-Durham: $350 per person",
    "Hotel the night before in Fort Lauderdale: $99 per room",
    "Hotel the night before in Tampa: available, price on request",
  ]);
  assert.deepEqual(travelLines(rows.slice(0, 3), "es").map((t) => t.text), [
    "Hotel la noche anterior en Miami (1 noche): $125 por habitación",
    "Hotel a puerto de cruceros: $45 por persona",
    "Vuelo desde Raleigh-Durham: $350 por persona",
  ]);
  // included wins over a price: nothing is "per" anything
  assert.equal(travelLines([{ kind: "hotel", price_per_person: 125, included: true, from_place: "Miami" }], "en")[0]!.text, "Hotel the night before in Miami: included in the cruise price");
});

test("perks shown to guests come from the fare inclusions, never the organizer's amenities; the prompt names the tap-the-link call to action and the upgrades line and never the advisor", () => {
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
  assert.match(sys, /never a person/); assert.match(sys, /the exact words "Tap here to book your spot!"/); assert.match(sys, /cabin upgrades are available/i);
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

test("a pitch sentence missing from the intro is a NOTE, never a problem: the page no longer shows the pitch, so it cannot stop approval (Mark 2026-10-20)", () => {
  const f = buildFacts(file(), rating, "en");
  const answers = { pitch: PITCH };
  const pitchNotes = (copy: GroupCopy, a: Parameters<typeof copyNotes>[2] = answers) => copyNotes(copy, f, a).filter((n) => n.problem.startsWith(PITCH_NOTE));
  assert.deepEqual(validateCopy(withPitch(), f, answers), []);
  assert.deepEqual(pitchNotes(withPitch()), [], "kept whole: nothing to say");
  // the pitch may run on into why_ship and who_for
  const spread = withPitch({ intro: "Four nights out of Miami with the people you already like.", why_ship: "Sunset on the beach, then a light show.", who_for: "Reply or scan the code and we will hold you a cabin." });
  assert.deepEqual(validateCopy(spread, f, answers), []);
  assert.deepEqual(pitchNotes(spread), []);
  // sentences cut: no problem (approval is not blocked) and one note each, naming the sentence
  const cut = withPitch({ intro: "Four nights out of Miami with the people you already like. A sunset, a show." });
  assert.deepEqual(validateCopy(cut, f, answers), [], "a missing pitch sentence must not make the page unapprovable");
  assert.deepEqual(pitchNotes(cut).map((x) => [x.field, x.problem.startsWith(`${PITCH_NOTE}: 'Sunset on the beach, then a light show.'`) || x.problem.startsWith(`${PITCH_NOTE}: 'Reply or scan the code and we will hold you a cabin.'`)]), [["intro", true], ["intro", true]]);
  assert.ok(pitchNotes(cut).every((n) => /does not stop approval/.test(n.problem)));
  // a sentence sitting only in the email or the post does not count as the paragraphs carrying the pitch (it is noted)
  assert.equal(validateCopy(withPitch({ intro: "Hello there.", email_body: PITCH, social_post: PITCH }), f, answers).length, 0);
  assert.equal(pitchNotes(withPitch({ intro: "Hello there.", email_body: PITCH, social_post: PITCH })).length, 3);
  // no pitch given (copy written before the rule): nothing to check
  assert.deepEqual(validateCopy(withPitch({ intro: "Hello there." }), f, {}), []);
  assert.deepEqual(pitchNotes(withPitch({ intro: "Hello there." }), {}), []);
  // every OTHER check still blocks on the same copy: the pitch's own numbers are still fact-checked
  assert.deepEqual(validateCopy(withPitch({ intro: "Hello there." }), f, { pitch: "Bus leaves the Post at 6." }).map((x) => x.field), ["pitch"]);
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

test("'Join Mark' and amenity points fail every field, in both languages; an exclamation mark does not", () => {
  const en = buildFacts(file(), rating, "en");
  for (const [field, text, want] of [
    ["headline", "Imagine joining us at sea. Join Mark on the Celebration", /Join Mark/],
    ["cta_blurb", "Tap here to book your spot! Join Mark!", /Join Mark/],
    ["subhead", "Join Mark on the Celebration", /Join Mark/],
    ["why_ship", "We have 3 amenity points to spend.", /amenity points/],
    ["who_for", "One amenity point goes to the group.", /amenity points/],
  ] as const) {
    const p = validateCopy({ ...goodCopy(), [field]: text }, en);
    assert.ok(p.some((x) => x.field === field && want.test(x.problem)), `${field}: ${text} -> ${JSON.stringify(p)}`);
  }
  const es = buildFacts(file(), rating, "es");
  for (const text of ["Únase a Mark en el barco", "Tenemos 3 puntos de beneficios", "Join Mark"]) {
    assert.ok(validateCopy({ ...goodCopy(), intro: text }, es).some((x) => x.field === "intro"), text);
  }
  // Mark as the contact is fine, and so is the "!" (the call to action and the payoff end on one)
  assert.deepEqual(validateCopy({ ...goodCopy(), cta_blurb: "Tap here to book your spot! Or call or text Mark at 919-346-6127." }, en), []);
  assert.deepEqual(validateCopy({ ...goodCopy(), subhead: "ALL ON THE SAME CRUISE!" }, en), []);
});

test("both prompts carry Mark's register verbatim, the exact call to action and the pitch rules", () => {
  const sys = systemPrompt("en");
  for (const rule of HOUSE_VOICE_RULES) assert.ok(sys.includes(rule), rule);
  assert.match(sys, /the hook is ONE flowing sentence that starts "Imagine…"/);
  assert.match(sys, /lands on a short capitalised payoff that ends in an exclamation mark/);
  assert.match(sys, /"Imagine, watching a Caribbean sunset, dancing to an amazing light show on the beach, then walking the beach to the most beautiful sunrise\.\.\.\.\. ALL ON THE SAME CRUISE!"/);
  assert.match(sys, /Never a chain of two-word sentences\. No fragments/);
  assert.match(sys, /no dry beat, no wink/);
  assert.match(sys, /never invent a superlative or an adjective he did not use/);
  assert.match(sys, /the occasion line is used exactly as he wrote it in the interview, with nothing added/);
  assert.match(sys, /the exact words "Tap here to book your spot!" \(in a Facebook text the same words end in a colon, "Tap here to book your spot:", and the link follows on the next line\), then the link, then the phone 919-346-6127/);
  assert.match(sys, /Never "Join Mark" as the hook/);
  assert.match(sys, /never "amenity points"/);
  // the old house voice is gone: no four-word hook, no dry beat, no wink, no "Scan the QR to join the fun"
  assert.doesNotMatch(sys, /Sunset\. Light show\. Sunrise\. Same beach\. Same cruise\./);
  assert.doesNotMatch(sys, /The only hard decision all week is when to sleep/);
  assert.doesNotMatch(sys, /Shoes optional/);
  assert.doesNotMatch(sys, /Scan the QR to join the fun/);
  assert.doesNotMatch(sys, /no exclamation marks anywhere/);
  assert.doesNotMatch(sys, /Dry, understated humor/);
  assert.match(sys, /every sentence of it into the intro, word for word, in his order, and cut nothing/);
  assert.match(sys, /character for character/);
  assert.match(sys, /If he wrote an exclamation mark, keep it; if he wrote 'incredible' or 'amazing', keep it/);
  assert.match(sys, /not even a closing exclamation mark becoming a full stop/);
  assert.match(sys, /are for the words WE write around the pitch\. They never apply inside his sentences/);
  assert.doesNotMatch(sys, /The only change allowed is a closing exclamation mark/);
  assert.match(sys, /Exclamation marks and the capitalised payoff are part of the register \(below\), in every piece\. Mark's pitch sentences are his own words/);
  assert.match(systemPrompt("es"), /sentence for sentence/, "Spanish is a faithful translation of the pitch");
  assert.match(systemPrompt("es"), /the exact words "¡Toque aquí para reservar su lugar!"/, "the Spanish call to action");
  assert.doesNotMatch(systemPrompt("es"), /every sentence of it into the intro, word for word/);
  assert.ok(pitchRules("email 1", "x").some((r) => r.includes("email 1")));
});

// ── Mark's pitch is verbatim: the bans that remain are for the words WE write (Mark 2026-10-19, Millham F/F 2027) ────────────

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

test("a paraphrase is not his sentence: 'two amazing days' for 'two incredible days' is noted as not kept, and only that; nothing blocks", () => {
  const f = buildFacts(file(), rating, "en");
  const copy = withPitch({ intro: SOFTENED });
  const p = validateCopy(copy, f, { pitch: MARK_PITCH });
  assert.deepEqual(p, [], "the page does not show the pitch, so a paraphrase of it is not a problem");
  // only his second sentence is noted (the first has the same words, only its closing mark differs)...
  assert.deepEqual(copyNotes(copy, f, { pitch: MARK_PITCH }).filter((x) => x.problem.startsWith(PITCH_NOTE)).map((x) => [x.field, x.problem.split(" (the group page")[0]]), [[
    "intro", `${PITCH_NOTE}: 'Enjoy  all that Nassau has to offer, then spend two incredible days at MSC's Ocean Cay, including an amazing evening beach party and light show from the island's lighthouse!'`]]);
  // it is the words that count, not just the banned ones: his 'incredible' dropped for a plain 'two days' is a cut too
  assert.equal(copyNotes(withPitch({ intro: VERBATIM.replace("two incredible days", "two days") }), f, { pitch: MARK_PITCH }).filter((x) => x.problem.startsWith(PITCH_NOTE)).length, 1);
  assert.equal(missingPitchSentences(MARK_PITCH, SOFTENED).length, 1, "the helper the campaign validator uses is unchanged");
});

test("the bans that remain still apply to the words WE write outside the pitch; his adjectives and marks do not trip them", () => {
  const f = buildFacts(file(), rating, "en");
  const answers = { pitch: MARK_PITCH };
  const p = validateCopy(withPitch({
    intro: `${VERBATIM} What an amazing week!`,
    why_ship: "An unforgettable week, cheaper than you think. Join Mark on the Seaside.",
    cta_blurb: "Tap here to book your spot!",
    social_post: `${VERBATIM}\nThree amenity points for the group. Guaranteed.`,
  }), f, answers);
  const has = (field: string, re: RegExp) => p.some((x) => x.field === field && re.test(x.problem));
  assert.ok(!has("intro", /./), "our amazing and our '!' after his pitch are the register now");
  assert.ok(has("why_ship", /cheaper/) && has("why_ship", /Join Mark/) && !has("why_ship", /unforgettable/));
  assert.ok(!has("cta_blurb", /./));
  assert.ok(has("social_post", /amenity points/) && has("social_post", /Guaranteed/i));
  assert.ok(!p.some((x) => x.problem.startsWith("Pitch sentence not kept")), JSON.stringify(p));
  // the pitch is still taken out first: "actually" in his sentence is his, the same word beside it is ours
  assert.deepEqual(validateCopy(withPitch({ intro: "We actually love it here." }), f, { pitch: "We actually love it here." }), []);
  assert.ok(validateCopy(withPitch({ intro: "We actually love it here. It is actually great." }), f, { pitch: "We actually love it here." }).some((x) => /uses "actually"/.test(x.problem)));
  // no pitch on the interview: nothing is his, and the bans that remain apply to every word
  assert.ok(validateCopy(withPitch({ intro: "Join Mark for a week. We actually mean it." }), f, {}).length >= 2);
  assert.deepEqual(validateCopy(withPitch({ intro: VERBATIM }), f, {}).filter((x) => !x.problem.startsWith("Pitch sentence not kept")), []);
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
// the hand-made sample Mark was shown (2026-10-19): one rising sentence, then the payoff
const SAMPLE_HEADLINE = "Imagine shopping Nassau in the morning, dancing under the Ocean Cay lighthouse light show at the beach party that night, then walking that same beach into a Bahamas sunrise… ALL ON THE SAME CRUISE!";
// the same walk-through with the sunset in it, as the writer should now produce it (headline = the sentence, subhead = the payoff)
const WALK = "Imagine shopping Nassau in the morning, watching the sunset from the beach at Ocean Cay, dancing under the lighthouse light show at the beach party that night, then walking that same beach into a Bahamas sunrise…";
/** Page copy for the Millham F/F 2027 file in Mark's register: no numbers but the file's, his pitch verbatim in the intro. */
function seashoreCopy(): GroupCopy {
  return {
    welcome: "We have wanted to sail this one together for a long time, and we hope you will be there with us. Look it over, then say you are in!",
    headline: WALK,
    subhead: "ALL ON THE SAME CRUISE!",
    intro: `${VERBATIM} Sailing May 9, 2027 on MSC Seashore from Port Canaveral, with the overnight at Ocean Cay.`,
    why_ship: "Ocean Cay is a private island, and we sleep next to it. Watch the sunset and the sunrise from the same island while walking the beach, or relax in a hammock with island breezes.",
    who_for: "Friends and family, first-timers welcome. Cabin upgrades are available, balcony and up, by request.",
    organizer_note: null,
    cta_label: "Tell us you're in",
    cta_blurb: "Tap here to book your spot!",
    email_subject: "A beach party under the lighthouse, then sunrise on the same beach",
    email_body: `${WALK} ALL ON THE SAME CRUISE!\n\n${VERBATIM}\n\nTap here to book your spot!\n\nStill Afloat Cruising`,
    social_post: `${WALK} ALL ON THE SAME CRUISE! Tap here to book your spot!`,
  };
}

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
  assert.match(block, /String these moments, in this order, into ONE rising sentence, then the payoff\./);
  assert.match(block, /The headline is that sentence, the payoff is the line under it, and the email and the posts open with the same sentence\./);
  assert.doesNotMatch(block, /dry beat/);
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
  assert.match(sys, /String these moments, in this order, into ONE rising sentence, then the payoff/);
  assert.match(sys, /The sentence starts 'Imagine…', every moment is a phrase of the one sentence \(never a sentence of its own\), the energy rises to the last moment/);
  assert.match(sys, /the sentence carries both words 'sunset' and 'sunrise'/);
  assert.match(sys, /The payoff never undercuts the event: no 'allegedly', no 'supposedly', no joke about the schedule or about sleeping/);
  assert.match(sys, /Energy comes from Mark's moments and his own words: concrete, present-tense things .*the adjectives and exclamation marks he used/);
  assert.match(sys, /why_ship and who_for echo them as scenes/);
  assert.match(campaignSystemPrompt("en"), /Layout of email 1: the 'Imagine…' sentence and its payoff as the opening \(built from <lead_with>/);
  assert.match(campaignSystemPrompt("en"), /the campaign's email 1 and Facebook announcement\) open with the same 'Imagine…' sentence and its payoff/);
  // the campaign writer sees the same moments list
  const user = campaignUserPrompt(seashoreFacts(), MARK_ANSWERS, "https://stillafloatcruising.com/group.html?g=x");
  assert.match(user, /1\. The headline activity, named as an event people do: beach party, light show/);
  // the old ban on adjectives and exclamation marks in our own words is gone
  assert.doesNotMatch(sys, /no 'amazing', 'incredible', 'unforgettable' or exclamation marks/);
});

test("nothing named in his answers: the writer is told to lead with the picture in his order, not handed an invented list", () => {
  const p = userPrompt(seashoreFacts(), normalizeAnswers({ pitch: "Four nights out of Port Canaveral with the people you already like.", audience: "a", occasion: "b", why_sailing: "c" }));
  assert.match(p, /<lead_with>\nNothing in his answers names an event, a sunset-to-sunrise arc or a port of call\. String the first image in "The picture the reader should see", then the next, in his order, into ONE rising sentence, then the payoff/);
  assert.deepEqual(leadWith({}, seashoreFacts()), { event: null, arc: null, ports: null, scenes: [] });
});

test("one half of the arc is a scene detail, not the arc; a port in the pitch alone is found when the picture names none", () => {
  const lw = leadWith(normalizeAnswers({ pitch: "A bonfire on the sand at Ocean Cay. Dinner in Nassau.", why_sailing: "Sunrise from the deck." }), seashoreFacts());
  assert.deepEqual(lw.event, { terms: ["bonfire"], from: ["pitch sentence 1"] }, "the first event he names is the headline; a second one in another sentence is a scene");
  assert.equal(lw.arc, null);
  assert.deepEqual(lw.scenes, ["dinner", "sand", "sunrise"]);
  assert.deepEqual(lw.ports, { names: ["Nassau", "Ocean Cay MSC Marine Reserve"], from: ["pitch sentence 1", "pitch sentence 2"] });
});

/** Only the notes about the walk-through sentence (the headline and its payoff). */
const walkNotes = (copy: unknown, facts: Parameters<typeof copyNotes>[1], answers: Parameters<typeof copyNotes>[2]) => copyNotes(copy, facts, answers).filter((n) => n.field === "headline");

test("the gentle check fires on the old walk-through (no beach party, no sunset) and stays quiet on a headline that names the event and the arc", () => {
  const f = seashoreFacts();
  const old = walkNotes({ ...goodCopy(), headline: OLD_SUBHEAD, subhead: "" }, f, MARK_ANSWERS);
  assert.deepEqual(old, [
    { field: "headline", problem: "the walk-through sentence does not mention the beach party the pitch names" },
    { field: "headline", problem: 'the walk-through sentence does not carry the sunset-to-sunrise arc the why-sailing answer names (it needs both "sunset" and "sunrise")' },
  ]);
  assert.deepEqual(walkNotes({ ...goodCopy(), headline: NEW_SUBHEAD }, f, MARK_ANSWERS), []);
  assert.deepEqual(walkNotes(seashoreCopy(), f, MARK_ANSWERS), [], "the walk-through the writer should now produce, with its payoff under it");
  // the payoff line under the headline counts as part of the lead
  assert.deepEqual(walkNotes({ ...goodCopy(), headline: "Imagine an evening beach party under a lighthouse light show…", subhead: "Sunset to sunrise on one island!" }, f, MARK_ANSWERS), []);
  // each of the event's words is looked for: the party without the light show names the light show
  assert.deepEqual(walkNotes({ ...goodCopy(), headline: "A beach party, then sunset and sunrise on one island." }, f, MARK_ANSWERS).map((n) => n.problem),
    ["the walk-through sentence does not mention the light show the pitch names"]);
  // the hand-made sample as written has the sunrise but not the sunset, so the gentle check says so (a note, never a block)
  assert.deepEqual(walkNotes({ ...goodCopy(), headline: SAMPLE_HEADLINE, subhead: "ALL ON THE SAME CRUISE!" }, f, MARK_ANSWERS).map((n) => n.field), ["headline"]);
});

test("the gentle check is a note, never a problem: the old walk-through still passes validateCopy, so approval is not blocked", () => {
  const f = seashoreFacts();
  const copy = { ...goodCopy(), headline: OLD_SUBHEAD, intro: VERBATIM, why_ship: "Sunset on the beach, a light show from the lighthouse, sunrise on the same sand.", email_body: `${VERBATIM}\n\nStill Afloat Cruising` };
  assert.deepEqual(validateCopy(copy, f, MARK_ANSWERS), []);
  assert.equal(copyNotes(copy, f, MARK_ANSWERS).length, 2);
});

test("the gentle check asks only what his answers name: no pitch moments, no note; Spanish and an empty headline are not checked", () => {
  const f = seashoreFacts();
  const walk = (copy: unknown, facts: ReturnType<typeof seashoreFacts>, answers: Parameters<typeof copyNotes>[2]) => copyNotes(copy, facts, answers).filter((n) => n.field === "headline");
  assert.deepEqual(walk({ ...goodCopy(), headline: OLD_SUBHEAD }, f, normalizeAnswers({ pitch: "Four nights out of Port Canaveral with the people you already like.", audience: "a", occasion: "b", why_sailing: "c" })), []);
  assert.deepEqual(walk({ ...goodCopy(), headline: OLD_SUBHEAD }, f, {}), []);
  assert.deepEqual(copyNotes({ ...goodCopy(), headline: OLD_SUBHEAD }, seashoreFacts("es"), MARK_ANSWERS), [], "Mark writes in English; the Spanish copy is a translation");
  assert.deepEqual(walk({ ...goodCopy(), headline: "" }, f, MARK_ANSWERS), [], "a missing headline is already a problem");
  assert.deepEqual(copyNotes(null, f, MARK_ANSWERS), []);
});

test("a retry that happens anyway carries the notes; a note alone never reads as a broken rule", () => {
  const notes = copyNotes({ ...goodCopy(), headline: OLD_SUBHEAD }, seashoreFacts(), MARK_ANSWERS);
  const withNotes = retryNote([{ field: "who_for", problem: "too long: 901 of 900 characters — shorten it, or ask Mark" }], notes);
  assert.match(withNotes, /Fix exactly these and change nothing else:\n- who_for: too long/);
  assert.match(withNotes, /And fix these too \(Mark wants them, though they do not block approval\); string the moments in <lead_with> into the one rising sentence:\n- headline: the walk-through sentence does not mention the beach party/);
  assert.doesNotMatch(retryNote([{ field: "who_for", problem: "missing" }]), /And fix these too/);
});

// ── Mark's register (Mark 2026-10-19: "it is not my voice or style, you have concatenated meaningful phrases so they have no impact") ────

test("with Mark's own answers the writer's prompt carries the register: one rising sentence through his moments, the payoff, never a chain of two-word sentences", () => {
  const sys = systemPrompt("en", MARK_ANSWERS), user = userPrompt(seashoreFacts(), MARK_ANSWERS);
  // the register rules, the moments list in his order, and the instruction that joins them
  assert.ok(HOUSE_VOICE_RULES.every((r) => sys.includes(r)));
  assert.ok(LEAD_WITH_RULES.every((r) => sys.includes(r)));
  assert.match(sys, /String these moments, in this order, into ONE rising sentence, then the payoff/);
  assert.match(user, /String these moments, in this order, into ONE rising sentence, then the payoff\./);
  assert.match(user, /1\. The headline activity, named as an event people do: beach party, light show/);
  assert.match(user, /2\. The arc, sunset to sunrise in the one place: sunset, then sunrise/);
  assert.match(user, /3\. The port: Nassau/);
  assert.match(user, /The picture the reader should see: The image of the lighthouse beach party, with the insets of the sunset\/sunrise beach images, and an image of Nassau\./);
  assert.match(user, /Watch the sunset and the sunrise from the same island while walking the beach or relax in a hammock with island breezes/);
  assert.match(user, /the headline is ONE rising sentence through the <lead_with> moments in that order, the subhead is its capitalised payoff, and never a chain of two-word sentences/);
  // the headline is the sentence, the subhead its payoff; intro = his pitch verbatim, then the facts
  assert.match(sys, /headline = the one rising 'Imagine…' sentence built from <lead_with> \(about 200 characters at most\)\. subhead = the payoff alone, a short capitalised line ending in '!'\. intro = Mark's pitch, verbatim, then the facts that matter/);
  assert.match(sys, /The headline IS that sentence and the subhead is its payoff\. The sentence starts 'Imagine…', every moment is a phrase of the one sentence \(never a sentence of its own\)/);
  // fragments are forbidden by the prompt, in so many words (and the examples never model them)
  assert.match(sys, /Never a chain of two-word sentences\. No fragments, no lists of nouns with full stops \("Beach party\. Light show\. Sunrise\."\)/);
  assert.doesNotMatch(sys, /Hook = the experience in 4–6 words/);
  assert.doesNotMatch(sys, /full stops, no exclamation marks/);
  // his adjectives and his exclamation marks are the register, and the energy is taken from his words
  assert.match(sys, /his adjectives \("amazing", "incredible", "most beautiful"\) and his exclamation marks are part of the register and are allowed in the words we write, in every piece/);
  assert.match(sys, /Never an invented superlative, never a stack of adjectives he did not use/);
  assert.doesNotMatch(sys, /never from adjectives/);
  assert.match(sys, /Humor only where he wrote it/);
  assert.match(sys, /nothing added, no wink/);
});

test("the validator accepts the hand-made sample (its '!' and its capitals) as a headline and his pitch verbatim as the intro, and rejects 'Join Mark'", () => {
  const f = seashoreFacts();
  const copy = seashoreCopy();
  assert.deepEqual(validateCopy(copy, f, MARK_ANSWERS), []);
  assert.deepEqual(validateCopy({ ...copy, headline: SAMPLE_HEADLINE, subhead: "Four nights. Ocean Cay overnight." }, f, MARK_ANSWERS), [], "the whole sample, payoff included, as the headline");
  assert.ok(SAMPLE_HEADLINE.length <= 220 && SAMPLE_HEADLINE.includes("!") && SAMPLE_HEADLINE.includes("ALL ON THE SAME CRUISE!"));
  assert.ok(validateCopy({ ...copy, headline: "Join Mark for a beach party under a lighthouse light show… ALL ON THE SAME CRUISE!" }, f, MARK_ANSWERS).some((x) => x.field === "headline" && /Join Mark/.test(x.problem)));
  assert.ok(validateCopy({ ...copy, email_body: `Join Mark on the Seashore.\n\n${VERBATIM}\n\nStill Afloat Cruising` }, f, MARK_ANSWERS).some((x) => x.field === "email_body" && /Join Mark/.test(x.problem)));
  assert.ok(validateCopy({ ...copy, why_ship: "Amenity points pay for the party." }, f, MARK_ANSWERS).some((x) => x.field === "why_ship" && /amenity points/.test(x.problem)));
  // numbers still come only from the file or his answers, whatever the register
  assert.ok(validateCopy({ ...copy, headline: `${SAMPLE_HEADLINE} Only 38 cabins!` }, f, MARK_ANSWERS).some((x) => /not in the group file: 38/.test(x.problem)));
});

test("a fragment chain is not banned by a rule (a model may still write it), and the prompt forbids it in so many words; the gentle check still sees what it names", () => {
  const f = seashoreFacts();
  const fragments = { ...seashoreCopy(), headline: "Beach party. Light show. Sunrise. One island.", subhead: "Same cruise." };
  assert.deepEqual(validateCopy(fragments, f, MARK_ANSWERS), [], "no validator rule against fragments");
  assert.match(systemPrompt("en", MARK_ANSWERS), /Never a chain of two-word sentences/);
  assert.match(campaignSystemPrompt("en", MARK_ANSWERS), /Never a chain of two-word sentences/);
  assert.match(systemPrompt("en", MARK_ANSWERS), /Each moment keeps its meaning because it sits inside the one sentence with the moments around it; chopped into fragments it has no impact/);
});

test("the poster says 'Use the QR code to book your spot!'; every digital piece says 'Tap here to book your spot!'; the interview's cta_line chooses another per group", () => {
  assert.equal(DEFAULT_CTA.en, "Use the QR code to book your spot!");
  assert.equal(DIGITAL_CTA.en, "Tap here to book your spot!");
  assert.equal(DIGITAL_CTA.es, "¡Toque aquí para reservar su lugar!");
  assert.deepEqual(ctaLine({}, "en", "print"), { text: "Use the QR code to book your spot!", custom: false });
  assert.deepEqual(ctaLine({ cta_line: "   " }, "en", "print"), { text: "Use the QR code to book your spot!", custom: false });
  assert.deepEqual(ctaLine({}, "es", "print"), { text: "¡Use el código QR para reservar su lugar!", custom: false });
  assert.deepEqual(ctaLine({}, "en", "digital"), { text: "Tap here to book your spot!", custom: false });
  assert.deepEqual(ctaLine({}, "es", "digital"), { text: "¡Toque aquí para reservar su lugar!", custom: false });
  for (const medium of ["print", "digital"] as const) assert.deepEqual(ctaLine({ cta_line: " Scan the QR to join the fun " }, "en", medium), { text: "Scan the QR to join the fun", custom: true });
  // a Facebook text writes the line with a colon, and the link follows
  assert.equal(ctaForFacebook({}, "en"), "Tap here to book your spot:");
  assert.equal(ctaForFacebook({}, "es"), "¡Toque aquí para reservar su lugar:");
  assert.equal(ctaForFacebook({ cta_line: "Join the fun!" }, "en"), "Join the fun!");
  // the question is on the interview, optional, and stays a text answer
  const q = INTERVIEW.find((x) => x.key === "cta_line")!;
  assert.equal(q.type, "text"); assert.notEqual(q.required, true); assert.match(q.hint ?? "", /Use the QR code to book your spot!/); assert.match(q.hint ?? "", /Tap here to book your spot!/);
  assert.equal(normalizeAnswers({ cta_line: "  Scan the QR to join the fun  " })["cta_line"], "Scan the QR to join the fun");
  assert.equal(normalizeAnswers({})["cta_line"], "");
  // the page prompt and the campaign prompt name it, with the link, then the phone, and never a QR code
  const rule = ctaRule({}, "en", "in every piece");
  assert.match(rule, /the exact words "Tap here to book your spot!" \(in a Facebook text the same words end in a colon, "Tap here to book your spot:", and the link follows on the next line\), then the link, then the phone 919-346-6127/);
  assert.match(rule, /Never mention a QR code: a QR code is for the printed poster only/);
  assert.ok(systemPrompt("en").includes(rule.replace("in every piece", "in the cta_blurb, the email_body and the social_post")));
  assert.ok(campaignSystemPrompt("en").includes(ctaRule({}, "en", "in EVERY piece (every email and every Facebook text: the link is the info sheet, tapped on a phone or a computer; no piece carries a QR code, which is printed on the poster only)")));
  assert.doesNotMatch(campaignSystemPrompt("en"), /Use the QR code to book your spot!/);
  assert.doesNotMatch(campaignUserPrompt(buildFacts(file(), rating, "en"), {}, "https://x.test/group.html?g=abc"), /carries the QR|on print it is a QR/);
  // another line, chosen for the group, replaces it everywhere and never leaves the default behind
  const own = { cta_line: "Scan the QR to join the fun" };
  for (const sys of [systemPrompt("en", own), campaignSystemPrompt("en", own)]) {
    assert.match(sys, /the exact words "Scan the QR to join the fun", then the link, then the phone/);
    assert.doesNotMatch(sys, /Use the QR code to book your spot!|Tap here to book your spot!/);
  }
  assert.match(systemPrompt("es", own), /the line "Scan the QR to join the fun", translated into natural Latin American Spanish, then the link/);
});

test("a digital piece that names a QR code fails; Mark's own pitch sentences and his own cta_line may", () => {
  const en = buildFacts(file(), rating, "en");
  const bad = validateCopy({ ...goodCopy(), cta_blurb: "Use the QR code to book your spot!" }, en);
  assert.deepEqual(bad.filter((p) => p.field === "cta_blurb").map((p) => p.problem), [QR_PROBLEM]);
  assert.ok(validateCopy({ ...goodCopy(), social_post: "Scan the QR and you are in." }, en).some((p) => p.field === "social_post" && p.problem === QR_PROBLEM));
  // an ordinary word that merely contains the letters is not a QR code
  assert.deepEqual(validateCopy({ ...goodCopy(), cta_blurb: "Tap here to book your spot!" }, en), []);
  assert.equal(mentionsQr("Sqrt and Qrow", {}, "en"), false);
  assert.equal(mentionsQr("el código QR", {}, "es"), true);
  // his own words are his: a pitch sentence and a cta_line he typed are not flagged
  assert.equal(mentionsQr("Scan the QR to join the fun!", { pitch: "Scan the QR to join the fun!" }, "en"), false);
  assert.equal(mentionsQr("Scan the QR to join the fun. Call us.", { cta_line: "Scan the QR to join the fun" }, "en"), false);
  assert.equal(mentionsQr("Scan the QR to join the fun. Also use the QR code.", { cta_line: "Scan the QR to join the fun" }, "en"), true);
});

// ── The info page asks one thing: "I'm interested" (Mark 2026-10-19) ──────────

test("'planned for the group' is copied from Mark's own words and never composed", () => {
  assert.deepEqual(plannedForGroup({ pitch: "Everyone gets a $25 onboard credit and a toast." }), ["$25 onboard credit"]);
  assert.deepEqual(plannedForGroup({ extras: "Each cabin gets an onboard credit of $50 per cabin." }), ["onboard credit of $50 per cabin"]);
  assert.deepEqual(plannedForGroup({ pitch: "$25 on-board credit", why_sailing: "A $25 onboard credit again" }), ["$25 on-board credit", "$25 onboard credit"]);
  assert.deepEqual(plannedForGroup({ pitch: "A sunset-to-sunrise party and a group dinner." }), []);
  assert.deepEqual(plannedForGroup({ pitch: "Onboard credit is possible", extras: "no numbers here" }), []);   // no amount named: nothing to print
  assert.deepEqual(plannedForGroup({ audience: "$25 onboard credit", cta_line: "$25 onboard credit" }), []);   // only the answers that describe the trip
});

// ── Names print in capitals on a contract; clients read them as names (Mark 2026-10-19: "MSC SEASHORE") ────────────

test("displayName: ship and line names in title case, acronyms and roman numerals kept upper, a name with lower case left alone", () => {
  assert.equal(displayName("MSC SEASHORE"), "MSC Seashore");
  assert.equal(displayName("MSC SEASCAPE"), "MSC Seascape");
  assert.equal(displayName("NCL JADE"), "NCL Jade");
  assert.equal(displayName("RCI ALLURE OF THE SEAS"), "RCI Allure of the Seas");
  assert.equal(displayName("NORWEGIAN CRUISE LINE"), "Norwegian Cruise Line");
  assert.equal(displayName("ROYAL CARIBBEAN INTERNATIONAL"), "Royal Caribbean International");
  assert.equal(displayName("HOLLAND AMERICA LINE"), "Holland America Line");
  assert.equal(displayName("CARNIVAL CELEBRATION II"), "Carnival Celebration II");
  assert.equal(displayName("QUEEN MARY IV"), "Queen Mary IV");
  assert.equal(displayName("EXPLORER VII"), "Explorer VII");
  assert.equal(displayName("P&O ARVIA"), "P&O Arvia");
  assert.equal(displayName("COSTA FAVOLOSA"), "Costa Favolosa");
  assert.equal(displayName("MARDI GRAS"), "Mardi Gras");
  assert.equal(displayName("  MSC   SEASHORE "), "MSC   Seashore");
  assert.equal(displayName("Norwegian Prima"), "Norwegian Prima");
  assert.equal(displayName("MSC Seashore"), "MSC Seashore");
  assert.equal(displayName("AIDAnova"), "AIDAnova", "a mixed-case spelling is the line's own");
  assert.equal(displayName("MIX"), "Mix", "only real roman numerals stay upper");
  assert.equal(displayName("CIVIC"), "Civic");
  assert.equal(displayName(undefined), "");
});

test("a new file is saved with the ship and the line in display case, and nothing else touched", () => {
  const row = { name: "Post 12 Cruise", cruise_line: "MSC CRUISES", ship_name: "MSC SEASHORE", embark_port: "PCV", nights: 4 };
  assert.deepEqual(withDisplayNames(row), { name: "Post 12 Cruise", cruise_line: "MSC Cruises", ship_name: "MSC Seashore", embark_port: "PCV", nights: 4 });
  assert.deepEqual(withDisplayNames({ ship_name: "Carnival Celebration", cruise_line: null }), { ship_name: "Carnival Celebration", cruise_line: null });
  assert.deepEqual(withDisplayNames({ name: "x" }), { name: "x" });
  assert.equal(row.ship_name, "MSC SEASHORE", "the input is not changed");
});


// ── The look of the public page (Mark 2026-10-20: every group page looks like the approved marketing) ──────────────────

const SUPABASE_BASE = "https://abcd1234efgh.supabase.co";
/** Run `fn` with SUPABASE_URL set (or unset) and put it back, so no test sees another's value. */
function withSupabaseUrl<T>(url: string | undefined, fn: () => T): T {
  const before = process.env["SUPABASE_URL"];
  if (url === undefined) delete process.env["SUPABASE_URL"]; else process.env["SUPABASE_URL"] = url;
  try { return fn(); } finally { if (before === undefined) delete process.env["SUPABASE_URL"]; else process.env["SUPABASE_URL"] = before; }
}

test("the interview has the optional look questions right after the call to action (the three pictures and the two new picture bands), then who the invitation is from, the page name and the day notes, and the old questions keep their order", () => {
  const keys = INTERVIEW.map((q) => q.key);
  const i = keys.indexOf("cta_line");
  assert.deepEqual(keys.slice(i + 1, i + 4), ["taxes_included", "hero_photo", "host_photo"]);
  assert.deepEqual(keys, ["pitch", "picture", "occasion_line", "reference", "audience", "occasion", "why_sailing", "who_fits", "organizer_quote", "extras", "cta_line", "taxes_included", "hero_photo", "host_photo", "photo_plan", "photo_cabin", "host_names", "page_label", "day_notes", "tone", "show_prices", "show_rating"]);
  // Mark 2026-10-23 (design v2 of the group page): two more picture links and a note for any day of the plan, all optional
  const byKey = Object.fromEntries(INTERVIEW.map((q) => [q.key, q]));
  assert.equal(byKey["photo_plan"]!.type, "text"); assert.equal(byKey["photo_plan"]!.label, "Picture above the day-by-day plan (link, optional)");
  assert.equal(byKey["photo_cabin"]!.type, "text"); assert.equal(byKey["photo_cabin"]!.label, "Picture above the cabin prices (link, optional)");
  assert.equal(byKey["day_notes"]!.type, "long"); assert.equal(byKey["day_notes"]!.label, "A note for any day of the plan (optional)");
  assert.equal(byKey["day_notes"]!.hint, "One line per day, starting with the date as the plan prints it, for example: May 11: The beach party and light show at the lighthouse.");
  for (const k of ["photo_plan", "photo_cabin", "day_notes"]) assert.notEqual(byKey[k]!.required, true, `${k} is optional`);
  // the rating question stays so stored answers still validate, but the page no longer shows it
  assert.equal(byKey["show_rating"]!.type, "yesno"); assert.match(byKey["show_rating"]!.hint ?? "", /No longer shown on the group page/);
  const [taxes, hero, host] = [INTERVIEW[i + 1]!, INTERVIEW[i + 2]!, INTERVIEW[i + 3]!];
  assert.equal(taxes.type, "yesno"); assert.equal(taxes.fallback, false);
  assert.equal(taxes.label, "Do the quoted cabin prices include taxes and port fees?");
  assert.equal(hero.type, "text"); assert.equal(hero.label, "Top picture for the group page (link, optional)");
  assert.match(hero.hint ?? "", /replaces the site's generic picture/i);
  assert.equal(host.type, "text"); assert.equal(host.label, "Photo of the hosts, shown small in the top-right corner (link, optional)");
  for (const q of [taxes, hero, host]) assert.notEqual(q.required, true, `${q.key} is optional`);
  assert.deepEqual(INTERVIEW.filter((q) => q.required).map((q) => q.key), ["pitch", "audience", "occasion", "why_sailing"], "no new required question");
});

test("normalizeAnswers keeps the three look answers, and an empty interview leaves them off", () => {
  const a = normalizeAnswers({ taxes_included: true, hero_photo: "  https://stillafloatcruising.com/assets/images/x.jpg  ", host_photo: "https://stillafloatcruising.com/h.png" });
  assert.equal(a["taxes_included"], true);
  assert.equal(a["hero_photo"], "https://stillafloatcruising.com/assets/images/x.jpg", "trimmed like every text answer");
  assert.equal(a["host_photo"], "https://stillafloatcruising.com/h.png");
  const blank = normalizeAnswers({});
  assert.equal(blank["taxes_included"], false); assert.equal(blank["hero_photo"], ""); assert.equal(blank["host_photo"], "");
  assert.equal(normalizeAnswers({ taxes_included: "yes" })["taxes_included"], false, "only a real boolean counts as yes");
  assert.deepEqual(missingAnswers(blank), ["pitch", "audience", "occasion", "why_sailing"], "the look answers never block writing");
  for (const k of ["photo_plan", "photo_cabin", "day_notes"]) assert.equal(blank[k], "", `${k} starts empty`);
});

test("safeImageUrl accepts https pictures on stillafloatcruising.com and on the project's public storage, and nothing else", () => {
  withSupabaseUrl(SUPABASE_BASE, () => {
    assert.equal(safeImageUrl("https://stillafloatcruising.com/assets/images/hero.png"), "https://stillafloatcruising.com/assets/images/hero.png");
    assert.equal(safeImageUrl("  https://stillafloatcruising.com/a.jpg  "), "https://stillafloatcruising.com/a.jpg", "surrounding space is trimmed");
    assert.equal(safeImageUrl("https://STILLAFLOATCRUISING.com/a.jpg"), "https://stillafloatcruising.com/a.jpg", "the host is compared case-blind and returned normalised");
    assert.equal(safeImageUrl(`${SUPABASE_BASE}/storage/v1/object/public/group-assets/g1/hero.jpg`), `${SUPABASE_BASE}/storage/v1/object/public/group-assets/g1/hero.jpg`);
    // the project's host, but not its public storage path (the REST API, the auth API, a private object)
    for (const path of ["/rest/v1/groups", "/auth/v1/user", "/storage/v1/object/sign/group-assets/x.jpg", "/storage/v1/object/authenticated/x.jpg", "/storage/v1/objects/public/x", "/"]) {
      assert.equal(safeImageUrl(`${SUPABASE_BASE}${path}`), null, path);
    }
    // not on our hosts
    for (const u of ["https://example.com/a.jpg", "https://stillafloatcruising.com.evil.example/a.jpg", "https://evilstillafloatcruising.com/a.jpg", "https://notstillafloatcruising.com/a.jpg",
      "https://stillafloatcruising.org/a.jpg", "https://www.stillafloatcruising.com/a.jpg", "https://other-project.supabase.co/storage/v1/object/public/x/y.jpg",
      "https://drive.google.com/file/d/abc/view", "https://i.imgur.com/a.jpg", "//stillafloatcruising.com/a.jpg", "/assets/images/a.jpg", "stillafloatcruising.com/a.jpg"]) {
      assert.equal(safeImageUrl(u), null, u);
    }
  });
});

test("safeImageUrl refuses http, script and data links, and any link that could break out of where it is written", () => {
  withSupabaseUrl(SUPABASE_BASE, () => {
    assert.equal(safeImageUrl("http://stillafloatcruising.com/a.jpg"), null, "http");
    assert.equal(safeImageUrl(`http://abcd1234efgh.supabase.co/storage/v1/object/public/x/a.jpg`), null, "http on the project host");
    for (const u of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:image/png;base64,AAAA", "data:text/html,<script>alert(1)</script>", "blob:https://stillafloatcruising.com/abc", "ftp://stillafloatcruising.com/a.jpg", "file:///etc/passwd"]) {
      assert.equal(safeImageUrl(u), null, u);
    }
    // quotes, parentheses, brackets, spaces, backslashes and control characters — in the path, the query or the fragment
    for (const bad of ['"', "'", "(", ")", "<", ">", "`", "{", "}", " ", "\t", "\n", "\\", "|", "^", "\u0000", "\u007f"]) {
      assert.equal(safeImageUrl(`https://stillafloatcruising.com/a${bad}b.jpg`), null, JSON.stringify(bad) + " in the path");
      assert.equal(safeImageUrl(`https://stillafloatcruising.com/a.jpg?x=${bad}y`), null, JSON.stringify(bad) + " in the query");
    }
    assert.equal(safeImageUrl('https://stillafloatcruising.com/a.jpg");background:url(//evil.example/x'), null, "a CSS break-out");
    assert.equal(safeImageUrl("https://stillafloatcruising.com/a.jpg' onerror='alert(1)"), null, "an attribute break-out");
    assert.equal(safeImageUrl("https://stillafloatcruising.com/a.jpg url(x)"), null, "css url()");
    // a login, a port or a look-alike host written with an @
    assert.equal(safeImageUrl("https://user:pass@stillafloatcruising.com/a.jpg"), null, "credentials");
    assert.equal(safeImageUrl("https://stillafloatcruising.com@evil.example/a.jpg"), null, "the real host is after the @");
    assert.equal(safeImageUrl("https://evil.example@stillafloatcruising.com/a.jpg"), null, "a login in front of our host");
    assert.equal(safeImageUrl("https://stillafloatcruising.com:8443/a.jpg"), null, "a port");
    assert.equal(safeImageUrl("https://stillafloatcruising.com\\@evil.example/a.jpg"), null, "a backslash");
    // not a link at all
    for (const v of [null, undefined, 42, true, {}, [], "", "   ", "not a url", "https://", "https:///a.jpg"]) assert.equal(safeImageUrl(v), null, JSON.stringify(v));
    assert.equal(safeImageUrl(`https://stillafloatcruising.com/${"a".repeat(IMAGE_URL_MAX)}.jpg`), null, "a very long link");
  });
});

test("safeImageUrl takes the storage host from SUPABASE_URL, and falls back to the project the site is wired to when it is unset", () => {
  const other = "https://zzzz9999.supabase.co/storage/v1/object/public/b/x.jpg";
  withSupabaseUrl(SUPABASE_BASE, () => assert.equal(safeImageUrl(other), null, "another project is refused"));
  withSupabaseUrl("https://zzzz9999.supabase.co", () => {
    assert.equal(safeImageUrl(other), other);
    assert.equal(safeImageUrl(`${SUPABASE_BASE}/storage/v1/object/public/b/x.jpg`), null, "the project that is not configured is refused");
  });
  withSupabaseUrl("https://zzzz9999.supabase.co/", () => assert.equal(safeImageUrl(other), other, "a trailing slash on SUPABASE_URL does not matter"));
  // unset (or still the template value): the project persistence.ts falls back to
  const fallback = "https://gbjfrnrkkjnutmogdzln.supabase.co/storage/v1/object/public/b/x.jpg";
  withSupabaseUrl(undefined, () => { assert.equal(safeImageUrl(fallback), fallback); assert.equal(safeImageUrl(other), null); });
  withSupabaseUrl("https://aBcDe.supabase.co", () => { assert.equal(safeImageUrl(fallback), fallback); assert.equal(safeImageUrl("https://aBcDe.supabase.co/storage/v1/object/public/b/x.jpg"), null); });
  // a SUPABASE_URL that is not https (a local stack) never lets a picture through on that host
  withSupabaseUrl("http://127.0.0.1:54321", () => assert.equal(safeImageUrl("http://127.0.0.1:54321/storage/v1/object/public/b/x.jpg"), null));
  withSupabaseUrl("not a url", () => { assert.equal(safeImageUrl(other), null); assert.equal(safeImageUrl("https://stillafloatcruising.com/a.jpg"), "https://stillafloatcruising.com/a.jpg", "our own host still works"); });
});

const NO_LOOK = { heroUrl: null, hostPhotoUrl: null, planPhotoUrl: null, cabinPhotoUrl: null, taxesIncluded: false, hostNames: "Mark", label: null, dayNotes: {}, credits: [] };

test("pageLook passes only validated values: nulls for anything absent or refused, a real boolean for taxes", () => {
  withSupabaseUrl(SUPABASE_BASE, () => {
    const host = `${SUPABASE_BASE}/storage/v1/object/public/g/host.jpg`;
    const good = pageLook(normalizeAnswers({ hero_photo: "https://stillafloatcruising.com/h.jpg", host_photo: host, taxes_included: true }));
    assert.deepEqual(good, { ...NO_LOOK, heroUrl: "https://stillafloatcruising.com/h.jpg", hostPhotoUrl: host, taxesIncluded: true });
    assert.deepEqual(pageLook(normalizeAnswers({})), NO_LOOK, "nothing answered: nothing changes on the page");
    assert.deepEqual(pageLook({}), NO_LOOK, "answers that were never normalised");
    // each value stands on its own: a bad hero does not cost the hosts' photo, and the reverse
    const mixed = pageLook(normalizeAnswers({ hero_photo: "javascript:alert(1)", host_photo: "https://stillafloatcruising.com/h.jpg", taxes_included: true }));
    assert.deepEqual(mixed, { ...NO_LOOK, hostPhotoUrl: "https://stillafloatcruising.com/h.jpg", taxesIncluded: true });
    assert.deepEqual(pageLook(normalizeAnswers({ hero_photo: "https://stillafloatcruising.com/h.jpg", host_photo: "http://stillafloatcruising.com/h.jpg" })),
      { ...NO_LOOK, heroUrl: "https://stillafloatcruising.com/h.jpg" });
    for (const bad of ["https://example.com/h.jpg", 'https://stillafloatcruising.com/h.jpg")', "data:image/png;base64,AAAA", "https://stillafloatcruising.com/h (1).jpg"]) {
      assert.deepEqual(pageLook(normalizeAnswers({ hero_photo: bad, host_photo: bad, photo_plan: bad, photo_cabin: bad })), NO_LOOK, bad);
    }
    assert.deepEqual(Object.keys(pageLook({})).sort(), ["cabinPhotoUrl", "credits", "dayNotes", "heroUrl", "hostNames", "hostPhotoUrl", "label", "planPhotoUrl", "taxesIncluded"], "nothing else about the answers leaks into the look");
    assert.equal(typeof pageLook({ taxes_included: "true" as unknown as boolean }).taxesIncluded, "boolean");
    assert.equal(pageLook({ taxes_included: "true" as unknown as boolean }).taxesIncluded, false);
  });
});

test("pageLook carries the picture bands above the plan and the cabins, each validated on its own", () => {
  withSupabaseUrl(SUPABASE_BASE, () => {
    const plan = `${SUPABASE_BASE}/storage/v1/object/public/group-marketing/assets/p.jpg`, cabin = "https://stillafloatcruising.com/c.jpg";
    const both = pageLook(normalizeAnswers({ photo_plan: ` ${plan} `, photo_cabin: cabin }));
    assert.equal(both.planPhotoUrl, plan); assert.equal(both.cabinPhotoUrl, cabin);
    assert.equal(both.heroUrl, null, "the bands are not the top picture");
    const one = pageLook(normalizeAnswers({ photo_plan: "https://example.com/p.jpg", photo_cabin: cabin }));
    assert.equal(one.planPhotoUrl, null, "a link on another host is refused"); assert.equal(one.cabinPhotoUrl, cabin, "and does not cost the other band");
    assert.deepEqual(pageLook(normalizeAnswers({ photo_plan: "http://stillafloatcruising.com/p.jpg" })).planPhotoUrl, null, "http is refused");
  });
});

test("dayNotes: one line per day, keyed by the date before the first colon; lines without a date or a note are skipped, markup is dropped, a later line for the same date wins", () => {
  const notes = (day_notes: string) => pageLook(normalizeAnswers({ day_notes })).dayNotes;
  assert.deepEqual(notes("May 11: The beach party and light show at the lighthouse."), { "May 11": "The beach party and light show at the lighthouse." });
  assert.deepEqual(notes("  May 10 :  Dolphins, beaches: shopping…  \r\nMay 11: Sunrise on the beach.\n"), { "May 10": "Dolphins, beaches: shopping…", "May 11": "Sunrise on the beach." }, "trimmed; only the first colon splits; CRLF is fine");
  assert.deepEqual(notes("no colon here\n: no date\nMay 12:\nMay 13:   \n\nMay 14: kept"), { "May 14": "kept" });
  assert.deepEqual(notes("May 11: first\nMay 11: second"), { "May 11": "second" });
  assert.deepEqual(notes("May 11: <b>Bold</b> & <script>x</script>"), { "May 11": "Bold & x" }, "tags are dropped; the page shows the rest as text");
  assert.deepEqual(notes("11 de mayo: La fiesta en la playa."), { "11 de mayo": "La fiesta en la playa." });
  assert.deepEqual(notes(""), {}); assert.deepEqual(pageLook({}).dayNotes, {});
  assert.equal(notes(`May 11: ${"x".repeat(500)}`)["May 11"]!.length, 300, "one note is cut at 300 characters");
  const many = notes(Array.from({ length: 30 }, (_, i) => `Day ${i + 1}: note ${i + 1}`).join("\n"));
  assert.equal(Object.keys(many).length, 20, "at most twenty days carry a note");
  assert.deepEqual(notes("__proto__: nope"), JSON.parse('{"__proto__":"nope"}'), "an odd date is just a key");
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});

test("credits: the attribution lines of the pictures shown, in the pictures' order, de-duplicated; a picture with no row or no attribution has none; the hosts' photo never has one", () => {
  const hero = "https://stillafloatcruising.com/h.jpg", plan = "https://stillafloatcruising.com/p.jpg", cabin = "https://stillafloatcruising.com/c.jpg", host = "https://stillafloatcruising.com/hosts.jpg";
  const look = pageLook(normalizeAnswers({ hero_photo: hero, host_photo: host, photo_plan: plan, photo_cabin: cabin }));
  const links = creditedPictureLinks(look);
  assert.deepEqual(links, [hero, plan, cabin], "the hosts' photo is not looked up");
  const rows = [
    { public_url: cabin, attribution: "Photo: C · CC0 · Wikimedia Commons" }, { public_url: hero, attribution: "Photo: A · CC BY 2.0 · Wikimedia Commons" },
    { public_url: plan, attribution: "  " }, { public_url: host, attribution: "Photo: Hosts · CC0" }, { public_url: "https://stillafloatcruising.com/other.jpg", attribution: "x" },
  ];
  assert.deepEqual(creditsForPictures(links, rows), ["Photo: A · CC BY 2.0 · Wikimedia Commons", "Photo: C · CC0 · Wikimedia Commons"]);
  assert.deepEqual(creditsForPictures(links, []), []);
  assert.deepEqual(creditsForPictures([], rows), []);
  assert.deepEqual(creditedPictureLinks(pageLook(normalizeAnswers({ hero_photo: hero, photo_plan: hero }))), [hero], "one picture used twice is looked up once");
  assert.deepEqual(creditedPictureLinks(pageLook({})), []);
  const withCredits = pageLook(normalizeAnswers({ hero_photo: hero }), ["Photo: A · CC BY 2.0 · Wikimedia Commons", " Photo: A · CC BY 2.0 · Wikimedia Commons ", "", "Photo: B <b>· CC0</b>"]);
  assert.deepEqual(withCredits.credits, ["Photo: A · CC BY 2.0 · Wikimedia Commons", "Photo: B b· CC0/b"], "trimmed, de-duplicated, empty lines dropped, markup characters dropped");
  assert.deepEqual(pageLook({}).credits, []);
});

test("the Count me in form's contact: a real email, or a phone with at least seven digits (spaces, dashes, dots and parentheses allowed), nothing else", () => {
  for (const ok of ["mary@example.com", "a.b+c@mail.example.org", "m@x.co"]) assert.equal(validEmail(ok), true, ok);
  for (const bad of ["", "mary", "mary@", "@example.com", "mary@example", "mary@example.c", "mary @example.com", "a@b@c.com"]) assert.equal(validEmail(bad), false, bad);
  for (const ok of ["919-346-6127", "(919) 346-6127", "919.346.6127", "+1 919 346 6127", "9193466127", "346 6127", "+34 600 123 456"]) assert.equal(validPhone(ok), true, ok);
  for (const bad of ["", "123456", "12-34-56", "call me", "919-346-612x", "mary@example.com", "+".repeat(8), "1".repeat(16), "()-. "]) assert.equal(validPhone(bad), false, bad);
});

test("each day of the itinerary carries its ISO date, so the page can print the weekday and the short date", () => {
  const f = buildFacts(file(), rating, "en");
  assert.deepEqual(f.itinerary.map((d) => d.isoDate), ["2027-03-14", "2027-03-15", "2027-03-16", "2027-03-17", "2027-03-21"]);
  assert.equal(f.itinerary[0]!.dateText, "March 14, 2027");
  const none = buildFacts({ ...file(), group: { ...file().group, itinerary: [{ day: 1, date: "soon", port: "Miami, Florida", arrive: null, depart: null }] } }, rating, "en");
  assert.equal(none.itinerary[0]!.isoDate, null, "a date that is not a date has none");
  assert.deepEqual(buildFacts(file(), rating, "es").itinerary.map((d) => d.isoDate), f.itinerary.map((d) => d.isoDate), "the same in Spanish");
});

test("a picture link typed in the interview but refused is reported, so the page's silence is explained", () => {
  withSupabaseUrl(SUPABASE_BASE, () => {
    assert.deepEqual(ignoredPictureAnswers(normalizeAnswers({})), []);
    assert.deepEqual(ignoredPictureAnswers(normalizeAnswers({ hero_photo: "https://stillafloatcruising.com/h.jpg" })), []);
    assert.deepEqual(ignoredPictureAnswers(normalizeAnswers({ hero_photo: "https://drive.google.com/x", host_photo: "https://stillafloatcruising.com/h.jpg" })), ["hero_photo"]);
    assert.deepEqual(ignoredPictureAnswers(normalizeAnswers({ hero_photo: "nope", host_photo: "http://stillafloatcruising.com/h.jpg" })), ["hero_photo", "host_photo"]);
    assert.deepEqual(ignoredPictureAnswers(normalizeAnswers({ photo_plan: "https://drive.google.com/x", photo_cabin: "https://stillafloatcruising.com/c.jpg" })), ["photo_plan"], "the two picture bands are checked too");
    assert.deepEqual(ignoredPictureAnswers(normalizeAnswers({ photo_cabin: "ftp://x" })), ["photo_cabin"]);
  });
});

test("the digits in a picture link are not Mark's numbers: they never make a number in his pitch 'known'", () => {
  const f = buildFacts(file(), rating, "en");
  const pitch = "Come along for $777 a head.";
  assert.equal(pitchNumberProblems({ pitch }, f).length, 1);
  assert.equal(pitchNumberProblems(normalizeAnswers({ pitch, hero_photo: "https://stillafloatcruising.com/assets/images/777.jpg", host_photo: "https://stillafloatcruising.com/h-777.png", photo_plan: "https://stillafloatcruising.com/p-777.png", photo_cabin: "https://stillafloatcruising.com/c-777.png" }), f).length, 1, "a link with 777 in it does not vouch for the price");
  assert.deepEqual(pitchNumberProblems(normalizeAnswers({ pitch, extras: "The bus costs $777 to hire." }), f), [], "his own words still do");
});


// ── The page opens on a short personal welcome (Mark 2026-10-20: "we already had this discussion") ────────────────────

test("the welcome is a copy field: first, optional (copy written before it has none), at most 700 characters (Mark 2026-10-23), plain text", () => {
  const w = COPY_FIELDS.find((x) => x.key === "welcome")!;
  assert.ok(w, "welcome is in COPY_FIELDS, so the dashboard's copy editor lists it");
  assert.equal(w.max, 700); assert.equal(w.optional, true); assert.equal(w.long, true);
  assert.equal(COPY_FIELDS[0]!.key, "welcome", "the first thing the page says is the first thing Mark reads");
  const props = (COPY_SCHEMA as { properties: Record<string, { type: unknown }> }).properties;
  assert.equal(props["welcome"]!.type, "string", "a new draft always carries one");
  assert.deepEqual(props["organizer_note"]!.type, ["string", "null"], "the organizer's line is still optional");
  const t = tidyCopy({ headline: "Hi", welcome: "  We are glad you are here.  \nSee you aboard…  " });
  assert.equal(t.welcome, "We are glad you are here.\nSee you aboard…", "a line break is kept; a trailing space is not");
  assert.equal(tidyCopy({ headline: "Hi" }).welcome, null, "old copy has none");
  assert.equal(tidyCopy({ welcome: "   " }).welcome, null);
});

test("validateCopy: no welcome is fine (old copy); the welcome is held to the same length, markup, QR, number and banned-word rules as every other field", () => {
  const f = buildFacts(file(), rating, "en");
  assert.deepEqual(validateCopy({ ...goodCopy(), welcome: null }, f), [], "old copy has no welcome");
  assert.deepEqual(validateCopy({ ...goodCopy(), welcome: "x".repeat(700) }, f), [], "the design's four short paragraphs fit");
  assert.deepEqual(validateCopy({ ...goodCopy(), welcome: "x".repeat(701) }, f), [{ field: "welcome", problem: "too long: 701 of 700 characters — shorten it, or ask Mark" }]);
  assert.deepEqual(validateCopy({ ...goodCopy(), welcome: "We are glad you are here.\nSee you aboard!" }, f), [], "line breaks and a closing ! are fine");
  const bad = (welcome: string) => validateCopy({ ...goodCopy(), welcome }, f).filter((x) => x.field === "welcome").map((x) => x.problem);
  assert.ok(bad("Say <b>hello</b>").includes("contains markup"));
  assert.ok(bad("Scan the QR code and we will save you a spot").includes(QR_PROBLEM));
  assert.ok(bad("We found a cabin for $799 a head").some((p) => /799/.test(p)), "a number that is not in the file");
  assert.ok(bad("It is actually the best week of the year").some((p) => /actually/.test(p)));
  assert.ok(bad("Join Mark for a week").some((p) => /Join Mark/.test(p)));
  const es = buildFacts(file(), rating, "es");
  assert.ok(validateCopy({ ...goodCopy(), welcome: "Únase a Mark en el barco" }, es).some((x) => x.field === "welcome"));
  assert.deepEqual(validateCopy({ ...goodCopy(), welcome: "Nos encantaría navegar con usted… ¡Cuenten con nosotros!" }, es), []);
});

test("copyNotes on the welcome: missing, the headline or payoff again, a sentence of the pitch again, a price. Notes only, never problems", () => {
  const f = buildFacts(file(), rating, "en");
  const notes = (copy: Partial<GroupCopy>, answers: Parameters<typeof copyNotes>[2] = {}) => copyNotes({ ...goodCopy(), ...copy }, f, answers).filter((n) => n.field === "welcome").map((n) => n.problem);
  assert.deepEqual(notes({}), [], "a welcome in new words says nothing");
  assert.match(notes({ welcome: null })[0]!, /^there is no welcome note yet: the group page opens straight on the Count me in form/);
  assert.match(notes({ welcome: "" })[0]!, /no welcome note yet/);
  assert.match(notes({ welcome: "Hello, Post 12 goes to sea, and we are glad." })[0]!, /^repeats the headline/);
  assert.match(notes({ subhead: "ALL ON THE SAME CRUISE!", welcome: "Come along for it all on the same cruise! We are glad." })[0]!, /^repeats the payoff line/);
  assert.match(notes({ welcome: `Hi! ${PITCH.split(". ")[1]!}. Come along.` }, { pitch: PITCH })[0]!, /^repeats a sentence of Mark's pitch/);
  assert.deepEqual(notes({ welcome: `Hi! ${PITCH.split(". ")[1]!}. Come along.` }, {}), [], "no pitch on the interview, nothing to repeat");
  assert.match(notes({ welcome: "Cabins start at $849, so come along." })[0]!, /^names a price/);
  // none of it blocks: the same copy validates
  for (const welcome of [null, "Hello, Post 12 goes to sea, and we are glad.", "Cabins start at $849, so come along."]) assert.deepEqual(validateCopy({ ...goodCopy(), welcome }, f), [], String(welcome));
  assert.deepEqual(copyNotes({ ...goodCopy(), welcome: null }, buildFacts(file(), rating, "es"), {}).map((n) => n.field), ["welcome"], "Spanish copy gets the missing-welcome note too");
});

test("the copy writer is told to write the welcome: first-person plural, Mark's register, new words, no price, no QR, 700 characters", () => {
  const sys = systemPrompt("en");
  for (const rule of WELCOME_RULES) assert.ok(sys.includes(rule), "the welcome rule is in the system prompt");
  assert.ok(systemPrompt("es").includes(WELCOME_RULES[0]!), "and in the Spanish one");
  const rule = WELCOME_RULES.join("\n");
  assert.match(rule, /at most 700 characters/);
  assert.match(rule, /a line that is all capitals and ends with "!" is shown in bold as the payoff/);
  assert.match(rule, /First-person plural/);
  assert.match(rule, /a capitalised payoff with \"!\" allowed/);
  assert.match(rule, /these are NEW words: never the headline sentence, never the payoff line, never a sentence of Mark's pitch/);
  assert.match(rule, /No prices/);
  assert.match(rule, /no QR code/);
  assert.match(userPrompt(buildFacts(file(), rating, "en"), {}), /The welcome is a short note in new words, not the headline or the pitch again/);
});

test("retryNote keeps the moments hint for the walk-through notes and says plainly what the other notes are", () => {
  const r = retryNote([{ field: "who_for", problem: "missing" }], [
    { field: "headline", problem: "the walk-through sentence does not mention the beach party the pitch names" },
    { field: "welcome", problem: "names a price (prices are under Your cabin on the page)" },
  ]);
  assert.match(r, /And fix these too \(Mark wants them, though they do not block approval\); string the moments in <lead_with> into the one rising sentence:\n- headline: the walk-through/);
  assert.match(r, /And these too \(Mark wants them, though they do not block approval\):\n- welcome: names a price/);
  assert.doesNotMatch(retryNote([{ field: "who_for", problem: "missing" }], [{ field: "welcome", problem: "x" }]), /<lead_with>/);
});

// ── "Your cabin": the categories and what each starts at, names and prices only ─────────────────────────────

test("cabinPrices: one line per category at its lowest per-person price among the cabins still open, cheapest first; names and prices only", () => {
  const facts = buildFacts({ ...file(), cabins: [
    ...file().cabins,
    { status: "held", category: "Balcony", category_code: "8D", price_total: 2698, deposit_amount: 500 },                 // same category, dearer
    { status: "held", category: "Suite", category_code: "S1", price_total: 4000, deposit_amount: 500 },
    { status: "booked", category: "Suite", category_code: "S2", price_total: 3000, deposit_amount: 500 },                 // booked: not on offer
    { status: "booked", category: "Oceanview", category_code: "6A", price_total: 1900, deposit_amount: 500 },             // all booked: category not listed
    { status: "held", category: "Unpriced", category_code: "U1", price_total: null, deposit_amount: null },
  ] }, rating, "en");
  assert.deepEqual(cabinPrices(facts.cabins), [
    { category: "Interior", perPersonText: "$849" }, { category: "Balcony", perPersonText: "$1,249" }, { category: "Suite", perPersonText: "$2,000" },
  ]);
  assert.deepEqual(cabinPrices([]), []);
});

test("the public facts carry the cabin categories and their from-prices, and still no cabin count, availability, code or deposit (Mark 2026-10-19 / 2026-10-20)", () => {
  const facts = buildFacts({ ...file(), group: { ...file().group, inclusions: ["Drinks package"] } }, rating, "en");
  const pub = publicFacts(facts, {});
  for (const k of ["cabins", "cabinsAvailable", "cabinsTotal"]) assert.ok(!(k in pub), `the public facts must not carry ${k}`);
  assert.deepEqual(pub["cabinPrices"], [{ category: "Interior", perPersonText: "$849" }, { category: "Balcony", perPersonText: "$1,249" }]);
  assert.deepEqual((pub["cabinPrices"] as Array<Record<string, unknown>>).map((x) => Object.keys(x).sort()), [["category", "perPersonText"], ["category", "perPersonText"]], "names and prices, nothing else");
  const json = JSON.stringify(pub);
  for (const leak of ["8C", "4B", "deposit", "available", "$250", "$500"]) assert.ok(!json.includes(leak), `${leak} leaked into the public facts`);
  assert.equal(pub["fromPerPersonText"], "$849");
  assert.deepEqual(pub["perks"], ["Drinks package"]);
  assert.deepEqual(pub["planned"], []);
  // show_prices off: neither the from-price nor the category prices
  const hidden = publicFacts(facts, { show_prices: false });
  assert.equal(hidden["fromPerPersonText"], null); assert.deepEqual(hidden["cabinPrices"], []);
  // Mark 2026-10-23: no ship rating on the invitation page, whatever the interview says; the sailing date (ISO) is there for the weekday
  for (const show_rating of [true, false]) assert.ok(!("rating" in publicFacts(facts, { show_rating })), "the public facts never carry the ship's rating");
  assert.equal(pub["sailDate"], "2027-03-14");
  assert.deepEqual((pub["itinerary"] as Array<{ isoDate: string | null }>).map((d) => d.isoDate).slice(0, 2), ["2027-03-14", "2027-03-15"], "each day carries its ISO date for the page's weekday");
});

test("the public travel lines carry the guest's wording and the price unit, and no provider anywhere", () => {
  const facts = buildFacts({ ...file(), travel: [
    { kind: "hotel", direction: "pre", provider: "Marriott Courtyard", from_place: "Miami", reference: "1 night", price_per_person: 125, price_unit: "room", included: false, traveler_id: null, cabin_id: null },
    { kind: "transfer", direction: "pre", provider: "Limopedia", from_place: "Hotel", to_place: "Cruise port", price_per_person: 45, price_unit: "person", included: false, traveler_id: null, cabin_id: null },
    { kind: "flight", direction: "pre", provider: "American", from_place: "RDU", price_per_person: 350, included: false, traveler_id: null, cabin_id: null },
  ] }, rating, "en");
  const pub = publicFacts(facts, {});
  assert.deepEqual((pub["travel"] as Array<{ text: string }>).map((t) => t.text), [
    "Hotel the night before in Miami (1 night): $125 per room", "Hotel to Cruise port: $45 per person", "Flight from RDU: $350 per person"]);
  for (const vendor of ["Marriott", "Courtyard", "Limopedia", "American"]) {
    assert.ok(!JSON.stringify(pub).includes(vendor), `${vendor} reached the public facts`);
    assert.ok(!userPrompt(facts, {}).includes(vendor), `${vendor} reached the copy writer's prompt`);
    assert.ok(!campaignUserPrompt(facts, {}, "https://stillafloatcruising.com/group.html?g=x").includes(vendor), `${vendor} reached the campaign writer's prompt`);
  }
  assert.match(userPrompt(facts, {}), /Getting there \(air, hotel before, transfers\): Hotel the night before in Miami \(1 night\): \$125 per room; Hotel to Cruise port: \$45 per person; Flight from RDU: \$350 per person/);
  // the numbers the copy may state still include the travel prices
  assert.ok(facts.allowedNumbers.includes("125") && facts.allowedNumbers.includes("45") && facts.allowedNumbers.includes("350"));
});

// ── The signature under the welcome ──────────────────────────────────────────────────────────────────────────

test("hostNames: the interview's names as typed, one line, no markup characters, at most 80 characters; Mark when blank", () => {
  assert.equal(DEFAULT_HOST_NAMES, "Mark");
  assert.equal(hostNames({}), "Mark");
  assert.equal(hostNames(normalizeAnswers({})), "Mark");
  assert.equal(hostNames({ host_names: "   " }), "Mark");
  assert.equal(hostNames({ host_names: "Mark & Ceci" }), "Mark & Ceci");
  assert.equal(hostNames({ host_names: "  Mark   &\n Ceci " }), "Mark & Ceci", "one line");
  assert.equal(hostNames({ host_names: "Mark <b>& Ceci</b>" }), "Mark b& Ceci/b");   // the page writes it as text; < and > are dropped anyway
  assert.equal(hostNames({ host_names: "x".repeat(200) }).length, HOST_NAMES_MAX);
  assert.equal(hostNames({ host_names: true }), "Mark", "not text: Mark");
  assert.equal(pageLook(normalizeAnswers({ host_names: "Mark & Ceci" })).hostNames, "Mark & Ceci");
});

test("the interview asks who the invitation is from, optional, after the look questions", () => {
  const q = INTERVIEW.find((x) => x.key === "host_names")!;
  assert.ok(q, "host_names is in the interview");
  assert.equal(q.type, "text"); assert.notEqual(q.required, true);
  assert.equal(q.label, "Who is the invitation from? (e.g. Mark & Ceci)");
  assert.match(q.hint ?? "", /Signs the short welcome note/);
  assert.match(q.hint ?? "", /Left blank, it is signed Mark/);
  assert.equal(normalizeAnswers({ host_names: " Mark & Ceci " })["host_names"], "Mark & Ceci");
  assert.equal(normalizeAnswers({})["host_names"], "");
  assert.deepEqual(missingAnswers(normalizeAnswers({ pitch: "Come along.", audience: "a", occasion: "b", why_sailing: "c" })), [], "no new required question");
});

test("pageLabel: the guest-facing page name as typed, one line, no markup, at most PAGE_LABEL_MAX; null when blank (Mark 2026-10-20)", () => {
  assert.equal(pageLabel(normalizeAnswers({ page_label: "Friends and Family 2027" })), "Friends and Family 2027");
  assert.equal(pageLabel(normalizeAnswers({ page_label: "  Friends <b>and</b>\n Family  2027 " })), "Friends band/b Family 2027");
  assert.equal(pageLabel(normalizeAnswers({})), null, "blank: the page falls back to the group's own name");
  assert.equal(pageLabel({ page_label: "x".repeat(200) })!.length, PAGE_LABEL_MAX);
  assert.equal(pageLook(normalizeAnswers({ page_label: "Friends and Family 2027" })).label, "Friends and Family 2027", "pageLook carries it to the public page");
  assert.ok(INTERVIEW.some((q) => q.key === "page_label"), "the dashboard interview asks for it");
});
