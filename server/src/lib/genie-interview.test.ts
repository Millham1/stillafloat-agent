// genie-interview.test.ts — the Vacation Genie's interview rules, and the page-vs-server drift guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GENIE_PERSONALITY_QS, VIRTUES, ROOM_CHOICES, PRIORITY_CHOICES, BUDGET_CHOICES, DESTINATION_CHOICES, OCCASION_CHOICES,
  parseTrip, partyOf, guestsPerRoom, genieProfile, profileAxes, profileInWords, answersInWords, type Virtue,
} from "./genie-interview";

const TODAY = "2026-11-24";
const good = {
  adults: 2, childAges: [], rooms: 1, earliest: "2027-02-01", latest: "2027-03-15", nightsMin: 6, nightsMax: 8,
  destination: "w_caribbean", room: "inside", priority: "quiet", budget: "middle", seasick: false, firstCruise: true,
  occasion: "anniversary", mobility: false, notes: "  We want Cozumel.  ",
};

/** How someone at one end of a virtue answers: the option that sits furthest that way. An option that says nothing about it counts as the middle. */
const lean = (v: Virtue, high: boolean) => GENIE_PERSONALITY_QS.map((q) => {
  let best = 0, bestScore = -Infinity;
  q.options.forEach((o, i) => { const r = o.reads[v] ?? 1; const sc = high ? r : -r; if (sc > bestScore) { best = i; bestScore = sc; } });
  return best;
});

test("each question is asked once, has a scene name, and is a scene aboard, not a self-description", () => {
  const keys = GENIE_PERSONALITY_QS.map((q) => q.key);
  assert.equal(new Set(keys).size, keys.length, "a question is asked twice");
  for (const q of GENIE_PERSONALITY_QS) {
    assert.ok(q.title.length > 3 && q.ask.length > 10, `"${q.key}" has no words`);
    assert.ok(q.options.length >= 3, `"${q.key}" is not a real choice`);
    assert.doesNotMatch(q.ask, /what kind of|which of these are you|describe yourself|are you a/i, `"${q.key}" asks them to label themselves`);
  }
});

test("every answer reads onto a ship virtue, inside the matrix's 0-to-2 space", () => {
  for (const q of GENIE_PERSONALITY_QS) for (const o of q.options) {
    const ks = Object.keys(o.reads);
    assert.ok(ks.length > 0, `"${o.label}" tells the matcher nothing`);
    for (const k of ks) {
      assert.ok((VIRTUES as readonly string[]).includes(k), `"${q.key}" reads "${k}", which is not a ship virtue`);
      const v = o.reads[k as Virtue]!;
      assert.ok(v >= 0 && v <= 2, `"${o.label}" reads ${k} at ${v}`);
    }
  }
});

test("every virtue the answers decide comes up in at least three questions, with both ends reachable", () => {
  for (const v of VIRTUES) {
    if (v === "family") continue;   // the head count decides it; one question tempers it
    const qs = GENIE_PERSONALITY_QS.filter((q) => q.options.some((o) => o.reads[v] !== undefined));
    assert.ok(qs.length >= 3, `${v} only comes up in ${qs.length} questions`);
    const hi = genieProfile(lean(v, true), false)!, lo = genieProfile(lean(v, false), false)!;
    assert.ok(hi.target[v] >= 1.5, `nobody can reach the high end of ${v} (${hi.target[v]})`);
    assert.ok(lo.target[v] <= 0.5, `nobody can reach the low end of ${v} (${lo.target[v]})`);
  }
});

test("answering the same way every time counts for more than going both ways", () => {
  const steady = genieProfile(lean("scale", true), false)!;
  const mixed = genieProfile(lean("scale", true).map((c, i) => (i % 2 ? c : lean("scale", false)[i]!)), false)!;
  assert.ok(steady.weight.scale > mixed.weight.scale, `steady ${steady.weight.scale} vs mixed ${mixed.weight.scale}`);
  assert.ok(steady.spread.scale < mixed.spread.scale);
});

test("children in the party ask for a ship built for them; without children the answer never does", () => {
  const any = GENIE_PERSONALITY_QS.map(() => 0);
  assert.equal(genieProfile(any, true)!.target.family, 2);
  const i = GENIE_PERSONALITY_QS.findIndex((q) => q.key === "cannonball");
  const noKidsPlease = [...any]; noKidsPlease[i] = GENIE_PERSONALITY_QS[i]!.options.findIndex((o) => o.reads.family === 0);
  const p = genieProfile(noKidsPlease, false)!;
  assert.equal(p.target.family, 0);
  assert.ok(p.weight.family > genieProfile(any, false)!.weight.family, "asking for no children did not count for more");
  assert.ok(genieProfile(any, false)!.target.family <= 1);
});

test("the questions can tell the cruise lines apart: every line we carry is somebody's best match", () => {
  const matrix = JSON.parse(readFileSync(join(process.cwd(), "..", "cabin-advisor", "matrix.json"), "utf8")) as { lines: Record<string, Record<string, number>> };
  const lines = Object.entries(matrix.lines);
  const bestFor = (choices: number[]) => {
    const p = genieProfile(choices, false)!;
    return lines.map(([name, v]) => [name, VIRTUES.reduce((sum, k) => sum - Math.abs((v[k] ?? 1) - p.target[k]) * p.weight[k], 0)] as const)
      .sort((a, b) => b[1] - a[1])[0]![0];
  };
  // The answer set that sits closest to each line's own virtues, question by question.
  const winners = new Set<string>();
  for (const [name, v] of lines) {
    const choices = GENIE_PERSONALITY_QS.map((q) => {
      let best = 0, bestGap = Infinity;
      q.options.forEach((o, i) => {
        const ks = Object.keys(o.reads) as Virtue[];
        const gap = ks.reduce((s2, k) => s2 + Math.abs((v[k] ?? 1) - o.reads[k]!), 0) / ks.length;
        if (gap < bestGap) { best = i; bestGap = gap; }
      });
      return best;
    });
    assert.equal(bestFor(choices), name, `someone who answers like ${name} is not sent to ${name}`);
    winners.add(name);
  }
  assert.equal(winners.size, lines.length);
});

test("the labels the reason line is worded from follow the profile", () => {
  assert.equal(profileAxes(genieProfile(lean("energy", true), false)!).energy, "party");
  assert.equal(profileAxes(genieProfile(lean("energy", false), false)!).energy, "quiet");
  assert.equal(profileAxes(genieProfile(lean("scale", false), false)!).crowds, "avoids");
  assert.equal(profileAxes(genieProfile(lean("price", true), false)!).splurge, "cabin");
  assert.equal(profileAxes(genieProfile(lean("price", false), false)!).splurge, "value");
  assert.equal(profileAxes(genieProfile(lean("structure", false), false)!).structure, "planner");
});

test("Mark's read of the answers is sentences, with no scores in it", () => {
  const w = profileInWords(genieProfile(lean("energy", true), false)!);
  assert.equal(w.length, VIRTUES.length);
  assert.equal(w[0]![0], "Energy");
  assert.match(w[0]![1], /turned up/);
  for (const [, line] of w) assert.doesNotMatch(line, /\d\.\d/, `a score leaked into "${line}"`);
});

test("a good trip parses, with the note trimmed", () => {
  const r = parseTrip(good, TODAY);
  assert.ok("trip" in r);
  if ("trip" in r) { assert.equal(r.trip.room, "inside"); assert.equal(r.trip.notes, "We want Cozumel."); assert.equal(r.trip.firstCruise, true); }
});

test("the room is asked as the Room Concierge's scene, never as a room type, and interior is one of the answers", () => {
  assert.ok(ROOM_CHOICES.some((c) => c.value === "inside"));
  for (const c of ROOM_CHOICES) assert.ok(!/interior|ocean view|balcony|suite/i.test(c.label), `"${c.label}" names a room type`);
});

test("each thing wrong with a trip comes back as one sentence saying what to fix", () => {
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ adults: 0 }, /how many adults/],
    [{ childAges: [18] }, /age from 0 to 17/],
    [{ rooms: 3 }, /more rooms than there are travelers/],
    [{ adults: 3, childAges: [4, 6, 9], rooms: 1 }, /more than five people to a room/],
    [{ adults: 1, childAges: [15], rooms: 2 }, /at least one adult/],
    [{ earliest: "2026-11-01" }, /already passed/],
    [{ latest: "2027-01-01" }, /before the first/],
    [{ nightsMin: 9, nightsMax: 7 }, /how long a trip/],
    [{ destination: "mars" }, /where you want to go/],
    [{ room: "yacht" }, /picture using your room/],
    [{ priority: "" }, /matters most/],
    [{ budget: null }, /budget/],
  ];
  for (const [change, want] of bad) {
    const r = parseTrip({ ...good, ...change }, TODAY);
    assert.ok("error" in r, `accepted ${JSON.stringify(change)}`);
    if ("error" in r) assert.match(r.error, want);
  }
});

test("the party word and the guests per room follow the head count", () => {
  assert.equal(partyOf({ adults: 2, childAges: [], rooms: 1 }), "couple");
  assert.equal(partyOf({ adults: 1, childAges: [], rooms: 1 }), "solo");
  assert.equal(partyOf({ adults: 2, childAges: [5], rooms: 1 }), "family");
  assert.equal(partyOf({ adults: 4, childAges: [], rooms: 2 }), "group");
  assert.equal(partyOf({ adults: 2, childAges: [], rooms: 2 }), "group");
  assert.equal(guestsPerRoom({ adults: 2, childAges: [5, 7], rooms: 1 }), 4);
  assert.equal(guestsPerRoom({ adults: 4, childAges: [], rooms: 2 }), 2);
  assert.equal(guestsPerRoom({ adults: 3, childAges: [], rooms: 2 }), 2);
});

test("a short or out-of-range answer list is refused, not guessed", () => {
  assert.equal(genieProfile([0, 0, 0], false), null);
  assert.equal(genieProfile(GENIE_PERSONALITY_QS.map(() => 9), false), null);
});

test("answers come back in the visitor's own words", () => {
  const w = answersInWords(GENIE_PERSONALITY_QS.map(() => 0));
  assert.equal(w.length, GENIE_PERSONALITY_QS.length);
  assert.equal(w[0]!.answer, GENIE_PERSONALITY_QS[0]!.options[0]!.label);
});

test("vacation-genie.html asks exactly the questions the server scores", () => {
  const html = readFileSync(join(process.cwd(), "public", "vacation-genie.html"), "utf8");
  const pool = (name: string) => {
    const m = html.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\n\\];`));
    assert.ok(m, `${name} not found in vacation-genie.html`);
    return m![1]!;
  };
  const src = pool("GENIE_PERSONALITY_QS");
  const pageKeys = [...src.matchAll(/key:"([A-Za-z0-9]+)"/g)].map((m) => m[1]);
  assert.deepEqual(pageKeys, GENIE_PERSONALITY_QS.map((q) => q.key), "the page asks different questions, or in a different order");
  for (const q of GENIE_PERSONALITY_QS) {
    const block = src.match(new RegExp(`key:"${q.key}"[\\s\\S]*?opts:\\[([\\s\\S]*?)\\]\\s*\\}`))?.[1] ?? "";
    const labels = [...block.matchAll(/\["([^"]+)"\]/g)].map((m) => m[1]);
    assert.deepEqual(labels, q.options.map((o) => o.label), `answers drifted for "${q.key}"`);
    const asked = src.match(new RegExp(`key:"${q.key}", q:("(?:[^"\\\\]|\\\\.)*")`))?.[1];
    assert.equal(asked ? JSON.parse(asked) : null, q.ask, `the page words "${q.key}" differently`);
  }
  const trip = pool("TRIP_QS");
  const roomPool = pool("ROOM_QS");
  assert.ok(!/key:"(room|priority)"/.test(trip), "the room questions belong in the interview, not in the trip facts");
  assert.ok(!/What kind of room/i.test(html), "the page asks for a room type by name");
  for (const [key, list, from] of [["destination", DESTINATION_CHOICES, trip], ["room", ROOM_CHOICES, roomPool], ["priority", PRIORITY_CHOICES, roomPool], ["budget", BUDGET_CHOICES, trip]] as const) {
    const block = from.match(new RegExp(`key:"${key}"[\\s\\S]*?opts:\\[([\\s\\S]*?)\\]\\]\\s*\\}`))?.[1] ?? "";
    const pairs = [...block.matchAll(/\["([^"]+)","([^"]+)"/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(pairs, list.map((o) => [o.label, o.value]), `the page's "${key}" answers drifted`);
  }
  const occ = html.match(/const OCCASIONS\s*=\s*\[([\s\S]*?)\];/)?.[1] ?? "";
  const occPairs = [...occ.matchAll(/\["([^"]+)","([^"]+)"\]/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(occPairs, OCCASION_CHOICES.map((o) => [o.label, o.value]), "the page's occasions drifted");
});
