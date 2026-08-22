#!/usr/bin/env node
// Record what each LINE says it sells, so the concierge may finally speak in the
// negative — but only where that statement is complete enough to be trusted.
//
// Background. `selectCabins` used to read an absence in cabin_ships.category_counts
// as a fact about the ship. That column is built from our own grid extraction, so
// on 2026-08-18 it was denying ocean-view cabins on six Royal-class Princess hulls
// and Norwegian Aqua/Luna, and suites on nine Carnival and MSC ships. All of them
// sell exactly what we were denying. Absence now needs the operator's own word for
// it, held in cabin_ships.line_types (migration 0018).
//
// Input is context/deck-legends.json — the per-deck category list each line
// publishes, preserved in the Widgety archive (extract-deck-legends.mjs).
//
// THE GUARD THAT MATTERS. A legend that is missing a deck would manufacture a
// false absence: no ocean-view listed on the eleven decks we hold, when the
// twelfth deck is where they all are. So line_types is written ONLY when the
// legend covers every deck our grid actually holds cabins on. Everything else is
// left NULL, which the matcher reads as "we cannot say" — the safe direction.
//
// Usage:  node load-line-types.mjs            # report only
//         node load-line-types.mjs --sql out  # emit the UPDATEs

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attrsOf } from "./backfill-categories.mjs";

const legends = JSON.parse(
  readFileSync(join(import.meta.dirname, "context", "deck-legends.json"), "utf8"),
);

// { slug: [deck, ...] } — decks our grid holds cabins on. Dumped from the DB:
//   select ship_slug, array_agg(distinct deck order by deck)
//     from cabins where deck is not null group by 1;
const gridDecksPath = join(import.meta.dirname, "context", "grid-decks.json");
const gridDecks = JSON.parse(readFileSync(gridDecksPath, "utf8"));

const TYPES = ["inside", "oceanview", "balcony", "suite"];

const rows = [];
const skipped = [];
for (const [slug, entry] of Object.entries(legends)) {
  const mine = gridDecks[slug];
  if (!mine?.length) { skipped.push([slug, "not a fleet ship / no grid"]); continue; }

  const legendDecks = new Set(Object.keys(entry.decks).map(Number));
  const missing = mine.filter((d) => !legendDecks.has(d));
  if (missing.length) {
    // Cannot rule out that the unlisted decks hold the type we would be denying.
    skipped.push([slug, `legend missing deck(s) ${missing.join(",")} that our grid holds`]);
    continue;
  }

  const types = new Set();
  for (const cats of Object.values(entry.decks)) for (const c of cats) for (const a of attrsOf(c)) types.add(a);
  const list = TYPES.filter((t) => types.has(t));
  if (!list.length) { skipped.push([slug, "legend named no cabin categories at all"]); continue; }
  rows.push({ slug, types: list, absent: TYPES.filter((t) => !types.has(t)) });
}

rows.sort((a, b) => a.slug.localeCompare(b.slug));
console.log(`ships with a trustworthy legend: ${rows.length}`);
for (const r of rows) {
  console.log(`  ${r.slug.padEnd(24)} sells: ${r.types.join(", ").padEnd(34)}${r.absent.length ? `NOT: ${r.absent.join(", ")}` : ""}`);
}
console.log(`\nleft NULL (we must not claim absence): ${skipped.length}`);
for (const [slug, why] of skipped) console.log(`  ${slug.padEnd(24)} ${why}`);

const i = process.argv.indexOf("--sql");
if (i > -1) {
  const sql = rows.map(
    (r) => `update cabin_ships set line_types = array[${r.types.map((t) => `'${t}'`).join(",")}]::text[] where slug = '${r.slug}';`,
  );
  writeFileSync(process.argv[i + 1], sql.join("\n") + "\n");
  console.log(`\nwrote ${process.argv[i + 1]} (${sql.length} statements)`);
}
