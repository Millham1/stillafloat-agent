import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import fs from "fs";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime:{transport:ws}, auth:{persistSession:false} });
const OUT = process.env.HOME + "/saf-repos/.wt-geometry/cabin-advisor/geometry/out";
const strip = n => { const m=String(n).match(/^([0-9A-Za-z]+?)[^0-9A-Za-z]+$/); return m?m[1]:String(n); };

const MAP = { "carnival-conquest":"carnival-conquest-4","carnival-spirit":"carnival-spirit-master-combo",
  "carnival-splendor":"carnival-splendor-master","carnival-sunshine":"carnival-sunshine-1","norwegian-luna":"norwegian-luna-ship" };
const SHIPS = ["carnival-conquest","carnival-dream","carnival-elation","carnival-spirit","carnival-splendor",
  "carnival-sunshine","carnival-vista","mardi-gras","norwegian-breakaway","norwegian-dawn","norwegian-epic",
  "norwegian-escape","norwegian-jewel","norwegian-prima","norwegian-sky","norwegian-spirit","pride-of-america",
  "norwegian-aqua","norwegian-luna","msc-world-america","msc-world-asia","msc-world-atlantic"];

console.log("slug                  total  with_xy   xy%   ship_row_total");
const geomCache = {};
for (const slug of SHIPS) {
  const { count: total } = await sb.from("cabins").select("*",{count:"exact",head:true}).eq("ship_slug",slug);
  const { count: withXy } = await sb.from("cabins").select("*",{count:"exact",head:true}).eq("ship_slug",slug).not("x","is",null);
  const { data: srow } = await sb.from("cabin_ships").select("total_cabins,deck_count,decks").eq("slug",slug).single();
  console.log(slug.padEnd(22), String(total).padStart(5), String(withXy).padStart(7),
    (100*withXy/total).toFixed(1).padStart(6), String(srow.total_cabins).padStart(8), srow.total_cabins===total?"":"  MISMATCH");
}

// spot-check: 5 random x/y-set cabins per line vs geometry JSON
const LINES = { Carnival:["carnival-conquest","carnival-vista","mardi-gras","carnival-spirit","carnival-dream"],
  NCL:["norwegian-epic","norwegian-prima","norwegian-aqua","norwegian-luna","pride-of-america"],
  MSC:["msc-world-america","msc-world-asia","msc-world-atlantic","msc-world-america","msc-world-atlantic"] };
console.log("\nSPOT CHECKS (db x/y/fill vs geometry json):");
let pass=0, fail=0;
for (const [line, slugs] of Object.entries(LINES)) {
  for (const slug of slugs) {
    const gslug = MAP[slug] || slug;
    geomCache[gslug] ??= JSON.parse(fs.readFileSync(`${OUT}/${gslug}.json`));
    // random cabin with x set
    const { data: rows } = await sb.from("cabins").select("cabin_num,deck,x,y,fill").eq("ship_slug",slug).not("x","is",null).limit(2000);
    const r = rows[Math.floor(Math.random()*rows.length)];
    // find in geometry (first occurrence, spirit combo = first run)
    let g=null, seen=new Set(), skipDup = gslug==="carnival-spirit-master-combo";
    outer: for (const dk of geomCache[gslug].decks) {
      if (skipDup) { if (seen.has(dk.deck)) continue; seen.add(dk.deck); }
      for (const c of dk.cabins) if (strip(c.num)===r.cabin_num) { g={...c, deck:dk.deck}; break outer; }
    }
    const ok = g && Math.abs(g.x-r.x)<1e-9 && Math.abs(g.y-r.y)<1e-9 && (r.fill===g.color || r.fill!=null);
    const fillOk = g && (r.fill===g.color);
    ok?pass++:fail++;
    console.log(`${line.padEnd(8)} ${slug.padEnd(20)} cabin ${String(r.cabin_num).padEnd(7)} db(x=${r.x},y=${r.y},fill=${r.fill}) geom(x=${g?.x},y=${g?.y},color=${g?.color}) ${ok?"OK":"FAIL"}${ok&&!fillOk?" (fill pre-existing, preserved)":""}`);
  }
}
console.log(`spot-checks: ${pass} pass, ${fail} fail`);

// confirm category/section/side untouched on a known matched row + moat cols intact
const { data: probe } = await sb.from("cabins").select("cabin_num,category,section,side,x,y,fill").eq("ship_slug","carnival-conquest").eq("cabin_num","6452").single();
console.log("\nconquest 6452 (had category/section/side):", JSON.stringify(probe));
const { count: moat } = await sb.from("cabins").select("*",{count:"exact",head:true}).not("view","is",null);
console.log("rows with moat 'view' set (should be unchanged):", moat);
process.exit(0);
