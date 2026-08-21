// audit-vs-legend.mjs — find cabins we have labelled as something the LINE does not sell there.
//
// WHY. On 2026-08-18 Norwegian Prima's deck 5 was stored as Balcony/Club Balcony
// Suite. NCL's own deck plan lists deck 5 as ocean-view and inside only, and NCL
// publishes 5216/5218/5220/5816/5818/5820/5822 there as accessible OCEANVIEW —
// the exact rooms we were calling balconies. Norwegian Aqua then inherited the
// error by cabin-number cross-reference, which is why it showed zero ocean-view
// cabins on a ship that has 140.
//
// The lesson that produced this script: a reference ship being 100% POPULATED is
// not the same as 100% CORRECT, and cross-referencing a sister propagates the
// reference's mistakes silently. So check the grid against the operator's own
// per-deck category list (context/deck-legends.json, extract-deck-legends.mjs).
//
// A finding is a QUESTION, not a verdict — the line's list can itself be
// abbreviated. Confirm each one (position on the deck, published cabin numbers,
// a sister's plan) before changing data, exactly as the Prima fix was confirmed.
//
// Run on the dev box:
//   scp audit-vs-legend.mjs context/deck-legends.json saf-dev:/tmp/
//   ssh saf-dev 'cd /tmp && ln -sfn /root/saf-full/server/node_modules node_modules \
//     && set -a && . /opt/stillafloat/shared.env && set +a && node audit-vs-legend.mjs'

import { createClient } from "@supabase/supabase-js";
import ws from "ws"; if (!globalThis.WebSocket) globalThis.WebSocket = ws;
import fs from "fs";
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth:{persistSession:false} });
const legends = JSON.parse(fs.readFileSync(process.env.LEGENDS ?? "/tmp/deck-legends.json","utf8"));

const P=[["suite",/\b(suite|haven|yacht club|retreat|villa|penthouse|owner'?s)\b/i],
 ["balcony",/(balcon|veranda|terrace|infinite)/i],["inside",/(interior|inside)/i],
 ["oceanview",/(ocean ?view|sea ?view|outside|window|porthole)/i]];
const A=c=>{const s=String(c??"").trim(); if(!s) return []; if(s.toLowerCase()==="studio") return ["inside"];
 const o=[]; for(const[t,r]of P) if(r.test(s)) o.push(t); return o;};

let rows=[]; for(let f=0;;f+=1000){
  // ORDER BY is required: .range() without it drops and repeats rows (it cost the
  // test fixture 38% of the fleet on 2026-08-18), which here would silently shrink
  // the audit and hide mislabelled decks.
  const {data,error}=await db.from("cabins").select("ship_slug,deck,category").not("category","is",null)
    .order("ship_slug").order("cabin_num").range(f,f+999);
  if(error) throw new Error(error.message); rows.push(...data); if(data.length<1000) break; }
const grid={};
for(const r of rows){ (grid[r.ship_slug] ??= {})[r.deck] ??= new Set(); for(const a of A(r.category)) grid[r.ship_slug][r.deck].add(a); }

const findings=[];
for(const [slug,entry] of Object.entries(legends)){
  const g=grid[slug]; if(!g) continue;
  for(const [deck,cats] of Object.entries(entry.decks)){
    const allowed=new Set(cats.flatMap(A));
    if(!allowed.size) continue;
    const ours=g[deck]; if(!ours) continue;
    const extra=[...ours].filter(a=>!allowed.has(a));
    if(extra.length) findings.push({slug,deck:+deck,we_claim:extra,line_lists:[...allowed].sort()});
  }
}
findings.sort((a,b)=>a.slug.localeCompare(b.slug)||a.deck-b.deck);
console.log(`decks where our data claims a type the LINE does not list: ${findings.length}\n`);
for(const f of findings) console.log(`  ${f.slug.padEnd(22)} deck ${String(f.deck).padStart(2)}  we say: ${f.we_claim.join("+").padEnd(20)} line lists: ${f.line_lists.join(", ")}`);
