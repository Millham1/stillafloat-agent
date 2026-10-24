// group-details.test.ts — the rules behind the two roads after "Save my spot!" (Mark 2026-10-23, reshaped 2026-10-24), with no database, mailer or clock.
// The cabin pick and the upgrade hook, the refusals in plain words (English and Spanish), the two emails' words and links, the 90-day link and the name split.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CALL_WHENS, MAX_TRAVELERS, MSG, callEmail, callUrl, callerPhone, detailsFacts, detailsTokenFresh, detailsUrl, firstWord, holdEmail, numberWord, phoneFromBlurb, pickCabin,
  reasonsInWords, splitLegalName, storedAddress, storedConcierge, storedPick, storedTravelers, tidyLegalName, upgradeHook, upgradeName, upgradePerkLines, validCallWhen,
  validateAddress, validateConcierge, validateDetails, type CallInput, type Concierge, type HoldInput, type Held,
} from "./group-details";

const MILLHAM: Held[] = [{ category: "Balcony Bella", perPersonText: "$536.79" }, { category: "Balcony Aurea", perPersonText: "$686.79" }];
const ANSWERS: Concierge = { room: "balcony", priority: "quiet", budget: "middle", motion: "yes" };
const PERKS = ["Your own restaurant where you eat when you feel like it", "the adults-only thermal spa", "a solarium the rest of the ship can't find"];
const NOW = new Date("2026-10-23T15:00:00Z");
const ADDRESS = { street: "123 Main St", city: "Raleigh", state: "NC", zip: "27601", tidied: true };

// ── pickCabin ─────────────────────────────────────────────────────────────────

test("the design's example: balcony, quiet, a comfortable budget and a steady ship give Balcony Bella, midship on a lower deck, with the approved sentence and NO price", () => {
  const p = pickCabin(ANSWERS, MILLHAM, "en", PERKS);
  assert.deepEqual(p, {
    category: "Balcony Bella",
    where: "midship, a lower deck",
    why: "Steady for whoever feels the motion, quiet away from the pool deck, and a balcony for that coffee.",
    upgrade: { category: "Aurea", hook: "Your own restaurant where you eat when you feel like it, the adults-only thermal spa, and a solarium the rest of the ship can't find." },
  });
  // nothing after the group page says a price: not in the why, not in the hook, not anywhere in the pick
  assert.ok(!/\$|per person|\bFrom \d|taxes/i.test(JSON.stringify(p)), JSON.stringify(p));
});

test("with no perks written (the interview's upgrade_perks is empty) the pick has no upgrade hook", () => {
  assert.equal(pickCabin(ANSWERS, MILLHAM, "en").upgrade, null);
  assert.equal(pickCabin(ANSWERS, MILLHAM, "en", []).upgrade, null);
  assert.equal(pickCabin(ANSWERS, MILLHAM, "en", ["", "  "]).upgrade, null);
});

test("the upgrade is the NEXT category up: none when the pick is already the top, one step for three categories, and the name drops the words the two share", () => {
  const top = pickCabin({ ...ANSWERS, budget: "sky" }, MILLHAM, "en", PERKS);
  assert.equal(top.category, "Balcony Aurea");
  assert.equal(top.upgrade, null, "nothing above the top");
  assert.equal(pickCabin(ANSWERS, [MILLHAM[0]!], "en", PERKS).upgrade, null, "one category only");
  const three: Held[] = [{ category: "Interior", perPersonText: "$400" }, { category: "Balcony", perPersonText: "$600" }, { category: "Suite", perPersonText: "$1,200" }];
  assert.equal(pickCabin({ ...ANSWERS, budget: "lean" }, three, "en", PERKS).upgrade?.category, "Balcony");
  assert.equal(pickCabin({ ...ANSWERS, budget: "treat" }, three, "en", PERKS).category, "Suite");
  assert.equal(pickCabin({ ...ANSWERS, budget: "treat" }, three, "en", PERKS).upgrade, null);
  assert.equal(upgradeName("Balcony Bella", "Balcony Aurea"), "Aurea");
  assert.equal(upgradeName("Interior", "Balcony"), "Balcony");
  assert.equal(upgradeName("Balcony", "Balcony"), "Balcony", "never empty");
  assert.equal(upgradeName("Suite Yacht Club", "Suite Yacht Club Deluxe"), "Deluxe");
  // with the prices hidden there is nothing to rank, so no upgrade is invented
  assert.equal(pickCabin(ANSWERS, [], "en", PERKS).upgrade, null);
});

test("the hook joins the first three perks with commas and 'and' before the last, lower-cases the first letter of each, and starts as a sentence", () => {
  assert.equal(upgradeHook(PERKS, "en"), "Your own restaurant where you eat when you feel like it, the adults-only thermal spa, and a solarium the rest of the ship can't find.");
  assert.equal(upgradeHook(["Quiet deck", "A private pool"], "en"), "Quiet deck and a private pool.");
  assert.equal(upgradeHook(["A private pool"], "en"), "A private pool.");
  assert.equal(upgradeHook(["One", "Two", "Three", "Four"], "en"), "One, two, and three.", "only the first three");
  assert.equal(upgradeHook(["MSC Yacht Club lounge", "The Spa"], "en"), "MSC Yacht Club lounge and the Spa.", "an acronym keeps its capitals");
  assert.equal(upgradeHook([], "en"), "");
  assert.equal(upgradeHook(["Un restaurante propio", "El spa solo para adultos", "Un solárium escondido"], "es"), "Un restaurante propio, el spa solo para adultos y un solárium escondido.");
  // the interview answer: one perk a line, bullets and blanks dropped
  assert.deepEqual(upgradePerkLines("- Your own restaurant\n\n  * The spa  \n• A solarium\n"), ["Your own restaurant", "The spa", "A solarium"]);
  assert.deepEqual(upgradePerkLines(undefined), []);
  assert.deepEqual(upgradePerkLines(true), []);
});

test("a treat or sky budget takes the higher-priced category, a lean or middle budget the lower, whatever order the list comes in", () => {
  const shuffled = [MILLHAM[1]!, MILLHAM[0]!];
  for (const budget of ["treat", "sky"] as const) {
    assert.equal(pickCabin({ ...ANSWERS, budget }, MILLHAM).category, "Balcony Aurea", budget);
    assert.equal(pickCabin({ ...ANSWERS, budget }, shuffled).category, "Balcony Aurea", `${budget}, list reversed`);
  }
  for (const budget of ["lean", "middle"] as const) {
    assert.equal(pickCabin({ ...ANSWERS, budget }, MILLHAM).category, "Balcony Bella", budget);
    assert.equal(pickCabin({ ...ANSWERS, budget }, shuffled).category, "Balcony Bella", `${budget}, list reversed`);
  }
  // prices compare as numbers, not as text ("$1,000" is more than "$900"); the price only orders them
  const text: Held[] = [{ category: "Suite", perPersonText: "$1,000" }, { category: "Balcony", perPersonText: "$900" }];
  assert.equal(pickCabin({ ...ANSWERS, budget: "sky" }, text).category, "Suite");
  assert.equal(pickCabin({ ...ANSWERS, budget: "lean" }, text).category, "Balcony");
  // one category is both the lower and the higher
  assert.equal(pickCabin({ ...ANSWERS, budget: "sky" }, [MILLHAM[0]!]).category, "Balcony Bella");
});

test("where: the motion outranks everything, then a quiet priority is midship, the ocean is a higher deck, anything else is midship", () => {
  const where = (o: Partial<Concierge>) => pickCabin({ ...ANSWERS, ...o }, MILLHAM).where;
  assert.equal(where({ motion: "yes", priority: "ocean" }), "midship, a lower deck");
  assert.equal(where({ motion: "yes", priority: "quiet" }), "midship, a lower deck");
  assert.equal(where({ motion: "no", priority: "quiet" }), "midship");
  assert.equal(where({ motion: "no", priority: "ocean" }), "a higher deck");
  assert.equal(where({ motion: "no", priority: "action" }), "midship");
  assert.equal(where({ motion: "no", priority: "space" }), "midship");
});

test("why is assembled only from what they said: each clause appears for its answer and never otherwise, and ends at a full stop with no price", () => {
  const why = (o: Partial<Concierge>, held = MILLHAM) => pickCabin({ ...ANSWERS, ...o }, held, "en").why;
  assert.match(why({ motion: "yes" }), /^Steady for whoever feels the motion/);
  assert.ok(!why({ motion: "no" }).includes("Steady"));
  assert.ok(why({ priority: "quiet" }).includes("quiet away from the pool deck"));
  assert.ok(!why({ priority: "ocean" }).includes("quiet"));
  assert.ok(why({ room: "suite" }).includes("a balcony for that coffee"));
  // an inside request: the group's cabins are all balconies, so they get one anyway
  assert.ok(why({ room: "inside" }).includes("the group's cabins are all balconies, so you get one anyway"));
  assert.ok(!why({ room: "inside" }).includes("for that coffee"));
  assert.equal(why({ motion: "no", priority: "quiet", room: "oceanview" }), "Quiet away from the pool deck.");
  assert.equal(why({ motion: "yes", priority: "ocean", room: "balcony" }), "Steady for whoever feels the motion and a balcony for that coffee.");
  assert.equal(why({ motion: "no", priority: "action", room: "oceanview" }), "Our best fit for what you told us.");
});

test("a balcony is never promised for a cabin that is not one", () => {
  const mixed: Held[] = [{ category: "Interior", perPersonText: "$400" }, { category: "Balcony", perPersonText: "$600" }];
  const lowerPick = pickCabin({ ...ANSWERS, budget: "lean" }, mixed, "en");
  assert.equal(lowerPick.category, "Interior");
  assert.ok(!/balcon/i.test(lowerPick.why), lowerPick.why);
  assert.ok(!pickCabin({ ...ANSWERS, room: "inside" }, mixed, "en").why.includes("all balconies"));
  assert.ok(pickCabin({ ...ANSWERS, budget: "sky" }, mixed, "en").why.includes("a balcony for that coffee"));
});

test("no categories to choose from (prices hidden): it names the kind of cabin they asked for", () => {
  const p = pickCabin({ ...ANSWERS, room: "oceanview" }, [], "en");
  assert.equal(p.category, "Oceanview");
  assert.ok(!/\$|From/.test(p.why), p.why);
  assert.equal(pickCabin({ ...ANSWERS, room: "suite" }, [], "es").category, "Suite");
  const noPrice = pickCabin(ANSWERS, [{ category: "Balcony Bella", perPersonText: null }], "en");
  assert.equal(noPrice.category, "Balcony Bella");
});

test("Spanish: the same pick in Spanish, addressed as usted, with no price and the hook in Spanish", () => {
  const p = pickCabin(ANSWERS, MILLHAM, "es", ["Un restaurante propio", "El spa solo para adultos"]);
  assert.equal(p.category, "Balcony Bella");
  assert.equal(p.where, "en el centro del barco, en una cubierta baja");
  assert.equal(p.why, "Estable para quien sienta el movimiento, alejada de la cubierta de la piscina y un balcón para ese café.");
  assert.deepEqual(p.upgrade, { category: "Aurea", hook: "Un restaurante propio y el spa solo para adultos." });
  assert.equal(pickCabin({ ...ANSWERS, motion: "no", priority: "ocean" }, MILLHAM, "es").where, "en una cubierta alta");
});

test("the reasons behind a pick, in words, for Mark's list", () => {
  assert.equal(reasonsInWords(ANSWERS), "feels the motion, wants quiet, balcony");
  assert.equal(reasonsInWords({ room: "inside", priority: "action", budget: "lean", motion: "no" }), "wants the action, inside cabin");
  assert.equal(reasonsInWords({ room: "suite", priority: "ocean", budget: "sky", motion: "yes" }), "feels the motion, wants the ocean, suite");
  assert.equal(reasonsInWords({ room: "oceanview", priority: "space", budget: "middle", motion: "no" }), "wants room to spread out, oceanview");
});

// ── What the file says ────────────────────────────────────────────────────────

test("detailsFacts reads the label, the deposit per person and the upgrade perks from the group file", () => {
  const group = { name: "Millham F/F 2027", deposit_per_person: 50, ship_name: "MSC SEASHORE", marketing: { page_label: "Friends and Family 2027", host_names: "Mark & Ceci", upgrade_perks: "- Your own restaurant\n The spa\n" } };
  const f = detailsFacts({ group, cabins: [] }, "en");
  assert.deepEqual([f.label, f.depositPerPersonText, f.hostNames, f.upgradePerks], ["Friends and Family 2027", "$50", "Mark & Ceci", ["Your own restaurant", "The spa"]]);
  const bare = detailsFacts({ group: { name: "Plain Group" }, cabins: [{ status: "held", category: "Balcony", price_total: 2000, deposit_amount: 100 }] }, "en");
  assert.equal(bare.label, "Plain Group");
  assert.deepEqual(bare.upgradePerks, []);
  assert.equal(bare.depositPerPersonText, "$50", "no deposit of its own: half the lowest cabin deposit, a person's share");
  assert.equal(detailsFacts({ group: { name: "None" }, cabins: [] }, "en").depositPerPersonText, null);
});

test("the number Mark rings from: the one in the group's own line beside the button, else the business number", () => {
  assert.equal(phoneFromBlurb("Questions? Call or text Mark at 919-346-6127."), "919-346-6127");
  assert.equal(phoneFromBlurb("Call (919) 555-0100 any time"), "(919) 555-0100");
  assert.equal(phoneFromBlurb("No number here"), null);
  assert.equal(phoneFromBlurb(undefined), null);
  assert.equal(callerPhone("Call Mark at 919-555-0111!"), "919-555-0111");
  assert.equal(callerPhone("Questions?"), "919-346-6127");
  assert.equal(callerPhone(undefined), "919-346-6127");
  assert.equal(firstWord("Mary Ann van der Berg"), "Mary");
  assert.equal(firstWord("  Cher "), "Cher");
  assert.equal(firstWord(null), "");
});

// ── validateDetails ───────────────────────────────────────────────────────────

const GOOD = { travelers: [{ legal_name: "Mark Millham", dob: "1965-04-12" }, { legal_name: "Ceci  Millham", dob: "1980-11-02" }], address: ADDRESS, concierge: ANSWERS };

test("good details pass, names are tidied, the address is kept, and the count is what came", () => {
  const v = validateDetails(GOOD, 2, "en", NOW);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.deepEqual(v.travelers, [{ legal_name: "Mark Millham", dob: "1965-04-12" }, { legal_name: "Ceci Millham", dob: "1980-11-02" }]);
  assert.deepEqual(v.address, ADDRESS);
  assert.deepEqual(v.concierge, ANSWERS);
  assert.equal(v.count, 2);
});

test("one to four travelers, whatever the party size they gave; five is refused with the second-cabin words", () => {
  assert.equal(MAX_TRAVELERS, 4);
  const one = validateDetails({ ...GOOD, travelers: [GOOD.travelers[0]] }, 6, "en", NOW);
  assert.ok(one.ok && one.count === 1);
  const four = validateDetails({ ...GOOD, travelers: Array.from({ length: 4 }, (_, i) => ({ legal_name: `Person Number${"x".repeat(i)}`, dob: "1990-01-01" })) }, 2, "en", NOW);
  assert.ok(four.ok && four.count === 4);
  const five = validateDetails({ ...GOOD, travelers: Array.from({ length: 5 }, () => ({ legal_name: "Person Number", dob: "1990-01-01" })) }, 2, "en", NOW);
  assert.deepEqual(five, { ok: false, error: "More than four? Mark will set up a second cabin on the call… tap Talk me into it, Mark! on the group page.", field: "travelers" });
  const none = validateDetails({ ...GOOD, travelers: [] }, 2, "en", NOW);
  assert.deepEqual([none.ok, !none.ok && none.field], [false, "travelers"]);
});

test("a name is a first AND a last name of letters, spaces, hyphens and apostrophes: the design's words", () => {
  const NAME = "First AND last name, please… the way the passport has it.";
  for (const bad of ["Bob", "", "  ", "R2 D2", "Mark <b>Millham</b>", "A", "Mark 3rd", "Mark Millham!", "-- --", "Mark ' '", "x".repeat(81), "Jr. Smith", "Mark_Millham"]) {
    const v = validateDetails({ ...GOOD, travelers: [{ legal_name: bad, dob: "1965-04-12" }] }, 1, "en", NOW);
    assert.deepEqual([v.ok, !v.ok && v.error, !v.ok && v.field], [false, NAME, "travelers.0.legal_name"], JSON.stringify(bad));
  }
  for (const good of ["Mark Millham", "Mary-Jane O'Brien", "José Pérez", "Ana de la Cruz", "Li Q", "Anne-Marie d’Arcy", "Zoë Müller"]) {
    assert.ok(validateDetails({ ...GOOD, travelers: [{ legal_name: good, dob: "1965-04-12" }] }, 1, "en", NOW).ok, good);
  }
  assert.equal(tidyLegalName("  Mary   Ann   Smith "), "Mary Ann Smith");
  assert.equal(tidyLegalName(12), null);
  assert.equal(tidyLegalName("Bob"), null);
  // the second traveler's problem is named by its own field
  const v = validateDetails({ ...GOOD, travelers: [GOOD.travelers[0], { legal_name: "Ceci", dob: "1980-11-02" }] }, 2, "en", NOW);
  assert.deepEqual(!v.ok && v.field, "travelers.1.legal_name");
});

test("a birthday is a real date, not in the future and under 120 years ago: one sentence for every way it can be wrong", () => {
  const DOB = "Month, day and a four-digit year: 03 / 04 / 1965.";
  for (const dob of ["", "04/12/1965", "1965-4-12", "1965-02-30", "2999-01-01", "2026-10-24", "1900-01-01", "1906-10-23", "not a date", "65-04-12", "1965-13-01"]) {
    const v = validateDetails({ ...GOOD, travelers: [{ legal_name: "Mark Millham", dob }] }, 1, "en", NOW);
    assert.deepEqual([v.ok, !v.ok && v.error, !v.ok && v.field], [false, DOB, "travelers.0.dob"], JSON.stringify(dob));
  }
  for (const dob of ["2026-10-23", "1906-10-24", "2020-02-29", "1965-04-12"]) assert.ok(validateDetails({ ...GOOD, travelers: [{ legal_name: "Mark Millham", dob }] }, 1, "en", NOW).ok, dob);
});

test("the address: a street and number, a city, a US state and a ZIP, each refused in its own words with its own field", () => {
  const bad = (a: unknown) => { const v = validateDetails({ ...GOOD, address: a }, 2, "en", NOW); return v.ok ? null : [v.error, v.field]; };
  assert.deepEqual(bad(undefined), ["A street and number, please… like 123 Main St.", "address.street"]);
  assert.deepEqual(bad({ ...ADDRESS, street: "12" }), ["A street and number, please… like 123 Main St.", "address.street"]);
  assert.deepEqual(bad({ ...ADDRESS, street: "<script>" }), ["A street and number, please… like 123 Main St.", "address.street"]);
  assert.deepEqual(bad({ ...ADDRESS, street: "12345" }), ["A street and number, please… like 123 Main St.", "address.street"], "no letter at all is not a street");
  assert.deepEqual(bad({ ...ADDRESS, city: "" }), ["Which city, please?", "address.city"]);
  assert.deepEqual(bad({ ...ADDRESS, city: "R4leigh" }), ["Which city, please?", "address.city"]);
  assert.deepEqual(bad({ ...ADDRESS, state: "North Carolina" }), ["The state's two letters, please… like NC.", "address.state"]);
  assert.deepEqual(bad({ ...ADDRESS, state: "ZZ" }), ["The state's two letters, please… like NC.", "address.state"]);
  assert.deepEqual(bad({ ...ADDRESS, zip: "2760" }), ["Five digits for the ZIP, please… like 27601.", "address.zip"]);
  assert.deepEqual(bad({ ...ADDRESS, zip: "ABCDE" }), ["Five digits for the ZIP, please… like 27601.", "address.zip"]);
  assert.equal(bad(ADDRESS), null);
  // tidied: only a real true counts; a state in lower case and spaces are tidied; ZIP+4 is allowed
  const a = validateAddress({ street: "  500   E  Davie St ", city: "Raleigh", state: "nc", zip: "27601-1234", tidied: "yes" }, "en");
  assert.deepEqual(a, { ok: true, address: { street: "500 E Davie St", city: "Raleigh", state: "NC", zip: "27601-1234", tidied: false } });
  // Spanish twin of every refusal
  assert.equal(validateAddress({}, "es").ok, false);
  assert.equal((validateAddress({ ...ADDRESS, zip: "1" }, "es") as { error: string }).error, "Cinco dígitos para el código postal, por favor… como 27601.");
});

test("each concierge answer must be one of its allowed values", () => {
  for (const [key, bad] of [["room", "penthouse"], ["priority", ""], ["budget", 7], ["motion", "maybe"]] as const) {
    const v = validateDetails({ ...GOOD, concierge: { ...ANSWERS, [key]: bad } }, 2, "en", NOW);
    assert.deepEqual([v.ok, !v.ok && v.field, !v.ok && v.error], [false, `concierge.${key}`, "Please tap one answer for each of the four room questions."]);
  }
  const missing = validateDetails({ ...GOOD, concierge: undefined }, 2, "en", NOW);
  assert.equal(missing.ok, false);
  assert.equal(validateDetails("nope", 2, "en", NOW).ok, false);
  assert.equal(validateDetails([], 2, "en", NOW).ok, false);
  assert.deepEqual(validateConcierge({ concierge: ANSWERS }), { ok: true, concierge: ANSWERS });
  assert.deepEqual(validateConcierge({ concierge: { ...ANSWERS, motion: "x" } }, "es"), { ok: false, error: "Toque una respuesta en cada una de las cuatro preguntas sobre la cabina.", field: "concierge" });
  assert.equal(validateConcierge(undefined).ok, false);
});

test("every refusal has a Spanish twin in usted, and the message carries nothing the guest typed", () => {
  const es = [
    validateDetails({ ...GOOD, travelers: [{ legal_name: "Bob", dob: "1965-04-12" }] }, 1, "es", NOW),
    validateDetails({ ...GOOD, travelers: [{ legal_name: "Mark Millham", dob: "x" }] }, 1, "es", NOW),
    validateDetails({ ...GOOD, address: {} }, 1, "es", NOW),
    validateDetails({ ...GOOD, travelers: Array.from({ length: 5 }, () => GOOD.travelers[0]) }, 1, "es", NOW),
    validateDetails({ ...GOOD, concierge: {} }, 1, "es", NOW),
  ];
  for (const v of es) {
    assert.ok(!v.ok);
    if (v.ok) continue;
    assert.ok(!/[A-Z][a-z]+ (please|and)\b|\bthe\b|\byour\b/.test(v.error), `English words in ${v.error}`);
  }
  assert.equal((es[0] as { error: string }).error, MSG.name.es);
  const typed = "Zaphod Beeblebrox <b>";
  const v = validateDetails({ ...GOOD, travelers: [{ legal_name: typed, dob: "1965-04-12" }] }, 1, "en", NOW);
  assert.ok(!v.ok && !v.error.includes("Zaphod"));
});

test("what was stored reads back, and anything else reads as nothing (a half-saved row never breaks the page)", () => {
  assert.deepEqual(storedTravelers([{ legal_name: "A B", dob: "1990-01-01" }]), [{ legal_name: "A B", dob: "1990-01-01" }]);
  for (const bad of [null, undefined, [], "x", [{}], [{ legal_name: "A", dob: 3 }], [{ legal_name: " ", dob: "1990-01-01" }]]) assert.equal(storedTravelers(bad), null);
  assert.deepEqual(storedConcierge(ANSWERS), ANSWERS);
  for (const bad of [null, {}, { ...ANSWERS, room: "x" }, "x", []]) assert.equal(storedConcierge(bad), null);
  const p = pickCabin(ANSWERS, MILLHAM, "en", PERKS);
  assert.deepEqual(storedPick(p), p);
  assert.deepEqual(storedPick({ category: "Balcony", where: "midship", why: "Because." }), { category: "Balcony", where: "midship", why: "Because.", upgrade: null }, "a pick stored before the hook existed");
  assert.equal(storedPick({ category: "Balcony" }), null);
  assert.equal(storedPick(null), null);
  assert.deepEqual(storedAddress(ADDRESS), ADDRESS);
  assert.deepEqual(storedAddress({ street: "1 A St", city: "X", state: "NC", zip: "27601" }), { street: "1 A St", city: "X", state: "NC", zip: "27601", tidied: false });
  for (const bad of [null, {}, { street: "1 A St" }, "x"]) assert.equal(storedAddress(bad), null);
});

test("the legal name splits on the LAST space; one word is a first name only", () => {
  assert.deepEqual(splitLegalName("Mary Ann Smith"), { first: "Mary Ann", last: "Smith" });
  assert.deepEqual(splitLegalName("  Cher "), { first: "Cher", last: null });
  assert.deepEqual(splitLegalName("Pat   Lee"), { first: "Pat", last: "Lee" });
});

test("Road A's four times: morning, afternoon, evening or anytime, nothing else", () => {
  assert.deepEqual([...CALL_WHENS], ["morning", "afternoon", "evening", "anytime"]);
  for (const w of CALL_WHENS) assert.equal(validCallWhen(w), w);
  for (const bad of ["Morning", "night", "", null, undefined, 3, ["morning"]]) assert.equal(validCallWhen(bad), null);
  assert.equal(numberWord(3, "en"), "three");
  assert.equal(numberWord(3, "es"), "tres");
  assert.equal(numberWord(40, "en"), "40");
});

test("the links: details.html?t= for English, /es/details.html?t= for Spanish, and the call link is the same page with &choice=call", () => {
  assert.equal(detailsUrl("https://stillafloatcruising.com/", "T".repeat(43)), `https://stillafloatcruising.com/details.html?t=${"T".repeat(43)}`);
  assert.equal(detailsUrl("https://dev.example.test", "abc", "es"), "https://dev.example.test/es/details.html?t=abc");
  assert.equal(callUrl("https://dev.example.test", "abc"), "https://dev.example.test/details.html?t=abc&choice=call");
});

test("a link works for 90 days from when it was made, and a missing or unreadable time never works", () => {
  const DAY = 86_400_000;
  assert.equal(detailsTokenFresh(new Date(NOW.getTime() - 89 * DAY).toISOString(), NOW), true);
  assert.equal(detailsTokenFresh(new Date(NOW.getTime() - 91 * DAY).toISOString(), NOW), false);
  assert.equal(detailsTokenFresh(new Date(NOW.getTime() + 5 * 60_000).toISOString(), NOW), false, "a time in the future never works");
  for (const bad of [null, undefined, "", "yesterday", 17]) assert.equal(detailsTokenFresh(bad, NOW), false);
});

// ── Road A's email ────────────────────────────────────────────────────────────

const CALL: CallInput = { firstName: "Mark", groupLabel: "Friends and Family 2027", hostNames: "Mark & Ceci", lang: "en", publicSite: "https://dev.example.test", when: "evening", phone: "919-346-6127" };

test("Road A's email says the approved words, built from the facts passed in, with the guest's own answer repeated back", () => {
  const m = callEmail(CALL);
  assert.equal(m.subject, "Good call… literally! Friends and Family 2027");
  assert.deepEqual(m.text.trim().split("\n\n"), [
    "Hi Mark,",
    "Smart move… the best cruise decisions happen over a phone call, not a scroll bar! Mark will ring you within a day from 919-346-6127… evenings, like you said. Save the number now, or you'll send him to voicemail like everyone does… twice.",
    "No homework. Bring your questions and your maybes. He'll go over your choices, jot down the names and birthdays, and hold your spot before you hang up. Nothing is charged until you say the word. The only thing to decide tonight: coffee on the balcony, or coffee on the balcony.",
    "One smart-cruiser move while you wait: dig out everyone's passport and check the expiry date. Renewals take weeks, and your paperwork page will ask for the number later.",
    "Can't wait? Call or text him first… he'll pretend he wasn't sitting by the phone.",
    "Cruise smarter, laugh more… and pick up when the 919 number rings!",
    "Mark & Ceci",
    "Still Afloat LLC dba Still Afloat Cruising\nYou got this email because you saved your spot on our Friends and Family 2027 page and asked Mark to talk you into it. Not you? Reply and we'll take you off.",
  ]);
  assert.match(m.html, /Mark will ring you within a day from <b>919-346-6127<\/b>… evenings, like you said\./);
  assert.match(m.html, /<h1[^>]*>Good call… literally!<\/h1>/);
  assert.match(m.html, /FRIENDS AND FAMILY 2027|>Friends and Family 2027</i);
});

test("Road A's email repeats each answer in its own words, and names neither a cabin nor a price", () => {
  const says = (when: CallInput["when"]) => callEmail({ ...CALL, when }).text.match(/from 919-346-6127… (.*?), like you said/)![1];
  assert.deepEqual(CALL_WHENS.map(says), ["mornings", "afternoons", "evenings", "whenever works"]);
  const m = callEmail(CALL);
  assert.ok(!/\$|\bBalcony\b|\bBella\b|\bAurea\b|\bInterior\b|per person|deposit/.test(m.text + m.html), "no cabin names or prices (the lower-case 'coffee on the balcony' is the joke, not a cabin)");
  // no link at all: the next move is Mark's call
  assert.ok(!/href=|https?:\/\/(?!dev\.example\.test)/i.test(m.html.replace(/src="[^"]*"/g, "")), "no link in Road A's email");
  // a group with its own number in its line beside the button: that number, and its area code in the brand line
  const own = callEmail({ ...CALL, phone: "(704) 555-0100" });
  assert.match(own.text, /from \(704\) 555-0100… evenings/);
  assert.match(own.text, /when the 704 number rings!/);
  // a number with no area code to name still reads
  assert.match(callEmail({ ...CALL, phone: "555-0100" }).text, /when the number rings!/);
});

test("Road A's email: the logos are the site's own hosted images, every value is escaped, and a missing host name signs Mark", () => {
  const m = callEmail({ ...CALL, groupLabel: 'Fam <b>& "Friends"', firstName: "<i>Pat</i>", hostNames: "  ", publicSite: "https://dev.example.test/" });
  assert.ok(m.html.includes('src="https://dev.example.test/assets/images/still_afloat_logo.png"'));
  assert.ok(m.html.includes('src="https://dev.example.test/assets/images/cornerstone-white.png"'));
  assert.ok(!/<i>Pat|<b>& "Friends"/.test(m.html), "markup from a person or a file is escaped");
  assert.match(m.html, /&lt;i&gt;Pat&lt;\/i&gt;/);
  assert.match(m.text, /\n\nMark\n\nStill Afloat LLC/);
});

test("Road A's email in Spanish is Spanish all the way down, in usted", () => {
  const m = callEmail({ ...CALL, lang: "es", groupLabel: "Amigos y Familia 2027", firstName: "Ana", hostNames: "Mark y Ceci" });
  assert.equal(m.subject, "Buena decisión… ¡la llamada va en camino! Amigos y Familia 2027");
  assert.match(m.text, /^Hola Ana:/);
  assert.match(m.text, /Mark le llamará en un día desde el 919-346-6127… por la noche, como usted dijo\./);
  assert.match(m.text, /¡y conteste cuando suene el número 919!/);
  assert.match(m.text, /Recibió este correo porque apartó su lugar en nuestra página de Amigos y Familia 2027 y pidió que Mark lo convenciera\. ¿No fue usted\? Responda y le quitamos de la lista\./);
  assert.ok(!/\b(You|your|Reply|Hi|Smart|Mark will)\b/.test(m.text.replace(/Still Afloat LLC dba Still Afloat Cruising/, "")), "English words in the Spanish email");
  assert.deepEqual(CALL_WHENS.map((when) => callEmail({ ...CALL, lang: "es", when }).text.match(/desde el 919-346-6127… (.*?), como usted dijo/)![1]), ["por la mañana", "por la tarde", "por la noche", "cuando le quede bien"]);
});

// ── Road B's email ────────────────────────────────────────────────────────────

const HOLD: HoldInput = {
  firstName: "Mark", groupLabel: "Friends and Family 2027", hostNames: "Mark & Ceci", lang: "en", publicSite: "https://dev.example.test",
  category: "Balcony Bella", where: "midship, a lower deck", travelerFirstNames: ["Mark", "Ceci", "Pat"], detailsUrl: `https://dev.example.test/details.html?t=${"T".repeat(43)}`,
};

test("Road B's email says the approved words: the laugh, what they did for whom, the passport move, the way back, the brand line, the footer", () => {
  const m = holdEmail(HOLD);
  assert.equal(m.subject, "Your cabin is on hold… nicely done! Friends and Family 2027");
  assert.deepEqual(m.text.trim().split("\n\n"), [
    "Hi Mark,",
    "You planned a cruise in three minutes. Some people take three months and still end up next to the elevator.",
    "Here's what you did: Balcony Bella, midship, a lower deck, for Mark, Ceci and Pat. Mark confirms it with the cruise line within a day, and your paperwork follows. Nothing is charged tonight.",
    "One smart-cruiser move while you wait: dig out everyone's passport and check the expiry dates. Renewals take weeks, and your paperwork page will ask for the numbers.",
    `Need to change a name, a birthday or your mind? Open my details: ${HOLD.detailsUrl}`,
    "Cruise smarter, laugh more… see you at the muster drill!",
    "Mark & Ceci",
    "Still Afloat LLC dba Still Afloat Cruising\nYou got this email because you put your cabin on hold on our Friends and Family 2027 page. Not you? Reply and we'll take you off.",
  ]);
  assert.match(m.html, /<b>Balcony Bella, midship, a lower deck<\/b>, for Mark, Ceci and Pat\./);
  assert.ok(m.html.includes(`<a href="${HOLD.detailsUrl}"`) && /<a href="[^"]*"[^>]*background:#f5c33b[^>]*>Open my details<\/a>/.test(m.html), "the yellow button goes to their details");
  assert.match(m.html, /<h1[^>]*>Your cabin is on hold… nicely done!<\/h1>/);
});

test("Road B's email: the passport move follows the party (one, both, everyone's), and no price or deposit is named", () => {
  const move = (names: string[]) => holdEmail({ ...HOLD, travelerFirstNames: names }).text.match(/One smart-cruiser move while you wait: (.*)/)![1];
  assert.equal(move(["Mark"]), "dig out your passport and check the expiry date. Renewals take weeks, and your paperwork page will ask for the number.");
  assert.equal(move(["Mark", "Ceci"]), "dig out both passports and check the expiry dates. Renewals take weeks, and your paperwork page will ask for the numbers.");
  assert.match(move(["A", "B", "C"]), /^dig out everyone's passport and check the expiry dates/);
  assert.match(move(["A", "B", "C", "D"]), /^dig out everyone's passport/);
  assert.match(holdEmail({ ...HOLD, travelerFirstNames: ["Mark", "Ceci"] }).text, /for Mark and Ceci\./);
  assert.match(holdEmail({ ...HOLD, travelerFirstNames: ["Mark"] }).text, /for Mark\./);
  const m = holdEmail(HOLD);
  assert.ok(!/\$|per person|deposit|From \d/i.test(m.text + m.html), "no price in Road B's email");
});

test("Road B's email: escaped, the site's own logos, the link only in its own body, and the Spanish twin is Spanish in usted", () => {
  const m = holdEmail({ ...HOLD, groupLabel: "Fam <script>", category: "Balcony <b>Bella</b>", travelerFirstNames: ["<i>Mark</i>"] });
  assert.ok(!m.html.includes("<script>") && !m.html.includes("<i>Mark</i>"));
  assert.ok(m.html.includes('src="https://dev.example.test/assets/images/still_afloat_logo.png"'));
  const es = holdEmail({ ...HOLD, lang: "es", groupLabel: "Amigos y Familia 2027", firstName: "Ana", category: "Balcony Bella", where: "en el centro del barco, en una cubierta baja", travelerFirstNames: ["Ana", "Luis"], hostNames: "Mark y Ceci" });
  assert.equal(es.subject, "Su cabina está apartada… ¡bien hecho! Amigos y Familia 2027");
  assert.match(es.text, /^Hola Ana:/);
  assert.match(es.text, /Esto es lo que hizo: Balcony Bella, en el centro del barco, en una cubierta baja, para Ana y Luis\. Mark la confirma con la naviera en un día/);
  assert.match(es.text, /saque los dos pasaportes y revise las fechas de vencimiento/);
  assert.match(es.html, />Abrir mis datos</);
  assert.match(es.text, /Recibió este correo porque apartó su cabina en nuestra página de Amigos y Familia 2027\. ¿No fue usted\? Responda y le quitamos de la lista\./);
  assert.ok(!/\b(You|your|Reply|Hi|Smart|Mark confirms)\b/.test(es.text.replace(/Still Afloat LLC dba Still Afloat Cruising/, "")), "English words in the Spanish email");
});

test("no em dash anywhere in either email, in either language", () => {
  for (const lang of ["en", "es"] as const) {
    const a = callEmail({ ...CALL, lang });
    const b = holdEmail({ ...HOLD, lang });
    for (const t of [a.subject, a.text, a.html, b.subject, b.text, b.html]) assert.ok(!/—/.test(t), `an em dash in the ${lang} email`);
  }
});
