// group-details.test.ts — the rules behind "Count me in" → choice → "Your details" (Mark 2026-10-23), with no database, mailer or clock.
// The cabin pick, the refusals in plain words (English and Spanish), the acknowledgement email's words and links, the 90-day link and the name split.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ackEmail, callUrl, detailsTokenFresh, detailsUrl, pickCabin, splitLegalName, storedConcierge, storedPick, storedTravelers, validateDetails,
  type AckInput, type Concierge, type Held,
} from "./group-details";

const MILLHAM: Held[] = [{ category: "Balcony Bella", perPersonText: "$536.79" }, { category: "Balcony Aurea", perPersonText: "$686.79" }];
const ANSWERS: Concierge = { room: "balcony", priority: "quiet", budget: "middle", motion: "yes" };
const NOW = new Date("2026-10-23T15:00:00Z");

// ── pickCabin ─────────────────────────────────────────────────────────────────

test("the design's example: balcony, quiet, a comfortable budget and a steady ship give Balcony Bella, midship on a lower deck, with the approved sentence", () => {
  const p = pickCabin(ANSWERS, MILLHAM, "en", true);
  assert.deepEqual(p, {
    category: "Balcony Bella",
    where: "midship, a lower deck",
    why: "Steady for whoever feels the motion, quiet away from the pool deck, and a balcony for that coffee. From $536.79 per person, taxes and port fees included.",
  });
});

test("without a taxes-included quote the price sentence stops at 'per person'", () => {
  assert.equal(pickCabin(ANSWERS, MILLHAM, "en", false).why, "Steady for whoever feels the motion, quiet away from the pool deck, and a balcony for that coffee. From $536.79 per person.");
  assert.equal(pickCabin(ANSWERS, MILLHAM, "en").why.endsWith("From $536.79 per person."), true, "taxes are not assumed");
});

test("a treat or sky budget takes the higher-priced category, a lean or middle budget the lower, whatever order the list comes in", () => {
  const shuffled = [MILLHAM[1]!, MILLHAM[0]!];
  for (const budget of ["treat", "sky"] as const) {
    assert.equal(pickCabin({ ...ANSWERS, budget }, MILLHAM).category, "Balcony Aurea", budget);
    assert.equal(pickCabin({ ...ANSWERS, budget }, shuffled).category, "Balcony Aurea", `${budget}, list reversed`);
    assert.match(pickCabin({ ...ANSWERS, budget }, MILLHAM).why, /From \$686\.79 per person/);
  }
  for (const budget of ["lean", "middle"] as const) {
    assert.equal(pickCabin({ ...ANSWERS, budget }, MILLHAM).category, "Balcony Bella", budget);
    assert.equal(pickCabin({ ...ANSWERS, budget }, shuffled).category, "Balcony Bella", `${budget}, list reversed`);
  }
  // prices compare as numbers, not as text ("$1,000" is more than "$900")
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

test("why is assembled only from what they said: each clause appears for its answer and never otherwise", () => {
  const why = (o: Partial<Concierge>, held = MILLHAM) => pickCabin({ ...ANSWERS, ...o }, held, "en", true).why;
  assert.match(why({ motion: "yes" }), /^Steady for whoever feels the motion/);
  assert.ok(!why({ motion: "no" }).includes("Steady"));
  assert.ok(why({ priority: "quiet" }).includes("quiet away from the pool deck"));
  assert.ok(!why({ priority: "ocean" }).includes("quiet"));
  assert.ok(why({ room: "suite" }).includes("a balcony for that coffee"));
  // an inside request: the group's cabins are all balconies, so they get one anyway
  assert.ok(why({ room: "inside" }).includes("the group's cabins are all balconies, so you get one anyway"));
  assert.ok(!why({ room: "inside" }).includes("for that coffee"));
  // the first clause is a sentence start, two clauses are joined with "and", and the sentence ends with a full stop before the price
  assert.equal(why({ motion: "no", priority: "quiet", room: "oceanview" }), "Quiet away from the pool deck. From $536.79 per person, taxes and port fees included.");
  assert.equal(why({ motion: "yes", priority: "ocean", room: "balcony" }), "Steady for whoever feels the motion and a balcony for that coffee. From $536.79 per person, taxes and port fees included.");
  // nothing to say but the price: still a sentence, never a bare price
  assert.equal(why({ motion: "no", priority: "action", room: "oceanview" }), "Our best fit for what you told us. From $536.79 per person, taxes and port fees included.");
});

test("a balcony is never promised for a cabin that is not one", () => {
  const mixed: Held[] = [{ category: "Interior", perPersonText: "$400" }, { category: "Balcony", perPersonText: "$600" }];
  const lowerPick = pickCabin({ ...ANSWERS, budget: "lean" }, mixed, "en", true);
  assert.equal(lowerPick.category, "Interior");
  assert.ok(!/balcon/i.test(lowerPick.why), lowerPick.why);
  // an inside request is only told "the group's cabins are all balconies" when they all are
  assert.ok(!pickCabin({ ...ANSWERS, room: "inside" }, mixed, "en").why.includes("all balconies"));
  assert.ok(pickCabin({ ...ANSWERS, budget: "sky" }, mixed, "en").why.includes("a balcony for that coffee"));
});

test("no categories to choose from (prices hidden): it names the kind of cabin they asked for and quotes no price", () => {
  const p = pickCabin({ ...ANSWERS, room: "oceanview" }, [], "en", true);
  assert.equal(p.category, "Oceanview");
  assert.ok(!/\$|From/.test(p.why), p.why);
  assert.equal(pickCabin({ ...ANSWERS, room: "suite" }, [], "es").category, "Suite");
  // a category with no readable price is still pickable, and quotes none
  const noPrice = pickCabin(ANSWERS, [{ category: "Balcony Bella", perPersonText: null }], "en");
  assert.equal(noPrice.category, "Balcony Bella");
  assert.ok(!/From/.test(noPrice.why));
});

test("Spanish: the same pick in Spanish, addressed as usted, with the price sentence", () => {
  const p = pickCabin(ANSWERS, MILLHAM, "es", true);
  assert.equal(p.category, "Balcony Bella");
  assert.equal(p.where, "en el centro del barco, en una cubierta baja");
  assert.equal(p.why, "Estable para quien sienta el movimiento, alejada de la cubierta de la piscina y un balcón para ese café. Desde $536.79 por persona, con impuestos y cargos portuarios incluidos.");
  assert.equal(pickCabin(ANSWERS, MILLHAM, "es", false).why.endsWith("Desde $536.79 por persona."), true);
  assert.equal(pickCabin({ ...ANSWERS, motion: "no", priority: "ocean" }, MILLHAM, "es").where, "en una cubierta alta");
});

// ── validateDetails ───────────────────────────────────────────────────────────

const GOOD = { travelers: [{ legal_name: "Mark Millham", dob: "1965-04-12" }, { legal_name: "Ceci  Millham", dob: "1980-11-02" }], concierge: ANSWERS };

test("good details pass, names are tidied, and the count is what came", () => {
  const v = validateDetails(GOOD, 2, "en", NOW);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.deepEqual(v.travelers, [{ legal_name: "Mark Millham", dob: "1965-04-12" }, { legal_name: "Ceci Millham", dob: "1980-11-02" }]);
  assert.deepEqual(v.concierge, ANSWERS);
  assert.equal(v.count, 2);
});

test("the number of travelers may differ from the party size they gave (people change their minds), from 1 to 12", () => {
  const one = validateDetails({ ...GOOD, travelers: [GOOD.travelers[0]] }, 4, "en", NOW);
  assert.ok(one.ok && one.count === 1);
  const twelve = validateDetails({ ...GOOD, travelers: Array.from({ length: 12 }, (_, i) => ({ legal_name: `Person Number${"x".repeat(i % 3)}`, dob: "1990-01-01" })) }, 2, "en", NOW);
  assert.ok(twelve.ok && twelve.count === 12);
  const none = validateDetails({ ...GOOD, travelers: [] }, 2, "en", NOW);
  assert.ok(!none.ok && none.error === "Please add at least one traveler." && none.field === "travelers");
  const thirteen = validateDetails({ ...GOOD, travelers: Array.from({ length: 13 }, () => GOOD.travelers[0]) }, 2, "en", NOW);
  assert.ok(!thirteen.ok && /Up to 12 travelers/.test(thirteen.error));
  assert.ok(!validateDetails({ concierge: ANSWERS }, 2, "en", NOW).ok, "no list at all");
});

test("a name must be a plain name of 2 to 80 characters with no markup", () => {
  const name = (legal_name: unknown) => validateDetails({ ...GOOD, travelers: [{ legal_name, dob: "1965-04-12" }] }, 1, "en", NOW);
  for (const ok of ["Li", "Mary-Ann O'Brien", "María José Núñez", "Jean-Luc Picard Jr.", "Zoë Ångström", "Ann’s Smith"]) assert.ok(name(ok).ok, ok);
  for (const bad of ["", " ", "A", "<b>Mark</b>", "Mark <script>", "Mark & Ceci", "Mark123", "12345", "x".repeat(81), "-Mark", null, 12, undefined, {}, ["Mark"]]) {
    const v = name(bad);
    assert.ok(!v.ok, JSON.stringify(bad));
    if (!v.ok) { assert.equal(v.error, "Traveler 1: please type the name as it is on the passport."); assert.equal(v.field, "travelers.0.legal_name"); }
  }
  assert.ok(name("x".repeat(80).replace(/x/g, "a")).ok, "exactly 80 is allowed");
  // the second traveler is named in the message
  const second = validateDetails({ ...GOOD, travelers: [GOOD.travelers[0], { legal_name: "<i>", dob: "1990-01-01" }] }, 2, "en", NOW);
  assert.ok(!second.ok && second.error.startsWith("Traveler 2:") && second.field === "travelers.1.legal_name");
});

test("a birthday is a real date, not in the future and under 120 years ago", () => {
  const dob = (v: unknown) => validateDetails({ ...GOOD, travelers: [{ legal_name: "Mark Millham", dob: v }] }, 1, "en", NOW);
  for (const ok of ["1965-04-12", "2026-10-23", "1906-10-24", "2000-02-29", "2026-01-01"]) assert.ok(dob(ok).ok, ok);
  for (const bad of ["2026-10-24", "2027-01-01", "1906-10-23", "1900-01-01", "2001-02-29", "1965-13-01", "1965-00-10", "1965-04-31", "04/12/1965", "1965-4-12", "12/04/65", "yesterday", "", null, 19650412, {}]) {
    const v = dob(bad);
    assert.ok(!v.ok, JSON.stringify(bad));
    if (!v.ok) assert.equal(v.field, "travelers.0.dob");
  }
  const missing = dob("");
  assert.ok(!missing.ok && missing.error === "Traveler 1: please add a date of birth.");
  const wrong = dob("2099-01-01");
  assert.ok(!wrong.ok && wrong.error === "Traveler 1: that date of birth does not look right. Please check it.");
});

test("each concierge answer must be one of its allowed values", () => {
  const answers = (o: Record<string, unknown>) => validateDetails({ ...GOOD, concierge: { ...ANSWERS, ...o } }, 2, "en", NOW);
  assert.ok(answers({}).ok);
  for (const [k, ok, bad] of [
    ["room", ["inside", "oceanview", "balcony", "suite"], ["", "Balcony", "penthouse", null, 1]],
    ["priority", ["ocean", "quiet", "action", "space"], ["", "peace", "QUIET", undefined]],
    ["budget", ["lean", "middle", "treat", "sky"], ["", "cheap", "treat ", 3]],
    ["motion", ["yes", "no"], ["", "maybe", true, false, "Yes"]],
  ] as const) {
    for (const v of ok) assert.ok(answers({ [k]: v }).ok, `${k}=${v}`);
    for (const v of bad) {
      const r = answers({ [k]: v });
      assert.ok(!r.ok, `${k}=${JSON.stringify(v)}`);
      if (!r.ok) { assert.equal(r.field, `concierge.${k}`); assert.equal(r.error, "Please tap one answer for each of the four room questions."); }
    }
  }
  assert.ok(!validateDetails({ travelers: GOOD.travelers }, 2, "en", NOW).ok, "no answers at all");
  assert.ok(!validateDetails({ travelers: GOOD.travelers, concierge: "balcony" }, 2, "en", NOW).ok);
  for (const junk of [null, undefined, "x", 5, [], true]) assert.ok(!validateDetails(junk, 2, "en", NOW).ok, JSON.stringify(junk));
});

test("every refusal has a Spanish twin in usted, and the message carries nothing the guest typed", () => {
  const es = (body: unknown) => { const v = validateDetails(body, 2, "es", NOW); assert.ok(!v.ok); return v.ok ? "" : v.error; };
  assert.equal(es({ ...GOOD, travelers: [] }), "Agregue al menos un viajero.");
  assert.equal(es({ ...GOOD, travelers: [{ legal_name: "<b>", dob: "1990-01-01" }] }), "Viajero 1: escriba el nombre tal como aparece en el pasaporte.");
  assert.equal(es({ ...GOOD, travelers: [{ legal_name: "Ana Pérez", dob: "" }] }), "Viajero 1: agregue la fecha de nacimiento.");
  assert.equal(es({ ...GOOD, travelers: [{ legal_name: "Ana Pérez", dob: "2099-01-01" }] }), "Viajero 1: esa fecha de nacimiento no parece correcta. Revísela.");
  assert.equal(es({ ...GOOD, concierge: {} }), "Toque una respuesta en cada una de las cuatro preguntas sobre la cabina.");
  assert.match(es(null), /Recargue la página/);
  const hostile = "<script>alert(1)</script>";
  const v = validateDetails({ ...GOOD, travelers: [{ legal_name: hostile, dob: "1990-01-01" }] }, 1, "en", NOW);
  assert.ok(!v.ok && !v.error.includes("script"));
});

// ── what the database holds ───────────────────────────────────────────────────

test("what was stored reads back, and anything else reads as nothing (a half-saved row never breaks the page)", () => {
  assert.deepEqual(storedTravelers(GOOD.travelers), GOOD.travelers);
  assert.equal(storedTravelers([]), null);
  assert.equal(storedTravelers(null), null);
  assert.equal(storedTravelers([{ legal_name: "", dob: "1990-01-01" }]), null);
  assert.equal(storedTravelers([{ legal_name: "A B" }]), null);
  assert.deepEqual(storedConcierge(ANSWERS), ANSWERS);
  assert.equal(storedConcierge({ ...ANSWERS, room: "x" }), null);
  assert.equal(storedConcierge(null), null);
  const pick = pickCabin(ANSWERS, MILLHAM);
  assert.deepEqual(storedPick(pick), pick);
  assert.equal(storedPick({ category: "x" }), null);
  assert.equal(storedPick(undefined), null);
});

test("the legal name splits on the LAST space; one word is a first name only", () => {
  assert.deepEqual(splitLegalName("Mark Millham"), { first: "Mark", last: "Millham" });
  assert.deepEqual(splitLegalName("Mary Ann Smith"), { first: "Mary Ann", last: "Smith" });
  assert.deepEqual(splitLegalName("  Cher  "), { first: "Cher", last: null });
  assert.deepEqual(splitLegalName("Jean Luc  Picard"), { first: "Jean Luc", last: "Picard" });
});

// ── The links ─────────────────────────────────────────────────────────────────

const TOKEN = "A".repeat(43);

test("the links: details.html?t= for English, /es/details.html?t= for Spanish, and the call link is the same page with &choice=call", () => {
  assert.equal(detailsUrl("https://stillafloatcruising.com", TOKEN), `https://stillafloatcruising.com/details.html?t=${TOKEN}`);
  assert.equal(detailsUrl("https://dev.example/", TOKEN), `https://dev.example/details.html?t=${TOKEN}`, "a trailing slash is not doubled");
  assert.equal(callUrl("https://stillafloatcruising.com", TOKEN), `https://stillafloatcruising.com/details.html?t=${TOKEN}&choice=call`);
  assert.equal(detailsUrl("https://stillafloatcruising.com", TOKEN, "es"), `https://stillafloatcruising.com/es/details.html?t=${TOKEN}`);
  assert.equal(callUrl("https://stillafloatcruising.com", TOKEN, "es"), `https://stillafloatcruising.com/es/details.html?t=${TOKEN}&choice=call`);
});

test("a link works for 90 days from when it was made, and a missing or unreadable time never works", () => {
  const made = new Date(NOW.getTime() - 89 * 86_400_000).toISOString();
  assert.equal(detailsTokenFresh(made, NOW), true);
  assert.equal(detailsTokenFresh(NOW.toISOString(), NOW), true);
  assert.equal(detailsTokenFresh(new Date(NOW.getTime() - 91 * 86_400_000).toISOString(), NOW), false);
  assert.equal(detailsTokenFresh(new Date(NOW.getTime() + 3_600_000).toISOString(), NOW), false, "from the future");
  for (const v of [null, undefined, "", "not a date", 12345, {}]) assert.equal(detailsTokenFresh(v, NOW), false, String(v));
});

// ── The acknowledgement email ─────────────────────────────────────────────────

function ack(over: Partial<AckInput> = {}): AckInput {
  return {
    firstName: "Mark", groupLabel: "Friends and Family 2027", ship: "MSC Seashore",
    sailDateText: "Sunday, May 9, 2027", returnDateText: "Thursday, May 13, 2027", embarkPort: "Port Canaveral",
    ports: ["Nassau", "Ocean Cay MSC Marine Reserve"], cabinPrices: [{ category: "Balcony Bella", perPersonText: "$536.79" }, { category: "Balcony Aurea", perPersonText: "$686.79" }],
    taxesIncluded: true, depositPerPersonText: "$50",
    detailsUrl: `https://stillafloatcruising.com/details.html?t=${TOKEN}`, callUrl: `https://stillafloatcruising.com/details.html?t=${TOKEN}&choice=call`,
    phone: "919-346-6127", hostNames: "Mark & Ceci", lang: "en", publicSite: "https://stillafloatcruising.com",
    ...over,
  };
}

test("the email says the approved words, built from the facts passed in", () => {
  const m = ackEmail(ack());
  assert.equal(m.subject, "You're on the list for Friends and Family 2027");
  for (const line of [
    "Hi Mark,",
    "You tapped Count me in! and that's all we needed. Two ways from here, your call:",
    `1. I'll finish it now: https://stillafloatcruising.com/details.html?t=${TOKEN}`,
    "Names, birthdays and four quick questions from our Room Concierge. About three minutes, and your cabin is held.",
    `2. Mark, call me: https://stillafloatcruising.com/details.html?t=${TOKEN}&choice=call`,
    "Either way, two cabins to choose from: Balcony Bella from $536.79 or Balcony Aurea from $686.79 per person, taxes and port fees included… and just $50 per person holds your spot.",
    "The plan in one breath: we sail from Port Canaveral on Sunday, May 9, 2027… stops in Nassau and Ocean Cay… and home Thursday, May 13, 2027.",
    "Questions before then? Call or text Mark at 919-346-6127.",
    "See you on board!\nMark & Ceci",
    "Still Afloat LLC dba Still Afloat Cruising\nYou got this email because you tapped Count me in on our Friends and Family 2027 page. Not you? Reply and we'll take you off.",
  ]) assert.ok(m.text.includes(line), `the text lacks: ${line}`);
  assert.match(m.html, /You're on the list, Mark!/);
  assert.match(m.html, /<b>Count me in!<\/b>/);
  assert.match(m.html, /<b>Balcony Bella from \$536\.79<\/b> or <b>Balcony Aurea from \$686\.79<\/b>/);
  assert.match(m.html, /<b>\$50 per person<\/b> holds your spot/);
});

test("the two buttons: the yellow pill goes to the details page, the outlined one to the call link, in that order", () => {
  const m = ackEmail(ack());
  const finish = m.html.indexOf("I'll finish it now");
  const call = m.html.indexOf("Mark, call me");
  assert.ok(finish > 0 && call > finish);
  assert.match(m.html, new RegExp(`background:#f5c33b;border-radius:999px"><a href="https://stillafloatcruising\\.com/details\\.html\\?t=${TOKEN}" [^>]*>I'll finish it now</a>`));
  assert.match(m.html, new RegExp(`border:2px solid #07183f;border-radius:999px"><a href="https://stillafloatcruising\\.com/details\\.html\\?t=${TOKEN}&amp;choice=call" [^>]*>Mark, call me</a>`));
  assert.ok(m.html.includes("Not you? Reply and we&#39;ll take you off.") || m.html.includes("Not you? Reply and we'll take you off."));
});

test("the logos are the site's own hosted images, so the email works on dev and on prod", () => {
  const m = ackEmail(ack({ publicSite: "http://178.156.154.144/" }));
  assert.deepEqual([...m.html.matchAll(/<img src="([^"]+)"/g)].map((x) => x[1]), ["http://178.156.154.144/assets/images/still_afloat_logo.png", "http://178.156.154.144/assets/images/cornerstone-white.png"]);
  assert.ok(!/supabase|file:\/\//.test(m.html));
});

test("what depends on the group is dropped when the file does not say it, never invented", () => {
  const bare = ackEmail(ack({ cabinPrices: [], depositPerPersonText: null, ports: [], embarkPort: null, taxesIncluded: false }));
  assert.ok(!bare.text.includes("cabins to choose from") && !bare.text.includes("holds your spot"), bare.text);
  assert.ok(bare.text.includes("The plan in one breath: we sail on Sunday, May 9, 2027… and home Thursday, May 13, 2027."), bare.text);
  const noDates = ackEmail(ack({ sailDateText: null, returnDateText: null, ports: [] }));
  assert.ok(!noDates.text.includes("The plan in one breath"));
  const oneCabin = ackEmail(ack({ cabinPrices: [{ category: "Balcony Bella", perPersonText: "$536.79" }], taxesIncluded: false, depositPerPersonText: null }));
  assert.ok(oneCabin.text.includes("Either way, your cabin: Balcony Bella from $536.79 per person, with taxes and port fees confirmed at booking."), oneCabin.text);
  const three = ackEmail(ack({ cabinPrices: [{ category: "A", perPersonText: "$1" }, { category: "B", perPersonText: "$2" }, { category: "C", perPersonText: "$3" }] }));
  assert.ok(three.text.includes("three cabins to choose from: A from $1, B from $2 or C from $3 per person"), three.text);
  assert.ok(ackEmail(ack({ hostNames: "  " })).text.includes("See you on board!\nMark\n"), "the sign-off falls back to Mark");
});

test("every value that came from a person or a file is escaped in the html", () => {
  const evil = '<img src=x onerror=alert(1)>';
  const m = ackEmail(ack({ firstName: evil, groupLabel: evil, hostNames: evil, ports: [evil], cabinPrices: [{ category: evil, perPersonText: evil }], depositPerPersonText: evil, embarkPort: evil, sailDateText: evil }));
  assert.ok(!m.html.includes("<img src=x"), "a raw tag came through");
  assert.ok(!m.html.includes("onerror=alert(1)>") && m.html.includes("&lt;img src=x onerror=alert(1)&gt;"));
});

test("the Spanish email is Spanish all the way down, in usted, with the Spanish group page's own button words", () => {
  const m = ackEmail(ack({ lang: "es", firstName: "Ana", groupLabel: "Amigos y Familia 2027", hostNames: "Mark y Ceci", sailDateText: "domingo, 9 de mayo de 2027", returnDateText: "jueves, 13 de mayo de 2027", embarkPort: "Puerto Cañaveral" }));
  assert.equal(m.subject, "Ya está en la lista de Amigos y Familia 2027");
  for (const line of [
    "Hola Ana:", "Tocó ¡Cuenten conmigo! y con eso nos basta. Dos caminos desde aquí, usted decide:", "1. Lo termino ahora: ", "2. Mark, llámeme: ",
    "De cualquier manera, dos cabinas para elegir: Balcony Bella desde $536.79 o Balcony Aurea desde $686.79 por persona, con impuestos y cargos portuarios incluidos… y solo $50 por persona aparta su lugar.",
    "El plan en pocas palabras: zarpamos desde Puerto Cañaveral el domingo, 9 de mayo de 2027… paradas en Nassau y Ocean Cay… y de regreso el jueves, 13 de mayo de 2027.",
    "¿Preguntas antes? Llame o escriba a Mark al 919-346-6127.", "¡Nos vemos a bordo!\nMark y Ceci",
    "Recibió este correo porque tocó ¡Cuenten conmigo! en nuestra página de Amigos y Familia 2027. ¿No fue usted? Responda y le quitamos de la lista.",
  ]) assert.ok(m.text.includes(line), `the Spanish text lacks: ${line}\n${m.text}`);
  assert.ok(!/\b(You|your|Count me in|See you)\b/.test(m.text.replace(/Room Concierge/g, "")), "English words in the Spanish email");
});

test("no em dash anywhere in the guest's email, in either language", () => {
  for (const lang of ["en", "es"] as const) {
    const m = ackEmail(ack({ lang }));
    assert.ok(!/[—–]/.test(m.text), `${lang}: a dash in the text`);
  }
});
