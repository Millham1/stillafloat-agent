// load-named-view.mjs — lift the cabin numbers our own research already names out of its
// prose and onto the rooms themselves.
//
// The 478 obstruction zones are applied as "deck 6, all sections, both sides". But 138 of them
// name exact rooms in their text — "cabins 5107–5131 starboard", "E101-E109", "8564" — and
// that precision was never used. This writes it.
//
// TWO THINGS THIS DOES NOT DO, both learned the hard way on 2026-08-19:
//
//  1. It does not regex the numbers out. Roughly a third of the zones name cabins that are
//     CLEAR — "named by Poesia's own deck-plan notes as THE EXCEPTION to the Deck 8 lifeboat
//     obstruction", "if you want to AVOID the overhang, choose cabin 9012". A regex would have
//     marked those as blocked, which is the opposite of the truth. Polarity is set by hand,
//     one zone at a time, in data/named-view-cabins.json with the quote that decided it.
//
//  2. It does not invent a room. Every number is expanded and then intersected with the real
//     grid; a cabin that does not exist is reported and skipped, never created.
//
// Usage (on a box, so the service key stays there):
//   scp data/named-view-cabins.json load-named-view.mjs saf-dev:/root/saf-full/server/
//   ssh saf-dev 'cd /root/saf-full/server && set -a && . /opt/stillafloat/shared.env && set +a \
//                && node load-named-view.mjs [--write]'
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
const { entries } = JSON.parse(fs.readFileSync("named-view-cabins.json", "utf8"));

/** "9147".."9161" -> every number in between at the endpoints' own step; letters kept. */
function expand([from, to]) {
  const m1 = String(from).match(/^([A-Za-z]*)(\d+)$/), m2 = String(to).match(/^([A-Za-z]*)(\d+)$/);
  if (!m1 || !m2 || m1[1] !== m2[1]) return [from, to];
  const prefix = m1[1];
  let a = Number(m1[2]), b = Number(m2[2]);
  if (a > b) [a, b] = [b, a];
  // endpoints of the same parity mean the run is one side of the corridor; step 2 keeps it
  // there. Mismatched parity means a continuous run, so step 1. Either way the grid decides.
  const step = (a % 2) === (b % 2) ? 2 : 1;
  const out = [];
  for (let n = a; n <= b; n += step) out.push(prefix + String(n).padStart(m1[2].length, "0"));
  return out;
}

const { data: fleet } = await sb.from("cabin_ships").select("slug,derived_from").eq("in_fleet", true);
const family = new Map();
for (const s of fleet) {
  const rep = s.derived_from || s.slug;
  family.set(rep, [...(family.get(rep) ?? []), s.slug]);
}

let wroteBlocked = 0, wroteClear = 0, notInGrid = [];
for (const e of entries) {
  const ships = family.get(e.rep) ?? [e.rep];
  const wanted = [...(e.cabins ?? []), ...(e.ranges ?? []).flatMap(expand)];
  const { data: real } = await sb.from("cabins").select("cabin_num")
    .in("ship_slug", ships).eq("deck", e.deck).in("cabin_num", wanted);
  const present = [...new Set((real ?? []).map((r) => r.cabin_num))];
  const missing = wanted.filter((n) => !present.includes(n));
  if (missing.length) notInGrid.push(`${e.rep} deck ${e.deck}: ${missing.length} of ${wanted.length} not in the grid (${missing.slice(0, 6).join(" ")}${missing.length > 6 ? " …" : ""})`);
  if (!present.length || !WRITE) continue;

  const source = `named in our own research (${e.kind}) — "${e.quote}"`;
  for (let i = 0; i < present.length; i += 100) {
    const slice = present.slice(i, i + 100);
    const patch = e.polarity === "blocked"
      ? { view_blocked: e.kind, view_blocked_source: source }
      // a room the research names as the exception must not inherit the area rule
      : { view_blocked: null, view_blocked_source: `clear — ${source}` };
    const { data, error } = await sb.from("cabins").update(patch)
      .in("ship_slug", ships).eq("deck", e.deck).in("cabin_num", slice).select("id");
    if (error) { console.error(`${e.rep} deck ${e.deck}: ${error.message}`); continue; }
    if (e.polarity === "blocked") wroteBlocked += data.length; else wroteClear += data.length;
  }
}
console.log(`${entries.length} reviewed zones across ${new Set(entries.map((e) => e.rep)).size} hulls`);
console.log(WRITE
  ? `rooms marked blocked by name: ${wroteBlocked}\nrooms marked clear by name : ${wroteClear}`
  : "(dry run — pass --write to apply)");
if (notInGrid.length) {
  console.log(`\nnumbers in the research that are not in the grid — worth a look, not written:`);
  for (const n of notInGrid) console.log("  " + n);
}
