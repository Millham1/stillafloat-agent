// load-noise.mjs — write the per-cabin noise neighbourhood (cabins.noise_nearby /
// cabins.noise_source) and tick deck_read_log, from the payload noise-features.py produced.
//
// Runs ON a box so the service key never has to be copied to the Mac:
//   scp noise/apply.json load-noise.mjs saf-dev:/root/saf-full/server/
//   ssh saf-dev 'cd /root/saf-full/server && set -a && . /opt/stillafloat/shared.env && set +a \
//                && node load-noise.mjs apply.json --write'
//
// Every room number in the payload came out of the database itself — the vision read only
// located the noise source, it never read a room number — so each update targets a row that
// already exists. Derived sister ships inherit their class rep's rows, exactly as the grid does.
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import fs from "fs";

const file = process.argv[2];
const WRITE = process.argv.includes("--write");
if (!file) { console.error("usage: node load-noise.mjs <apply.json> [--write]"); process.exit(1); }
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error("SUPABASE_URL + SUPABASE_SERVICE_KEY required"); process.exit(1); }
if (url.includes("gbjfrnrkkjnutmogdzln") && process.env.ALLOW_PROD !== "1") {
  console.error("PROD project detected and ALLOW_PROD!=1 — aborting."); process.exit(1);
}
const sb = createClient(url, key, { realtime: { transport: ws }, auth: { persistSession: false } });
const { rooms, decks } = JSON.parse(fs.readFileSync(file, "utf8"));
console.log(`target ${url}  mode ${WRITE ? "dry-run OFF (WRITE)" : "dry-run"}  ${rooms.length} rooms, ${decks.length} decks`);

// class rep -> itself plus every sister that inherits its grid
const { data: ships, error: se } = await sb.from("cabin_ships")
  .select("slug,derived_from").eq("in_fleet", true);
if (se) { console.error(se.message); process.exit(1); }
const family = new Map();
for (const s of ships) {
  const rep = s.derived_from || s.slug;
  if (!family.has(rep)) family.set(rep, []);
  family.get(rep).push(s.slug);
}

const byRep = new Map();
for (const [rep, deck, cabin, what, kind] of rooms) {
  if (!byRep.has(rep)) byRep.set(rep, []);
  byRep.get(rep).push({ deck, cabin, what, kind });
}

// One update per room would be ~15,000 round trips for a full fleet load. Rooms overwhelmingly
// share their wording — most of a deck hears the same lift lobby — so group by
// (deck, text, kind) and update each group in one call, chunked so the URL stays sane.
const CHUNK = 100;

// A re-read must be able to REMOVE a room as well as add one. Writing only the new rows would
// leave yesterday's rooms behind wherever the rule got tighter, and a stale room is worse than
// a missing one — it tells a guest their cabin is beside the lifts when the corrected rule
// says it isn't. So every deck being written is cleared first, in one pass.
const decksTouched = new Set(decks.map(([rep, deck]) => `${rep}|${deck}`));
for (const [rep, deck] of rooms) decksTouched.add(`${rep}|${deck}`);
if (WRITE) {
  for (const key of decksTouched) {
    const [rep, deck] = key.split("|");
    const fleet = family.get(rep) || [rep];
    const { error } = await sb.from("cabins")
      .update({ noise_nearby: null, noise_kind: null, noise_source: null })
      .in("ship_slug", fleet).eq("deck", Number(deck)).not("noise_nearby", "is", null);
    if (error) console.error(`clear ${rep} deck ${deck}: ${error.message}`);
  }
  console.log(`cleared ${decksTouched.size} rep-decks before rewriting`);
}

let touched = 0, missing = 0;
for (const [rep, list] of byRep) {
  const fleet = family.get(rep) || [rep];
  const groups = new Map();
  for (const { deck, cabin, what, kind } of list) {
    const key = `${deck}\u0000${what}\u0000${kind}`;
    if (!groups.has(key)) groups.set(key, { deck, what, kind, cabins: [] });
    groups.get(key).cabins.push(cabin);
  }
  let n = 0;
  for (const { deck, what, kind, cabins } of groups.values()) {
    if (!WRITE) continue;
    for (let i = 0; i < cabins.length; i += CHUNK) {
      const slice = cabins.slice(i, i + CHUNK);
      const { data, error } = await sb.from("cabins")
        .update({ noise_nearby: what, noise_kind: kind,
                  noise_source: `${rep} class deck plan — deck ${deck}` })
        .in("ship_slug", fleet).eq("deck", deck).in("cabin_num", slice).select("id");
      if (error) { console.error(`${rep} deck ${deck}: ${error.message}`); continue; }
      // every room here came out of the grid, so a shortfall means the fleet mapping is wrong
      missing += slice.length * fleet.length - data.length;
      touched += data.length; n += data.length;
    }
  }
  console.log(`${rep}: ${list.length} rooms in ${groups.size} groups x ${fleet.length} ships -> ${n} cabin rows`);
}

for (const [rep, deck, source, lifts, roomsFlagged, note] of decks) {
  if (!WRITE) continue;
  const { error } = await sb.from("deck_read_log")
    .update({ status: "read", read_at: new Date().toISOString(), source,
              lifts_found: lifts, rooms_flagged: roomsFlagged, notes: note })
    .eq("rep_slug", rep).eq("deck", deck);
  if (error) console.error(`deck_read_log ${rep}/${deck}: ${error.message}`);
}
console.log(`cabins updated: ${touched}${missing ? `, ${missing} rep rooms matched no row` : ""}`);
