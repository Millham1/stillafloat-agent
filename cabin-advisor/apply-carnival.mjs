// apply-carnival.mjs — measured Carnival legend reads -> categories on the view-null rooms.
//
// Input: carnival/<slug>.rooms.json from carnival-categories.py — every room the ship's own
// PDF shows, with the legend code + category measured off that ship's printed legend.
//
// THE GARBLED-BLOCK RULE. Multi-code brand blocks (Cloud 9 Spa, Havana, Family Harbor) parse
// as one concatenated string ("Interior 6S Ocean View ... 8S Balcony SS Suite"), but the
// PER-ROOM CODE is measured cleanly and Carnival's code grammar names the type: leading digit
// 1-4 interior, 5-6 ocean view, 7-9 balcony, PT porthole (ocean view), letter pairs suites.
// A clean single-type legend line is written as printed; a garbled line resolves as
// brand + grammar(code); anything else is DECLINED and logged, never guessed.
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import fs from "fs";

const WRITE = process.argv.includes("--write");
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error("env missing"); process.exit(1); }
if (url.includes("gbjfrnrkkjnutmogdzln") && process.env.ALLOW_PROD !== "1") {
  console.error("PROD detected and ALLOW_PROD!=1 — aborting."); process.exit(1);
}
const sb = createClient(url, key, { realtime: { transport: ws }, auth: { persistSession: false } });

const TYPE_WORDS = ["interior", "ocean view", "balcony", "suite"];
const typesIn = (t) => TYPE_WORDS.filter((w) => t.toLowerCase().includes(w));
function grammarType(code) {
  if (/^PT/i.test(code)) return "Ocean View";
  if (/^[1-4]/.test(code)) return "Interior";
  if (/^[5-6]/.test(code)) return "Ocean View";
  if (/^[7-9]/.test(code)) return "Balcony";
  if (/^[A-Z]{2}$/i.test(code)) return "Suite";
  return null;
}
function brandOf(text) {
  const t = text.toLowerCase();
  if (t.includes("spa")) return "Cloud 9 Spa ";
  if (t.includes("havana")) return "Havana ";
  if (t.includes("family harbor")) return "Family Harbor ";
  return "";
}
function resolve(code, legendText) {
  const kinds = typesIn(legendText);
  if (kinds.length <= 1) return { cat: legendText, how: `legend line` };   // clean, as printed
  const t = grammarType(code);
  if (!t) return null;
  return { cat: brandOf(legendText) + t, how: `code grammar (${code}) within a multi-code legend block` };
}

const slugs = process.argv.filter((a) => a.startsWith("carnival-") || a === "mardi-gras");
let wrote = 0, declined = 0;
for (const slug of slugs) {
  let data;
  try { data = JSON.parse(fs.readFileSync(`carnival-rooms/${slug}.rooms.json`, "utf8")); }
  catch { console.log(`${slug}: no rooms.json`); continue; }
  for (const [deckS, rooms] of Object.entries(data)) {
    const deck = Number(deckS);
    const { data: grid, error } = await sb.from("cabins")
      .select("id,cabin_num,category,view").eq("ship_slug", slug).eq("deck", deck);
    if (error) { console.error(`${slug} ${deck}: ${error.message}`); continue; }
    const byNum = new Map(grid.map((r) => [r.cabin_num, r]));
    let applied = 0, skip = 0;
    for (const [num, v] of Object.entries(rooms)) {
      const g = byNum.get(num);
      if (!g || g.view !== null) continue;
      // Two kinds of target: a room with NO category, and a room stuck with a truncated
      // brand name ("Cloud 9 Spa", "Havana", "Family Harbor", "Spa") that names a brand but
      // not a type. The operator's own legend outranks the truncation — the same rule the
      // 118-room Dream/Splendor/Sunshine spa fix used on 2026-08-19.
      const truncated = ["cloud 9 spa", "havana", "family harbor", "spa"]
        .includes((g.category ?? "").toLowerCase());
      if (g.category !== null && !truncated) continue;
      const r = resolve(v.code, v.category);
      if (!r) { skip++; declined++; continue; }
      if (WRITE) {
        const { error: ue } = await sb.from("cabins").update({
          category: r.cat,
          category_source: `operator legend code ${v.code} (${r.how}), measured off Carnival's own deck-plan PDF at 8x`,
        }).eq("id", g.id);
        if (ue) { console.error(`  ${slug} ${num}: ${ue.message}`); continue; }
      }
      applied++; wrote++;
    }
    if (applied || skip) console.log(`${slug} deck ${deck}: ${applied} resolved${skip ? `, ${skip} declined (unknown code)` : ""}`);
  }
}
console.log(`\n${WRITE ? "wrote" : "would write"} ${wrote} rooms${declined ? `, declined ${declined}` : ""}`);
