// Every field placementLines() can read, and every line it can emit, asserted in both
// languages. Mark's standing rule (2026-08-17): a feature is tested when EVERY returned field
// has an assertion — "I swept N combinations" is only true of the property you actually named.
import assert from "node:assert/strict";
import { test } from "node:test";
import { obstructionLine, placementLines, type PlacementFacts } from "./cabin-placement.js";

const EN = (c: PlacementFacts) => placementLines(c, false);
const ES = (c: PlacementFacts) => placementLines(c, true);

test("a room with nothing recorded near it says nothing", () => {
  assert.deepEqual(EN({}), []);
  assert.deepEqual(ES({}), []);
});

test("silence is not a promise: unread deck and quiet neighbours both stay silent", () => {
  // above/below 'unknown' means we hold no grid for that deck — never spoken.
  assert.deepEqual(EN({ above_kind: "unknown", below_kind: "unknown" }), []);
  // 'cabins' above and below is the quiet case, and needs no reassurance we cannot back.
  assert.deepEqual(EN({ above_kind: "cabins", below_kind: "cabins" }), []);
});

test("a elevator lobby is named in English and written afresh in Spanish", () => {
  const en = EN({ noise_nearby: "elevator lobby", noise_kind: "lift" });
  assert.equal(en.length, 2);
  assert.match(en[0]!, /A few doors from yours, on the same deck: the elevator lobby\./);
  assert.match(en[1]!, /corridor traffic early and late/);

  const es = ES({ noise_nearby: "elevator lobby", noise_kind: "lift" });
  assert.equal(es.length, 2);
  assert.match(es[0]!, /el vestíbulo de ascensores/);
  assert.doesNotMatch(es.join(" "), /elevator|lobby|deck/i, "no English may survive into the Spanish copy");
});

test("a stairwell gets its own Spanish word, not the lift's", () => {
  const es = ES({ noise_nearby: "stairwell", noise_kind: "stairs" });
  assert.match(es[0]!, /la escalera/);
  assert.doesNotMatch(es[0]!, /ascensores/);
  assert.match(EN({ noise_nearby: "stairwell", noise_kind: "stairs" })[0]!, /the stairwell/);
});

test("a venue keeps its own name in both languages — it is a proper noun", () => {
  const c: PlacementFacts = { noise_nearby: "The Martini Bar", noise_kind: "venue" };
  assert.match(EN(c)[0]!, /The Martini Bar/);
  assert.match(ES(c)[0]!, /The Martini Bar/);
  assert.match(EN(c)[1]!, /turn in early/);
  assert.match(ES(c)[1]!, /te acuestas temprano/);
});

test("every part of a compound neighbourhood survives, in both languages", () => {
  // Naming only the loudest thing lost the most useful half: a guest laundry next door is
  // exactly what someone would want told, and it was being dropped.
  const c: PlacementFacts = {
    noise_nearby: "elevator lobby and stairwell and guest laundry", noise_kind: "lift",
  };
  assert.match(EN(c)[0]!, /the elevator lobby, the stairwell and the guest laundry\./);
  assert.match(ES(c)[0]!, /el vestíbulo de ascensores, la escalera y la lavandería\./);
  assert.doesNotMatch(ES(c)[0]!, /elevator|stairwell|laundry/i);

  // A venue name is a proper noun: it is not translated and not split apart.
  const venue: PlacementFacts = { noise_nearby: "Camp At Sea", noise_kind: "venue" };
  assert.match(EN(venue)[0]!, /Camp At Sea\./);
  assert.match(ES(venue)[0]!, /Camp At Sea\./);

  // A mixed list keeps the venue verbatim while translating the generic part around it.
  const mixed: PlacementFacts = { noise_nearby: "elevator lobby and Camp At Sea", noise_kind: "lift" };
  assert.match(EN(mixed)[0]!, /the elevator lobby and Camp At Sea\./);
  assert.match(ES(mixed)[0]!, /el vestíbulo de ascensores y Camp At Sea\./);
});

test("a venue on the deck above or below is placed there, not alongside", () => {
  // The hand pass wrote the position into the prose ("Casino on the deck above"), which put
  // English inside the Spanish copy; the position is a kind now, and the name stays a name.
  const above: PlacementFacts = { noise_nearby: "Casino", noise_kind: "venue-above" };
  assert.match(EN(above)[0]!, /^Directly above you: Casino\.$/);
  assert.match(ES(above)[0]!, /^Justo encima de ti: Casino\.$/);

  const below: PlacementFacts = { noise_nearby: "Bliss Ultra Lounge", noise_kind: "venue-below" };
  assert.match(EN(below)[0]!, /^Directly below you: Bliss Ultra Lounge\.$/);
  assert.match(ES(below)[0]!, /^Justo debajo de ti: Bliss Ultra Lounge\.$/);
  assert.doesNotMatch(EN(below)[0]!, /same deck/);
});

test("a named venue above beats the generic open-space line for the same fact", () => {
  // Both would be true, but "Directly above you: Casino" and "above you there are no cabins"
  // said together is one fact told twice, the second time less usefully.
  const en = EN({ noise_nearby: "Casino", noise_kind: "venue-above", above_kind: "open" });
  assert.equal(en.length, 2, "the generic above line must give way to the named one");
  assert.match(en[0]!, /Casino/);
  assert.doesNotMatch(en.join(" "), /no cabins/);
  // …but an open deck BELOW is a separate fact and still gets said.
  const both = EN({ noise_nearby: "Casino", noise_kind: "venue-above", above_kind: "open", below_kind: "open" });
  assert.equal(both.length, 3);
  assert.match(both[2]!, /no cabins below you/);
});

test("open space above and below is each called out, separately", () => {
  const above = EN({ above_kind: "open" });
  assert.equal(above.length, 1);
  assert.match(above[0]!, /Directly above you there are no cabins/);

  const below = EN({ below_kind: "open" });
  assert.equal(below.length, 1);
  assert.match(below[0]!, /no cabins below you/);

  const both = EN({ above_kind: "open", below_kind: "open" });
  assert.equal(both.length, 2);
});

test("Spanish carries the above/below lines too, with no English left in them", () => {
  const es = ES({ above_kind: "open", below_kind: "open" });
  assert.equal(es.length, 2);
  assert.match(es[0]!, /espacio público/);
  assert.match(es[1]!, /cocina, salón o pasillo de tripulación/);
  assert.doesNotMatch(es.join(" "), /cabins|galley|crew/i);
});

test("the worst case stacks: everything near you, in order", () => {
  const c: PlacementFacts = {
    noise_nearby: "elevator lobby", noise_kind: "lift", above_kind: "open", below_kind: "open",
  };
  const en = EN(c);
  assert.equal(en.length, 4);
  assert.match(en[0]!, /the elevator lobby/);
  assert.match(en[2]!, /above/);
  assert.match(en[3]!, /below/);
  assert.equal(ES(c).length, 4);
});

test("an empty or whitespace noise string is treated as nothing recorded", () => {
  assert.deepEqual(EN({ noise_nearby: "", noise_kind: "lift" }), []);
  assert.deepEqual(EN({ noise_nearby: "   ", noise_kind: "lift" }), []);
  assert.deepEqual(EN({ noise_nearby: null }), []);
});

test("prose survives when the kind was never coded", () => {
  // Rows written before migration 0023 carry prose with no kind; they must still speak.
  const en = EN({ noise_nearby: "elevator lobby", noise_kind: null });
  assert.equal(en.length, 2);
  assert.match(en[0]!, /elevator lobby/);
  assert.match(en[1]!, /turn in early/, "with no kind it cannot claim corridor traffic");
});

test("obstructionLine: the guest never sees the raw research string", () => {
  // 21,229 rooms carry the literal storage string "heavy: lifeboat"; /check served it as-is.
  for (const es of [false, true]) {
    const line = obstructionLine("heavy: lifeboat", "lifeboat", es)!;
    assert.ok(!/heavy:|partial-/.test(line), `severity code leaked into the guest line: ${line}`);
    assert.ok(line.length > 30, "a rendered sentence, not a code");
  }
});

test("obstructionLine: Spanish is written, not English passed through", () => {
  const es = obstructionLine("partial-low: A first-person cabin review reports…", "lifeboat", true)!;
  assert.match(es, /bote salvavidas/);
  assert.ok(!/lifeboat|review/i.test(es), "English words on the Spanish page");
});

test("obstructionLine: severity changes the claim for the same kind", () => {
  const heavy = obstructionLine("heavy: lifeboat", "lifeboat", false)!;
  const partial = obstructionLine("partial-low: lifeboat", "lifeboat", false)!;
  assert.notEqual(heavy, partial);
  assert.match(partial, /horizon stays open/);
});

test("obstructionLine: no finding, no line", () => {
  assert.equal(obstructionLine(null, null, false), null);
  assert.equal(obstructionLine("  ", "lifeboat", true), null);
});
