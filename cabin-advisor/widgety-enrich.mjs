// widgety-enrich.mjs — overlay the authoritative Widgety booking feed onto cabin_ships.
// Fills widgety_cabin_count / widgety_deck_count / widgety_grades for every ship in
// cabin_ships that Widgety covers (currently MSC + Royal Caribbean on the trial key).
// Widgety gives authoritative categories/counts/sizes but NOT per-cabin numbers, so
// this validates + enriches the DeckMaps grid, it does not replace it.
//
// Usage: WIDGETY_APP_ID=.. WIDGETY_TOKEN=.. SUPABASE_URL=.. SUPABASE_SERVICE_KEY=.. \
//        node widgety-enrich.mjs
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const APP = process.env.WIDGETY_APP_ID, TOK = process.env.WIDGETY_TOKEN;
if (!APP || !TOK) { console.error("WIDGETY_APP_ID and WIDGETY_TOKEN required"); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws }, auth: { persistSession: false } });

// Widgety uses a "-ship" suffix for the older MSC hulls; our slugs don't.
const SLUGFIX = { "msc-fantasia": "msc-fantasia-ship", "msc-poesia": "msc-poesia-ship", "msc-sinfonia": "msc-sinfonia-ship" };

const { data: ships, error: se } = await sb.from("cabin_ships").select("slug,line");
if (se) { console.error("select error", se); process.exit(1); }

for (const { slug, line } of ships) {
  // Widgety trial covers MSC + Royal Caribbean only
  if (!/royal caribbean|msc/i.test(line || "")) { console.log(`${slug}: skip (line not on Widgety trial)`); continue; }
  const wslug = SLUGFIX[slug] || slug;
  let res;
  try {
    res = await fetch(`https://www.widgety.co.uk/api/ships/${wslug}.json?app_id=${APP}&token=${TOK}`);
  } catch (e) { console.log(`${slug}: fetch error`); continue; }
  if (!res.ok) { console.log(`${slug}: widgety HTTP ${res.status} (tried ${wslug})`); continue; }
  const d = await res.json();
  const s = d.ship || d;
  const sf = s.ship_facts || {};
  const grades = (s.accomodation_types || []).map((a) => {
    const st = a.accom_stats || {};
    return { name: a.name, codes: a.grade_codes, type: st.type,
             min_size: st.min_size, max_size: st.max_size,
             min_occ: st.min_occupancy, max_occ: st.max_occupancy,
             accessible: a.accessible_cabin };
  });
  const { error } = await sb.from("cabin_ships").update({
    widgety_cabin_count: sf.cabin_count, widgety_deck_count: sf.deck_count,
    widgety_grades: grades, widgety_checked_at: new Date().toISOString(),
  }).eq("slug", slug);
  console.log(`${slug}: ${error ? "ERR " + error.message : `ok — widgety_cabins=${sf.cabin_count}, grades=${grades.length}`}`);
}
process.exit(0);
