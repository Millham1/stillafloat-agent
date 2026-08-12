// widgety-harvest.mjs — one-time capture of durable Widgety content into an ISOLATED
// `widgety` schema (kept out of the working public tables; merge later if it pans out).
// Static content (ship descriptions, dining, entertainment, cabin grades, deckplans,
// images) doesn't go stale, so a single capture during a paid month = permanent value.
// Also grabs an INDICATIVE sample of upcoming sailings + headline "from" prices per ship
// (volatile — treat as a teaser, not a quote).
//
// Usage: WIDGETY_APP_ID=.. WIDGETY_TOKEN=.. SUPABASE_URL=.. SUPABASE_SERVICE_KEY=.. \
//        [SAILINGS_SAMPLE=10] node widgety-harvest.mjs
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const APP = process.env.WIDGETY_APP_ID, TOK = process.env.WIDGETY_TOKEN;
if (!APP || !TOK) { console.error("WIDGETY_APP_ID + WIDGETY_TOKEN required"); process.exit(1); }
const SAMPLE = Number(process.env.SAILINGS_SAMPLE || 10); // per ship; set high (e.g. 9999) to grab all
const Q = `app_id=${APP}&token=${TOK}`;
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
  { db: { schema: "widgety" }, realtime: { transport: ws }, auth: { persistSession: false } });

async function getj(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url.split("?")[0]} ${r.status}`); return r.json(); }
const nights = (a, b) => (a && b) ? Math.round((new Date(b) - new Date(a)) / 86400000) : null;

// 1) list every ship the key can see (paginated)
const ships = [];
for (let page = 1; page <= 12; page++) {
  const d = await getj(`https://www.widgety.co.uk/api/ships.json?page=${page}&${Q}`);
  const arr = d.ships || [];
  ships.push(...arr);
  if (arr.length < 25) break;
}
console.log(`ships listed: ${ships.length}`);

let okShips = 0, okSail = 0;
for (const sh of ships) {
  const m = (sh.href || "").match(/ships\/([^.]+)\.json/);
  if (!m) continue;
  const slug = m[1];
  let s;
  try { const d = await getj(`https://www.widgety.co.uk/api/ships/${slug}.json?${Q}`); s = d.ship || d; }
  catch (e) { console.log(`${slug}: ship fetch ${e.message}`); continue; }

  const { error: se } = await sb.from("ships").upsert({
    slug, title: s.title, operator: (s.operator || {}).name, ship_class: s.ship_class,
    imo: s.imo, size: s.size, style: s.style, ship_type: s.ship_type,
    raw: s, captured_at: new Date().toISOString(),
  });
  if (se) { console.log(`${slug}: ships upsert ERR ${se.message}`); continue; }
  okShips++;

  let n = 0;
  for (const c of (s.cruises || [])) {
    if (n >= SAMPLE) break;
    try {
      const hd = await getj(`https://www.widgety.co.uk/api/holidays/dates/${c.ref}.json?${Q}`);
      const { error } = await sb.from("sailings").upsert({
        date_ref: hd.date_ref || c.ref, ship_slug: slug, ship_title: hd.ship_title || s.title,
        operator: hd.operator_title, date_from: hd.date_from, date_to: hd.date_to,
        nights: nights(hd.date_from, hd.date_to), regions: hd.regions, countries: hd.countries,
        themes: hd.themes, availability: hd.availability_string, headline_prices: hd.headline_prices,
        captured_at: new Date().toISOString(),
      });
      if (!error) { n++; okSail++; }
    } catch (e) { /* skip a bad sailing, keep going */ }
  }
  console.log(`${slug}: content ok, ${n} sailings`);
}
console.log(`DONE — ${okShips} ships, ${okSail} sailings captured`);
process.exit(0);
