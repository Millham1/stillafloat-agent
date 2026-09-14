#!/usr/bin/env node
// sister-categories.mjs — name a new hull's blank cabin categories from its sister ship.
//
// WHY. A hull that comes in through the geometry vision read (Norwegian Aura, 2026-09-14)
// carries a colour per cabin but no category, and the loader's line-wide colour table only
// names the colours it is sure of: Aura arrived with 1,204 of 1,949 rooms named and no
// Inside or Studio at all, so the advisor could not offer a solo traveller a Studio on a
// ship that has them. The sister (Norwegian Aqua, same Prima Plus class, same operator plan
// set, same vision colour vocabulary) knows what those colours mean.
//
// THREE WAYS A GROUP CAN BE NAMED, tried in order. The unit is a (deck, colour) group on
// the new ship, never a single cabin, and every path must also pass the LEGEND gate: the
// line's own per-deck category list (context/deck-legends.json, from the Widgety archive)
// has to offer a room of that kind on that deck.
//   A. SISTER BY NUMBER — the sister's same-numbered cabins on the same deck name the
//      group (backfill-categories.mjs thresholds: >=8 matched, >=90% agree).
//      On Aura the number join is clean on decks 5, 9, 13-16 and SHIFTED on 10-12 (her
//      stretched hull renumbers mid-ship: Aura balconies there join to Aqua insides), so
//      a split group is not "the colour means two things" — it is a bad join. Hence:
//   C. SISTER SAME DECK, SAME COLOUR — the sister's rooms of this colour on this deck
//      (>=8, >=95% one category). Colour is per deck because NCL paints deck-5 oceanviews
//      and deck-12/13 studios the same pink.
//   D. SISTER WHOLE-HULL COLOUR — the colour means one thing across the sister(s)
//      (>=40 rooms, >=95%), and no group on the new ship that path A already CONFIRMED
//      says otherwise. (Pink is blocked here on Aura: A confirmed deck-5 pink = Oceanview.)
//   C and D are also refused when the number join, where it reaches the group at all,
//      mostly disagrees with the colour (see numberContradicts).
// Which sisters? The number join uses the nearest sister only. The colour paths default
// to that same ship: Norwegian Luna's pink is known to mean balcony on deck 5 and studio
// on 12-13 (backfill-categories.mjs), so adding her split Aura's deck-12 studios.
// Anything else stays null. cabin-match reports that honestly, and "I don't know" costs
// less than the wrong room.
//
// Every row written carries category_source = 'sister:<path> (<why>)', so the whole pass
// undoes with:  update cabins set category=null, category_source=null
//                where ship_slug='<ship>' and category_source like 'sister:%';
//
// Usage (on a box, dev first):
//   node sister-categories.mjs --ship norwegian-aura --sister norwegian-aqua \
//        [--colour-sisters norwegian-aqua,norwegian-luna] [--write]
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : d; };
const WRITE = argv.includes("--write");
const SHIP = opt("--ship"), SISTER = opt("--sister");
const COLOUR_SISTERS = (opt("--colour-sisters", SISTER) || "").split(",").filter(Boolean);
if (!SHIP || !SISTER) { console.error("usage: node sister-categories.mjs --ship <slug> --sister <slug> [--colour-sisters a,b] [--write]"); process.exit(1); }

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY required"); process.exit(1); }
if (url.includes("gbjfrnrkkjnutmogdzln") && process.env.ALLOW_PROD !== "1") { console.error("PROD detected and ALLOW_PROD!=1 — aborting."); process.exit(1); }
const sb = createClient(url, key, { realtime: { transport: ws }, auth: { persistSession: false } });

// ── the same attribute vocabulary the matcher uses (backfill-categories.mjs / cabin-match.ts)
const ATTR_PATTERNS = [
  ["suite", /\b(suite|haven|yacht club|retreat|villa|penthouse|owner'?s)\b/i],
  ["balcony", /(balcon|veranda|terrace|infinite)/i],
  ["inside", /(interior|inside)/i],
  ["oceanview", /(ocean ?view|sea ?view|outside|window|porthole)/i],
];
const ATTR_ALIASES = { studio: ["inside"], aquaclass: ["balcony"], "grand terrace suite": ["suite", "balcony"] };
function attrsOf(category) {
  const c = String(category ?? "").trim();
  if (!c) return [];
  const alias = ATTR_ALIASES[c.toLowerCase()];
  if (alias) return [...alias].sort();
  return ATTR_PATTERNS.filter(([, re]) => re.test(c)).map(([t]) => t).sort();
}
// The legend allows a category when some room the line lists on that deck carries every
// attribute of it: "The Haven" (suite) is allowed by "The Haven Owner's Suite with Large
// Balcony" (balcony+suite). Exact matching would refuse every Haven room on every deck.
function legendAllows(legend, category) {
  const need = attrsOf(category);
  if (!need.length) return false;
  return legend.some((entry) => { const have = new Set(attrsOf(entry)); return need.every((a) => have.has(a)); });
}

const MIN_MATCHED = 8, MIN_PURITY = 0.90, MIN_ATTR_PURITY = 0.95, MIN_NAME_MAJORITY = 0.60; // path A (as backfill-categories)
const MIN_DECK_COLOUR = 8, MIN_DECK_PURITY = 0.95;   // path C
const MIN_HULL_COLOUR = 40, MIN_HULL_PURITY = 0.95;  // path D

async function fetchCabins(slug) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("cabins").select("id,cabin_num,deck,fill,category").eq("ship_slug", slug).order("id").range(from, from + 999);
    if (error) throw new Error(`${slug}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
const top = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

const legends = JSON.parse(readFileSync(join(HERE, "context", "deck-legends.json"), "utf8"));
const shipLegend = legends[SHIP]?.decks ?? {};
if (!Object.keys(shipLegend).length) { console.error(`no deck legend for ${SHIP} in context/deck-legends.json — run extract-deck-legends.mjs`); process.exit(1); }

const ship = await fetchCabins(SHIP);
const sister = await fetchCabins(SISTER);
const colourSisters = [];
for (const s of COLOUR_SISTERS) colourSisters.push(...(s === SISTER ? sister : await fetchCabins(s)));
console.log(`${SHIP}: ${ship.length} cabins, ${ship.filter((c) => !c.category).length} blank; sister ${SISTER}: ${sister.length}; colour sisters ${COLOUR_SISTERS.join(",")}: ${colourSisters.length}`);

const sisterByNum = new Map(sister.map((c) => [`${c.deck}|${c.cabin_num}`, c.category]));
// colour tables from the sisters: per deck and whole hull
const deckColour = new Map(), hullColour = new Map();
for (const c of colourSisters) {
  if (!c.fill || !c.category) continue;
  const k = `${c.deck}|${c.fill}`;
  deckColour.set(k, deckColour.get(k) ?? {}); deckColour.get(k)[c.category] = (deckColour.get(k)[c.category] ?? 0) + 1;
  hullColour.set(c.fill, hullColour.get(c.fill) ?? {}); hullColour.get(c.fill)[c.category] = (hullColour.get(c.fill)[c.category] ?? 0) + 1;
}

// groups on the new ship
const groups = new Map();
for (const c of ship) {
  const k = `${c.deck}|${c.fill ?? "(null)"}`;
  const g = groups.get(k) ?? { deck: c.deck, fill: c.fill, n: 0, blank: 0, sisterCounts: {}, matched: 0, ids: [] };
  g.n += 1;
  if (!c.category) { g.blank += 1; g.ids.push(c.id); }
  const sc = sisterByNum.get(`${c.deck}|${c.cabin_num}`);
  if (sc) { g.matched += 1; g.sisterCounts[sc] = (g.sisterCounts[sc] ?? 0) + 1; }
  groups.set(k, g);
}

// pass 1: path A on every group (blank or not) — the confirmations feed path D's contradiction check
const confirmedByFill = new Map(); // fill -> Set(category) confirmed by A on this ship
function pathA(g) {
  if (g.matched < MIN_MATCHED) return null;
  const [cat, n] = top(g.sisterCounts);
  const purity = n / g.matched;
  const modalAttr = attrsOf(cat).join("+");
  const attrHits = Object.entries(g.sisterCounts).filter(([c]) => attrsOf(c).join("+") === modalAttr).reduce((a, [, x]) => a + x, 0);
  const attrPurity = attrHits / g.matched;
  if (purity < MIN_PURITY && attrPurity < MIN_ATTR_PURITY) return { skip: `sister split by number (${(purity * 100).toFixed(0)}% "${cat}", ${(attrPurity * 100).toFixed(0)}% same kind)` };
  if (purity < MIN_NAME_MAJORITY) return { skip: `no majority name (${n}/${g.matched})` };
  return { category: cat, basis: "sister-by-number", why: `${n}/${g.matched} same-numbered ${SISTER} cabins on deck ${g.deck}` };
}
for (const g of groups.values()) { const a = pathA(g); if (a?.category && g.fill) (confirmedByFill.get(g.fill) ?? confirmedByFill.set(g.fill, new Set()).get(g.fill)).add(a.category); }

// A colour verdict must not be contradicted by the number join: when five or more
// same-numbered sister cabins exist and fewer than half are the kind of room the
// colour proposes, the group stays null (Aura deck 10 "cyan": Luna's deck-10 cyan is
// 23/23 Balcony, but all five same-numbered Aqua rooms are Inside).
const MIN_CONTRA_MATCHED = 5;
function numberContradicts(g, cat) {
  if (g.matched < MIN_CONTRA_MATCHED) return null;
  const kind = attrsOf(cat).join("+");
  const agree = Object.entries(g.sisterCounts).filter(([c]) => attrsOf(c).join("+") === kind).reduce((a, [, n]) => a + n, 0);
  return agree / g.matched < 0.5 ? `${g.matched - agree}/${g.matched} same-numbered sister cabins are not ${cat}` : null;
}

function decide(g) {
  const legend = shipLegend[String(g.deck)] ?? [];
  const gate = (cat, basis, why) => {
    if (!legendAllows(legend, cat)) return { skip: `"${cat}" (${basis}) is not a kind of room the line lists on deck ${g.deck}` };
    const contra = basis !== "sister-by-number" ? numberContradicts(g, cat) : null;
    if (contra) return { skip: `${basis} says ${cat} but ${contra}` };
    return { category: cat, basis, why };
  };
  const a = pathA(g);
  if (a?.category) return gate(a.category, a.basis, a.why);
  const reasons = [a?.skip ?? `only ${g.matched} same-numbered sister cabins`];
  if (!g.fill) return { skip: reasons.concat("no colour read").join("; ") };
  const dc = deckColour.get(`${g.deck}|${g.fill}`);
  if (dc) {
    const [cat, n] = top(dc), tot = sum(dc);
    if (tot >= MIN_DECK_COLOUR && n / tot >= MIN_DECK_PURITY) return gate(cat, "sister-deck-colour", `${n}/${tot} "${g.fill}" cabins on the sisters' deck ${g.deck} are ${cat}`);
    reasons.push(`sisters' deck-${g.deck} "${g.fill}" is ${n}/${tot} "${cat}"`);
  } else reasons.push(`no "${g.fill}" on the sisters' deck ${g.deck}`);
  const hc = hullColour.get(g.fill);
  if (hc) {
    const [cat, n] = top(hc), tot = sum(hc);
    const contra = [...(confirmedByFill.get(g.fill) ?? [])].filter((c) => c !== cat);
    if (tot >= MIN_HULL_COLOUR && n / tot >= MIN_HULL_PURITY && !contra.length) return gate(cat, "sister-hull-colour", `${n}/${tot} "${g.fill}" cabins across the sisters are ${cat}`);
    reasons.push(contra.length ? `"${g.fill}" already confirmed ${contra.join("/")} elsewhere on ${SHIP}` : `sisters' "${g.fill}" is ${n}/${tot} "${cat}"`);
  } else reasons.push(`"${g.fill}" unseen on the sisters`);
  return { skip: reasons.join("; ") };
}

const decisions = [];
let toSet = 0, left = 0;
for (const g of [...groups.values()].sort((x, y) => x.deck - y.deck || String(x.fill).localeCompare(String(y.fill)))) {
  if (!g.blank) continue;
  const d = decide(g);
  decisions.push({ ...g, ids: undefined, ...d });
  if (d.category) toSet += g.blank; else left += g.blank;
  const tag = d.category ? `SET ${d.category.padEnd(10)} [${d.basis}]` : "null";
  console.log(`deck ${String(g.deck).padStart(2)} ${String(g.fill).padEnd(11)} ${String(g.blank).padStart(4)} blank  ${tag}  — ${d.category ? d.why : d.skip}`);
}
console.log(`\n${WRITE ? "writing" : "would write"} ${toSet} rooms; ${left} stay null`);

if (WRITE) {
  let written = 0;
  for (const d of decisions) {
    if (!d.category) continue;
    const g = groups.get(`${d.deck}|${d.fill ?? "(null)"}`);
    for (let i = 0; i < g.ids.length; i += 200) {
      const { error } = await sb.from("cabins").update({ category: d.category, category_source: `sister:${d.basis} (${d.why})` })
        .in("id", g.ids.slice(i, i + 200)).is("category", null);
      if (error) { console.error(`deck ${d.deck} ${d.fill}: ${error.message}`); continue; }
      written += g.ids.slice(i, i + 200).length;
    }
  }
  // keep cabin_ships in step, as load-geometry.mjs does
  const after = await fetchCabins(SHIP);
  const counts = {};
  for (const c of after) if (c.category) counts[c.category] = (counts[c.category] ?? 0) + 1;
  const uncat = after.filter((c) => !c.category).length;
  const { data: row } = await sb.from("cabin_ships").select("notes").eq("slug", SHIP).maybeSingle();
  const notes = { ...(row?.notes ?? {}), category: `Partial: loader colour table, then sister-categories.mjs from ${SISTER} (${new Date().toISOString().slice(0, 10)}); ${uncat} rooms still null.` };
  const { error: ue } = await sb.from("cabin_ships").update({ category_counts: counts, notes, updated_at: new Date().toISOString() }).eq("slug", SHIP);
  if (ue) console.error(`cabin_ships: ${ue.message}`);
  console.log(`wrote ${written} rooms; ${SHIP} now ${JSON.stringify(counts)}, ${uncat} null`);
}
