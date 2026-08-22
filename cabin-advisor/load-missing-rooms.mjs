// load-missing-rooms.mjs — add rooms that are on the operator's own deck plan and absent from
// our grid.
//
// Mark's rule, 2026-08-19: the operator's own deck plan wins. The fleet-wide comparison found
// 198 such rooms across 16 hulls; this loads the ones whose CATEGORY could be measured rather
// than guessed — from the printed legend on Carnival's own PDF, where every category code has
// its own colour chip.
//
// What each field is standing on:
//   cabin_num   the operator's plan, read at 8x. The read is only trusted when the number of
//               rooms it finds matches the plan's own count for that deck.
//   category    measured against that ship's own legend chip. Never the empirical colour table,
//               which runs 53-75% on these hulls because several codes share one category.
//   pos_*       the plan's coordinates, registered onto the grid frame with the same fit the
//               noise pass uses (r2 >= 0.99 along the hull, or the room is not written).
//
// Usage (on a box, so the service key stays there):
//   scp noise/insert_rooms.json load-missing-rooms.mjs saf-dev:/root/saf-full/server/
//   ssh saf-dev 'cd /root/saf-full/server && set -a && . /opt/stillafloat/shared.env && set +a \
//                && node load-missing-rooms.mjs [--write]'
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import fs from "fs";

const WRITE = process.argv.includes("--write");
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error("SUPABASE_URL + SUPABASE_SERVICE_KEY required"); process.exit(1); }
if (url.includes("gbjfrnrkkjnutmogdzln") && process.env.ALLOW_PROD !== "1") {
  console.error("PROD project detected and ALLOW_PROD!=1 — aborting."); process.exit(1);
}
const sb = createClient(url, key, { realtime: { transport: ws }, auth: { persistSession: false } });
const rows = JSON.parse(fs.readFileSync("insert_rooms.json", "utf8"));

const byShip = new Map();
for (const r of rows) byShip.set(r.ship, [...(byShip.get(r.ship) ?? []), r]);

let inserted = 0, alreadyThere = 0;
for (const [ship, list] of byShip) {
  const decks = [...new Set(list.map((r) => r.deck))];
  const { data: existing, error: ee } = await sb.from("cabins")
    .select("cabin_num,deck").eq("ship_slug", ship).in("deck", decks);
  if (ee) { console.error(`${ship}: ${ee.message}`); continue; }
  const have = new Set(existing.map((r) => `${r.deck}|${r.cabin_num}`));

  // A room already in the grid is left exactly as it is — this only ADDS what is absent.
  const fresh = list.filter((r) => !have.has(`${r.deck}|${r.cabin_num}`));
  alreadyThere += list.length - fresh.length;
  const payload = fresh.map((r) => ({
    ship_slug: ship, cabin_num: r.cabin_num, deck: r.deck, category: r.category,
    pos_along: r.pos_along, pos_across: r.pos_across,
    section: r.pos_along < 0.34 ? "forward" : r.pos_along > 0.67 ? "aft" : "midship",
    side: r.pos_across < 0.5 ? "port" : "starboard",
    obstructed: false,
    category_source: r.source,
  }));
  console.log(`${ship}: ${list.length} on the plan, ${fresh.length} to add` +
              (list.length - fresh.length ? `, ${list.length - fresh.length} already present` : ""));
  if (!WRITE || !payload.length) continue;
  for (let i = 0; i < payload.length; i += 100) {
    const { error } = await sb.from("cabins").insert(payload.slice(i, i + 100));
    if (error) { console.error(`  insert: ${error.message}`); continue; }
    inserted += payload.slice(i, i + 100).length;
  }
}
console.log(WRITE
  ? `\ninserted ${inserted} rooms${alreadyThere ? `, ${alreadyThere} were already in the grid` : ""}`
  : "\n(dry run — pass --write to apply)");
