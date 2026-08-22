#!/usr/bin/env node
// Pull each ship's OWN per-deck cabin-category list out of the Widgety archive.
//
// WHY. Three MSC World ships and the two Prima Plus hulls came into the grid
// through a geometry vision read, which recorded a colour per cabin but no
// category — 13,774 cabins fleet-wide answer "I don't have the category detail
// for this ship". DeckMaps, the usual source, does not host any of them.
//
// It turns out the line's own legend was already on disk. Widgety's ship.json
// carries one entry per deck whose `description` is MSC's / NCL's own list of
// what is on that deck, cabin categories included, and whose image filename
// carries the deck number. That is a primary source: the operator saying, in
// its own words, which categories exist on which deck.
//
// This only extracts and normalises it. Deciding which cabin gets which
// category is a separate step that has to reconcile this against the grid.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ARCHIVE = join(
  process.env.HOME,
  "Desktop/Claude Local/widgety-archive",
);

// Every ship the archive holds. MSC's older hulls carry a "-ship" suffix in
// Widgety's slugs that our fleet does not use (msc-poesia-ship -> msc-poesia),
// so the directory name is normalised rather than listed by hand.
const ARCHIVE_DIRS = readdirSync(ARCHIVE, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const dbSlug = (dir) => dir.replace(/-ship$/, "");

/** Deck number from the image filename ("… Deck 11.png"), else from the title. */
function deckNumber(entry) {
  const href = entry?.images?.[0]?.href ?? "";
  const file = decodeURIComponent(href.split("/").pop() ?? "");
  const fromFile = file.match(/Deck[ _-]*(\d+)/i);
  if (fromFile) return Number(fromFile[1]);
  const fromName = String(entry?.name ?? "").match(/Deck[ _-]*(\d+)/i);
  return fromName ? Number(fromName[1]) : null;
}

/** The <li> items, tags and entities stripped. */
function listItems(html) {
  return [...String(html ?? "").matchAll(/<li>([\s\S]*?)<\/li>/gi)]
    .map((m) =>
      m[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&nbsp;| /g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

// A deck list mixes staterooms with restaurants, bars and lifts. Only entries
// naming a cabin type are kept — the same vocabulary cabin-match.ts matches on,
// so anything this admits is something the matcher can actually reason about.
const CABIN_WORDS =
  /(interior|inside|ocean ?view|sea ?view|balcon|veranda|terrace|suite|studio|haven|yacht club|villa|penthouse|stateroom|cabin)/i;

// Rooms that carry a cabin word but are not accommodation.
const NOT_A_CABIN =
  /(restaurant|lounge|bar\b|grill|sundeck|pool|spa|gym|concierge|lift|elevator|shop|boutique|club\b.*(kids|teens|mini|baby)|private elevators|butler)/i;

function cabinCategories(items) {
  const out = [];
  for (const raw of items) {
    const s = raw.replace(/\s*\(.*?\)\s*/g, " ").trim();
    if (!CABIN_WORDS.test(s)) continue;
    // "The Haven Restaurant" and "MSC Yacht Club Sundeck & Pool" both carry a
    // cabin word; the venue test drops them.
    if (NOT_A_CABIN.test(s) && !/\b(suite|stateroom|cabin|balcony|interior|studio)\b/i.test(s.replace(NOT_A_CABIN, ""))) continue;
    if (NOT_A_CABIN.test(s) && /(sundeck|restaurant|lounge|bar|pool|spa|gym|lift|elevator)/i.test(s)) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

const result = {};
for (const dir of ARCHIVE_DIRS) {
  const slug = dbSlug(dir);
  const path = join(ARCHIVE, dir, "ship.json");
  if (!existsSync(path)) {
    console.error(`  !! no ship.json for ${dir}`);
    continue;
  }
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const ship = doc.ship ?? doc; // /api/ships/<slug>.json has no wrapper
  const decks = {};
  for (const entry of ship.deckplans ?? []) {
    const deck = deckNumber(entry);
    if (deck == null) continue;
    const cats = cabinCategories(listItems(entry.description));
    if (cats.length) decks[deck] = cats;
  }
  result[slug] = { ship: ship.title ?? slug, decks };
  const n = Object.values(decks).reduce((a, c) => a + c.length, 0);
  console.log(`${slug.padEnd(20)} ${Object.keys(decks).length} decks, ${n} category mentions`);
}

const out = join(import.meta.dirname, "context", "deck-legends.json");
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`\nwrote ${out}`);
