// cabin-match.test.ts — THE EXHAUSTIVE SWEEP.
//
// Mark, 2026-08-17: "you also need to validate absolutely every combination of
// responses to each and every section of the question pools. this was done
// half-assed when we launched."
//
// He is describing a real hole. The 8/16 run that produced the "212 of 480"
// number covered ONE section (the expectations tree), against archetype tags
// parsed out of source, because the live LLM call made a full run impossible.
// It never touched the personality interview, the destination question, or any
// ship. Before that, the tool was declared end-to-end tested when only the
// twelve archetypes had been exercised — which by construction cannot reveal
// that twelve archetypes don't cover the answers people give.
//
// So this file sweeps every option of every question in both pools, against
// every ship, and asserts the visitor is never silently given something other
// than what they asked for.
//
//   personality interview   4×4×4×4×4×2                    =  2,048
//   expectations tree       8×5×5×4×4×3                    =  9,600
//   selection               9,600 × 138 ships              = 1,324,800
//
// THE FIXTURE IS DUMPED FROM SUPABASE (cabin-advisor/dump-fixture.mjs), not from
// the local JSON grids. Built from the files it disagreed with the database —
// 88.8% exact where the data supports 88.41% — so a green run here was not
// evidence about production. Regenerate it from the DB whenever cabin data
// changes; cabin-advisor/e2e-sweep.mjs runs the same sweep against live rows and
// the two must report identical outcome counts.
//
// No network, no database, no LLM. The live model rewrites the WORDING of a
// pick and cannot change WHICH cabins are picked (routes/cabins.ts maps over
// the existing list, keyed by cabin number), so selection is fully decidable
// here. The one place the model could change identity — the steer-clear list,
// which it replaces wholesale — is covered by the phantom guard below.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeAnswers, pickArchetype, selectCabins, selectionNote, classifyCategory,
  shipTypeInventory, zonesForCabin, viewVerdict, ARCHETYPE_TAGS,
  type CabinType, type PoolCabin, type Zone,
} from "./cabin-match";
import {
  PERSONALITY_QS, EXPECT_QS, inferAxes, traitsFor, everyCombination, type Axes,
} from "./concierge-interview";
import fixture from "./__fixtures__/cabin-pool.fixture.json";

// EVERY ship the visitor can pick — 138, not the 45 class reps.
//
// Mark, 2026-08-17: "you keep saying 45 ships. we have many more ships in the DB."
// He was right twice. 45 is the count of hull grids; the picker offers 138 ships,
// and the bug that mattered most lived in the glue BETWEEN them — a class-name
// lookup that gave five Carnival ships Norwegian Spirit's cabins and two more
// Grand Princess's. Sweeping the 45 reps could never have found it, because it is
// a bug in how a ship chooses its rep. So the sweep runs the fleet.
type ShipFixture = {
  ship: string;
  line: string;
  /** null = this hull was researched directly; otherwise the sister it was copied from. */
  derivedFrom: string | null;
  categoryCounts: Record<string, number>;
  gridSize: number;
  pool: [string, string, number | null, string | null, boolean][];
  steer: [string, string, boolean][];
  placement: Record<string, [number | null, string | null, string | null]>;
};
const SHIPS = fixture.ships as unknown as Record<string, ShipFixture>;
const SHIP_SLUGS = Object.keys(SHIPS);
const ARCHETYPE_ROWS = Object.keys(ARCHETYPE_TAGS).map((archetype_id) => ({ archetype_id }));

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE SEASICK REGRESSION — the exact bug, both directions.
// ─────────────────────────────────────────────────────────────────────────────

test("motion: the page's boolean is understood (8/16 shipped a string compare against it)", () => {
  // The page sends `motion: this.expect.motion === "yes"`, i.e. a boolean.
  assert.equal(normalizeAnswers({ motion: true }).seasick, true);
  assert.equal(normalizeAnswers({ motion: false }).seasick, false);
  // An older or hand-rolled client may send the raw option value.
  assert.equal(normalizeAnswers({ motion: "yes" }).seasick, true);
  assert.equal(normalizeAnswers({ motion: "no" }).seasick, false);
  // Unanswered is not seasick.
  assert.equal(normalizeAnswers({}).seasick, false);
  assert.equal(normalizeAnswers({ motion: null }).seasick, false);
});

test("motion: the archetype layer CANNOT carry seasickness — measured, not assumed", () => {
  // Only 3 of 12 archetypes carry "steady" and all 3 are couple-shaped, so party
  // weight (+2) beats the seasick signal for solo/family/group travellers. This
  // documents the real number so nobody "fixes" it by tilting the archetype
  // weights — which would hand a family a couple's advice. The seasick answer is
  // honoured at the CABIN level instead (next test).
  let seasickTotal = 0, nonSteady = 0;
  for (const combo of everyCombination(EXPECT_QS)) {
    const { raw, motionYes } = answersFrom(combo);
    if (!motionYes) continue;
    seasickTotal++;
    const id = pickArchetype(ARCHETYPE_ROWS, normalizeAnswers(raw));
    if (!id || !(ARCHETYPE_TAGS[id] ?? []).includes("steady")) nonSteady++;
  }
  assert.equal(seasickTotal, 3200);
  assert.ok(nonSteady > 0, "if this is now 0 the archetype set changed — re-check the cabin-level rule");
});

test("motion: a seasick visitor is never LED with a cabin the research says moves", () => {
  const zones: Zone[] = [
    { factor: "motion", decks: [17], sections: ["forward"], sides: [], what: "High and far forward.",
      effect: "You feel the pitch here in any swell.", mattersTo: "Anyone prone to motion.",
      severity: "moderate", confidence: "medium", source: "class research" },
  ];
  const pool: PoolCabin[] = [
    // the archetype's own top pick, but in the part of the hull that moves
    { cabin: "17001", archetypeId: "chosen", rank: 1, category: "Balcony", deck: 17, section: "forward", side: "port" },
    // a lesser-ranked pick from another archetype, midship and low
    { cabin: "8100", archetypeId: "other", rank: 3, category: "Balcony", deck: 8, section: "mid", side: "port" },
  ];
  const inventory = shipTypeInventory({ Balcony: 100 });
  const known = new Set(["17001", "8100"]);

  const seasick = selectCabins({
    pool, chosenArchetypeId: "chosen", zones, knownCabins: known, inventory,
    answers: normalizeAnswers({ room: "balcony", motion: true }),
  });
  assert.equal(seasick.picks[0]?.cabin, "8100", "a seasick visitor was led with the pitching cabin");

  // Someone who is fine gets the archetype's own order back — no silent penalty.
  const fine = selectCabins({
    pool, chosenArchetypeId: "chosen", zones, knownCabins: known, inventory,
    answers: normalizeAnswers({ room: "balcony", motion: false }),
  });
  assert.equal(fine.picks[0]?.cabin, "17001");
});

test("motion: someone who says they get seasick can actually reach the steady archetype", () => {
  // 8/15 made everyone seasick; 8/16 made nobody seasick. Both passed review.
  let reached = 0;
  for (const combo of everyCombination(EXPECT_QS)) {
    const a = answersFrom(combo);
    if (!a.motionYes) continue;
    const id = pickArchetype(ARCHETYPE_ROWS, normalizeAnswers(a.raw));
    if (id && (ARCHETYPE_TAGS[id] ?? []).includes("steady")) reached++;
  }
  assert.ok(reached > 0, "no seasick answer anywhere reaches a steady-tagged archetype");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE PERSONALITY INTERVIEW — all 2,048 combinations.
// ─────────────────────────────────────────────────────────────────────────────

test("personality: every one of the 2,048 combinations yields a complete, valid profile", () => {
  const combos = everyCombination(PERSONALITY_QS);
  assert.equal(combos.length, 2048, "the personality pool changed — update the expected count");
  const seen: Record<keyof Axes, Set<string>> = {
    energy: new Set(), social: new Set(), structure: new Set(), splurge: new Set(), crowds: new Set(),
  };
  const VALID: Record<keyof Axes, string[]> = {
    energy: ["party", "quiet", "social"],
    social: ["extrovert", "introvert", "mixed"],
    structure: ["planner", "loose"],
    splurge: ["cabin", "value", "consumables"],
    crowds: ["avoids", "loves-it", "tolerates"],
  };
  for (const combo of combos) {
    const axes = inferAxes(traitsFor(combo));
    for (const k of Object.keys(VALID) as (keyof Axes)[]) {
      assert.ok(VALID[k].includes(axes[k]), `combo ${combo.join("")} produced ${k}=${axes[k]}`);
      seen[k].add(axes[k]);
    }
  }
  // A value no answer can ever produce is a dead branch in the ship matcher.
  for (const k of Object.keys(VALID) as (keyof Axes)[]) {
    const missing = VALID[k].filter((v) => !seen[k].has(v));
    assert.deepEqual(missing, [], `${k} values unreachable from any answer: ${missing.join(", ")}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE EXPECTATIONS TREE — all 9,600 combinations.
// ─────────────────────────────────────────────────────────────────────────────

/** Build the request the page would send for one combination of option indices. */
function answersFrom(combo: readonly number[]) {
  const pick = (i: number) => EXPECT_QS[i]!.options[combo[i] ?? 0]!.value!;
  const motionYes = pick(5) === "yes";
  return {
    motionYes,
    raw: {
      party: pick(1),
      room: pick(2),
      priority: pick(3),
      budget: pick(4),
      motion: motionYes,          // exactly what room-concierge.html sends
    },
    destination: pick(0),
  };
}

test("expectations: all 9,600 combinations normalise to a usable request", () => {
  const combos = everyCombination(EXPECT_QS);
  assert.equal(combos.length, 9600, "the expectations pool changed — update the expected count");
  for (const combo of combos) {
    const { raw } = answersFrom(combo);
    const a = normalizeAnswers(raw);
    assert.ok(a.party, "party lost in normalisation");
    assert.ok(a.room, `room "${raw.room}" did not survive normalisation`);
    assert.ok(a.priority, "priority lost in normalisation");
    assert.equal(a.seasick, raw.motion, "the seasick answer did not round-trip");
    assert.ok(pickArchetype(ARCHETYPE_ROWS, a), "no archetype chosen");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. SELECTION — 9,600 answer sets × 45 ships = 432,000 cases.
//    This is the one that was never run.
// ─────────────────────────────────────────────────────────────────────────────

function poolFor(f: ShipFixture): PoolCabin[] {
  return f.pool.map(([cabin, archetypeId, rank, category]) => ({ cabin, archetypeId, rank, category }));
}
function knownFor(f: ShipFixture): Set<string> {
  return new Set(f.pool.filter((p) => p[4]).map((p) => p[0]));
}

test("selection: a visitor is NEVER silently given a cabin type they did not ask for", () => {
  const combos = everyCombination(EXPECT_QS);
  const outcomes: Record<string, number> = {};
  let cases = 0;
  const failures: string[] = [];

  for (const slug of SHIP_SLUGS) {
    const f = SHIPS[slug]!;
    const pool = poolFor(f);
    const known = knownFor(f);
    const inventory = shipTypeInventory(f.categoryCounts);

    for (const combo of combos) {
      const a = normalizeAnswers(answersFrom(combo).raw);
      const chosen = pickArchetype(ARCHETYPE_ROWS, a);
      const sel = selectCabins({ pool, chosenArchetypeId: chosen, answers: a, inventory, knownCabins: known });
      cases++;
      outcomes[sel.outcome] = (outcomes[sel.outcome] ?? 0) + 1;

      if (sel.outcome === "no-data") {
        // A ship we hold nothing for must show nothing and say so — never borrow.
        if (sel.picks.length) failures.push(`${slug} has no data but returned picks`);
        if (!selectionNote(sel, f.ship, "en")) failures.push(`${slug} no-data with no explanation`);
      } else if (sel.outcome === "exact") {
        // Every served cabin must BE the requested type. This is the assertion
        // that would have caught the balcony-asker being handed ocean-view rooms.
        for (const p of sel.picks) {
          if (classifyCategory(p.category) !== sel.asked) {
            failures.push(`${slug} asked=${sel.asked} served=${p.category} (${p.cabin})`);
          }
        }
      } else if (sel.asked) {
        // Not exact: the visitor MUST be told, in words, why.
        const note = selectionNote(sel, f.ship, "en");
        if (!note) failures.push(`${slug} asked=${sel.asked} outcome=${sel.outcome} but no note`);
      }
      // Never a dead end — every path lands somewhere real, unless we hold
      // nothing for that ship, in which case saying so IS the right answer.
      if (!sel.picks.length && sel.outcome !== "no-data") failures.push(`${slug} produced zero picks`);
    }
  }

  assert.equal(cases, 9600 * SHIP_SLUGS.length);
  assert.equal(SHIP_SLUGS.length, 138, "the sweep must cover every ship the picker offers, not the class reps");
  assert.deepEqual(failures.slice(0, 10), [], `${failures.length} mismatches across ${cases} cases`);
  // Surfaced so a coverage regression is visible in the test output, not silent.
  console.log(`    swept ${cases.toLocaleString()} selections:`, outcomes);
});

test("selection: the honest outcomes are distinguishable, not one catch-all", () => {
  // Carnival Elation genuinely has no balconies — that is a fact about the ship,
  // and the visitor must be told THAT, not handed ocean-view rooms in silence.
  const f = SHIPS["carnival-elation"];
  if (f) {
    const inventory = shipTypeInventory(f.categoryCounts);
    assert.equal(inventory.balcony, 0, "fixture drift: Elation should have no balconies");
    const a = normalizeAnswers({ party: "couple", room: "balcony", priority: "ocean", budget: "middle", motion: false });
    const sel = selectCabins({
      pool: poolFor(f), chosenArchetypeId: pickArchetype(ARCHETYPE_ROWS, a),
      answers: a, inventory, knownCabins: knownFor(f),
    });
    assert.equal(sel.outcome, "ship-has-none");
    const note = selectionNote(sel, f.ship, "en");
    assert.match(String(note), /doesn't have balcony cabins/);
    // Mark's rule: never blame the line.
    assert.doesNotMatch(String(note), /undisclosed|didn't tell|mislabel|hid/i);
  }
});

test("selection: cabins that are not on the ship never reach the visitor", () => {
  // 6 of 3,081 stored recommendations name cabins that do not exist on their ship,
  // because the advice corpus was model-written. The filter is inside selectCabins
  // so no caller can forget it.
  const pool: PoolCabin[] = [
    { cabin: "8000", archetypeId: "x", rank: 1, category: "Balcony" },
    { cabin: "GHOST1", archetypeId: "x", rank: 2, category: "Balcony" },
  ];
  const a = normalizeAnswers({ room: "balcony" });
  const sel = selectCabins({
    pool, chosenArchetypeId: "x", answers: a,
    inventory: shipTypeInventory({ Balcony: 10 }), knownCabins: new Set(["8000"]),
  });
  assert.deepEqual(sel.picks.map((p) => p.cabin), ["8000"]);
  assert.deepEqual(sel.dropped, ["GHOST1"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE MOAT — obstruction zones, and the refusal to give a false all-clear.
// ─────────────────────────────────────────────────────────────────────────────

const ZONE = (over: Partial<Zone> = {}): Zone => ({
  factor: "lifeboat", decks: [6], sections: ["forward"], sides: [],
  what: "Lifeboats sit on the deck below.", effect: "The downward sightline is blocked.",
  mattersTo: "People who want to look straight down.",
  severity: "moderate", confidence: "high", source: "cruisedeckplans.com deck 6", ...over,
});

test("zones: a view factor never applies to a cabin with no window", () => {
  const zones = [ZONE()];
  const balcony = { deck: 6, section: "forward", side: "port", category: "Balcony" };
  const inside = { deck: 6, section: "forward", side: "port", category: "Interior" };
  assert.equal(zonesForCabin(balcony, zones).length, 1);
  assert.equal(zonesForCabin(inside, zones).length, 0, "a lifeboat cannot block an interior cabin's view");
});

test("zones: an unknown section does not inherit a sectioned zone", () => {
  // Guessing here would put a warning on somebody's actual booked cabin.
  assert.equal(zonesForCabin({ deck: 6, section: null, side: null, category: "Balcony" }, [ZONE()]).length, 0);
  // A whole-deck zone (no sections) still applies.
  assert.equal(zonesForCabin({ deck: 6, section: null, side: null, category: "Balcony" }, [ZONE({ sections: [] })]).length, 1);
});

test("verdict: no matching zone produces SILENCE, never an all-clear", () => {
  const v = viewVerdict({ deck: 99, section: "aft", side: "port", category: "Balcony" }, [ZONE()]);
  assert.equal(v.headline, null, "absence of research is not evidence of a clear view");
  assert.equal(v.detail.length, 0);
});

test("verdict: never accuses the cruise line, and never leaks the confidence score", () => {
  const v = viewVerdict({ deck: 6, section: "forward", side: "port", category: "Balcony" }, [ZONE()]);
  assert.ok(v.headline);
  const prose = [v.headline, ...v.detail].join(" ");
  assert.doesNotMatch(prose, /undisclosed|didn't tell|did not tell|mislabel|hid |hiding|they won'?t tell/i);
  assert.doesNotMatch(prose, /\d+\s*%|confidence/i, "confidence must never be rendered");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. DRIFT GUARD — the page and the server must agree about the questions.
// ─────────────────────────────────────────────────────────────────────────────

test("the page's question pools match this module's", () => {
  // The page carries its own inline copy because it renders the questions. When
  // the two disagree, the visitor answers one questionnaire and the server scores
  // a different one — which is exactly how the motion bug survived two fixes.
  // On dev the working tool is room-concierge.html; on main it was replaced by a
  // holding page and preserved as .bak by the 8/16 rollback. Read whichever is
  // the real tool on this branch so the guard works either side of the restore.
  const candidates = ["room-concierge.live.html.bak", "room-concierge.html"]
    .map((f) => join(process.cwd(), "public", f));
  const path = candidates.find((p) => existsSync(p) && readFileSync(p, "utf8").includes("EXPECT_QS"));
  assert.ok(path, "no room-concierge page defines EXPECT_QS — the tool page is missing");
  const html = readFileSync(path!, "utf8");
  const pool = (name: string) => {
    const m = html.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\n\\];`));
    assert.ok(m, `${name} not found in room-concierge — did the page stop defining it?`);
    return m![1]!;
  };
  const expectSrc = pool("EXPECT_QS");
  for (const q of EXPECT_QS) {
    assert.ok(expectSrc.includes(`key:"${q.key}"`), `page is missing the "${q.key}" question`);
    for (const o of q.options) {
      assert.ok(expectSrc.includes(`"${o.value}"`), `page has no option with value "${o.value}" for ${q.key}`);
    }
  }
  const personalitySrc = pool("PERSONALITY_QS");
  for (const q of PERSONALITY_QS) {
    assert.ok(personalitySrc.includes(`key:"${q.key}"`), `page is missing the "${q.key}" personality question`);
    assert.equal(
      (personalitySrc.match(new RegExp(`key:"${q.key}"[\\s\\S]*?opts:\\[([\\s\\S]*?)\\]\\s*\\}`))?.[1]?.match(/\["/g) ?? []).length,
      q.options.length,
      `option count drifted for "${q.key}"`,
    );
  }
});
