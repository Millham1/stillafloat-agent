#!/usr/bin/env node
// Give a category back to cabins that came in through a geometry vision read.
//
// THE PROBLEM. Five hulls — MSC World America / Asia / Atlantic and the two
// Prima Plus ships — were loaded from a vision read of their deck plans. That
// read captured a cabin's number, position and COLOUR, but never what the
// colour meant, so 9,039 cabins sit with category = null. A visitor asking for
// a balcony on MSC World America is told, honestly but uselessly, that we
// can't confirm which of these are balconies. DeckMaps, the usual category
// source, hosts World Europa but none of the five.
//
// WHAT MAKES THIS SAFE TO DO AT ALL. Three independent things have to agree
// before a cabin gets a category, and the unit of decision is a whole
// (deck, colour) GROUP, never an individual cabin:
//
//   1. COLOUR IS A KEY. On World Europa, where DeckMaps gives us the truth,
//      (deck, fill) predicts category with no exceptions at all — 66 groups,
//      2,311 cabins, every group perfectly pure. A deck plan colours a cabin
//      by what it sells it as. So naming a group names every cabin in it.
//
//   2. THE SISTER NAMES THE GROUP. World America shares cabin number AND deck
//      with Europa on 2,137 of 2,457 cabins, so the sister's DeckMaps category
//      tells us what a colour means on this hull.
//
//   3. THE LINE'S OWN LEGEND HAS TO ALLOW IT. Widgety preserved each ship's
//      per-deck category list exactly as the line publishes it (see
//      extract-deck-legends.mjs). An assignment is REJECTED unless that deck of
//      that ship actually offers a category of the same kind. This is what
//      makes decks the sister can't reach usable: America's deck 9 has no
//      Europa counterpart at all, but MSC lists Deluxe Balcony / Deluxe
//      Interior / Deluxe Ocean View / Grand Suite Aurea on it, and the ship's
//      own colours say which is which. The legend also DISAMBIGUATES — blue is
//      Infinite Ocean View on decks 10-12 but plain Ocean View on 5 and 9,
//      because that is what MSC lists on each.
//
// Anything that fails a check keeps category = null. cabin-match.ts already
// reports that honestly, and "I don't know" costs us far less than the wrong
// room — which is exactly what took this tool off production on 8/16.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── the same attribute vocabulary the matcher uses ───────────────────────────
// Kept deliberately identical to cabinAttributes() in server/src/lib/cabin-match.ts.
// If that file's patterns change, change these with it — a category this file
// writes has to be one the matcher can reason about.
const ATTR_PATTERNS = [
  ["suite", /\b(suite|haven|yacht club|retreat|villa|penthouse|owner'?s)\b/i],
  ["balcony", /(balcon|veranda|terrace|infinite)/i],
  ["inside", /(interior|inside)/i],
  ["oceanview", /(ocean ?view|sea ?view|outside|window|porthole)/i],
];
const ATTR_ALIASES = {
  studio: ["inside"],
  aquaclass: ["balcony"],
  "grand terrace suite": ["suite", "balcony"],
};

export function attrsOf(category) {
  const c = String(category ?? "").trim();
  if (!c) return [];
  const alias = ATTR_ALIASES[c.toLowerCase()];
  if (alias) return [...alias].sort();
  const out = [];
  for (const [type, re] of ATTR_PATTERNS) if (re.test(c)) out.push(type);
  return out.sort();
}

const sameAttrs = (a, b) => a.length > 0 && a.join("+") === b.join("+");

// ── thresholds ───────────────────────────────────────────────────────────────
// A group is only named when the sister evidence is both plentiful and lopsided.
// These are deliberately strict: the whole group takes the decision, so a bad
// call costs every cabin in it.
const MIN_MATCHED = 8;      // sister cabins backing the group
const MIN_PURITY = 0.90;    // share of them agreeing on the modal category
const MIN_ATTR_PURITY = 0.95; // share agreeing at the attribute level
// A group can clear the attribute bar while the specific NAME is a coin toss —
// on World Asia deck 16, sixteen brown cabins were all Yacht Club suites but
// only six were the Whirlpool Duplex the modal would have named. Every cabin
// there would have been advertised as the most expensive room in the set. So a
// name is only written when it also holds an outright majority.
const MIN_NAME_MAJORITY = 0.60;
// How one-meaning a colour must be across a hull before it may be carried to a
// deck the sister cannot reach.
const MIN_COLOUR_CONSISTENCY = 0.85;

/**
 * Decide one (deck, colour) group.
 *
 * `group` = { ship, deck, fill, grpN, blankN, matched, modalCat, modalN,
 *             attrCounts: {"balcony": 12, ...} }
 * `legend` = the categories the line lists on THIS deck of THIS ship.
 * `shipColour` = colour -> category learned from this ship's OTHER decks,
 *                used only when the sister cannot reach this deck.
 */
export function decideGroup(group, legend, shipColour) {
  const legendAttrs = new Set(legend.flatMap((c) => attrsOf(c).join("+")).filter(Boolean));
  const allowed = (cat) => legendAttrs.has(attrsOf(cat).join("+"));

  // Path A — the sister reaches this group.
  if (group.matched >= MIN_MATCHED && group.modalCat) {
    const purity = group.modalN / group.matched;
    const modalAttr = attrsOf(group.modalCat).join("+");
    const attrHits = Object.entries(group.attrCounts ?? {})
      .filter(([k]) => k === modalAttr)
      .reduce((a, [, n]) => a + n, 0);
    const attrPurity = attrHits / group.matched;

    if (purity < MIN_PURITY && attrPurity < MIN_ATTR_PURITY)
      return { action: "skip", why: `sister split (${(purity * 100).toFixed(0)}% cat, ${(attrPurity * 100).toFixed(0)}% attr)` };
    if (purity < MIN_NAME_MAJORITY)
      return { action: "skip", why: `no majority name (${group.modalN}/${group.matched} = ${(purity * 100).toFixed(0)}%)` };
    if (!allowed(group.modalCat))
      return { action: "skip", why: `"${group.modalCat}" is not a category the line lists on deck ${group.deck}` };

    return {
      action: "set",
      category: group.modalCat,
      basis: "sister+legend",
      confidence: Math.min(purity, attrPurity),
      why: `${group.modalN}/${group.matched} sister cabins, allowed by the deck legend`,
    };
  }

  // Path B — no sister coverage. Fall back to what this colour means elsewhere
  // ON THIS SHIP, and only if the legend for this deck permits it. If the deck
  // does not offer that kind of room, the colour means something else here and
  // we must not guess.
  const learned = shipColour[group.fill];
  if (!learned) return { action: "skip", why: "no sister coverage and colour unseen elsewhere on this ship" };
  if (!allowed(learned.category)) {
    // The colour's usual meaning is not on this deck. If the deck offers
    // exactly ONE category and it is the only candidate, that is still a guess
    // about a colour we have not tied down — decline.
    return { action: "skip", why: `colour usually means "${learned.category}", which the line does not list on deck ${group.deck}` };
  }
  if (learned.support < 40)
    return { action: "skip", why: `colour only seen ${learned.support}x elsewhere on this ship` };
  // A colour has to mean ONE thing on this hull before it can be carried to a
  // deck we have no sister evidence for. Norwegian Luna paints deck 5 balconies
  // and deck 12-13 studios the same pink; a plurality would have called five
  // studios balconies on the strength of a different deck.
  if (learned.purity < MIN_COLOUR_CONSISTENCY)
    return {
      action: "skip",
      why: `colour is not consistent on this ship (${(learned.purity * 100).toFixed(0)}% "${learned.category}")`,
    };

  return {
    action: "set",
    category: learned.category,
    basis: "ship-colour+legend",
    confidence: learned.purity,
    why: `colour means "${learned.category}" across ${learned.support} cabins on this ship; deck ${group.deck} lists a match`,
  };
}

// ── driver ───────────────────────────────────────────────────────────────────
// Input is the group table dumped from the DB (see README) so this file stays
// pure and testable; it emits UPDATE statements rather than writing directly.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const groupsPath = process.argv[2];
  if (!groupsPath) {
    console.error("usage: backfill-categories.mjs <groups.json> [--sql out.sql]");
    process.exit(1);
  }
  const groups = JSON.parse(readFileSync(groupsPath, "utf8"));
  const legends = JSON.parse(
    readFileSync(join(import.meta.dirname, "context", "deck-legends.json"), "utf8"),
  );

  // Learn each ship's colour vocabulary from groups the sister DID reach.
  const shipColour = {};
  for (const g of groups) {
    if (!(g.matched >= MIN_MATCHED && g.modalCat)) continue;
    if (g.modalN / g.matched < MIN_PURITY) continue;
    const per = (shipColour[g.ship] ??= {});
    const slot = (per[g.fill] ??= { counts: {}, support: 0 });
    slot.counts[g.modalCat] = (slot.counts[g.modalCat] ?? 0) + g.modalN;
    slot.support += g.modalN;
  }
  for (const per of Object.values(shipColour))
    for (const [fill, slot] of Object.entries(per)) {
      const [cat, n] = Object.entries(slot.counts).sort((a, b) => b[1] - a[1])[0];
      per[fill] = { category: cat, support: slot.support, purity: n / slot.support };
    }

  const sql = [];
  const report = [];
  let set = 0, skipped = 0;
  for (const g of groups) {
    if (!g.blankN) continue; // nothing blank in this group
    const legend = legends[g.ship]?.decks?.[String(g.deck)] ?? [];
    const d = decideGroup(g, legend, shipColour[g.ship] ?? {});
    report.push({ ...g, ...d });
    if (d.action === "set") {
      set += g.blankN;
      // category_source is what makes this reversible and reviewable: every row
      // this writes says how it was decided, and the whole pass undoes with
      //   update cabins set category=null, category_source=null
      //    where category_source like 'backfill:%';
      sql.push(
        `update cabins set category = ${lit(d.category)}, category_source = ${lit(`backfill:${d.basis}`)} ` +
          `where ship_slug = ${lit(g.ship)} and deck = ${g.deck} and fill = ${lit(g.fill)} and category is null;`,
      );
    } else skipped += g.blankN;
  }

  console.log(`groups with blanks: ${report.length}`);
  console.log(`cabins to set:      ${set}`);
  console.log(`cabins left null:   ${skipped}`);
  const i = process.argv.indexOf("--sql");
  if (i > -1) { writeFileSync(process.argv[i + 1], sql.join("\n") + "\n"); console.log(`wrote ${process.argv[i + 1]}`); }
  writeFileSync(groupsPath.replace(/\.json$/, "-decisions.json"), JSON.stringify(report, null, 2));
}

function lit(s) { return `'${String(s).replace(/'/g, "''")}'`; }
