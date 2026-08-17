// load-context.mjs — put the per-class obstruction research where the tool can reach it.
//
// Usage:  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node load-context.mjs [--dry]
//   reads context/*.json  (output of research-class-context.mjs)
//
// WHY THIS EXISTS (2026-08-17). research-class-context.mjs ran across the fleet on
// 2026-08-13/14 and wrote 41 hull-class files: 478 sourced obstruction zones and 330
// named-cabin leads. Nothing ever read them — no table, no loader, and generate-advice.mjs
// does not reference them. So the advice corpus, and therefore the whole "rooms I'd skip"
// feature, was produced without the obstruction facts it was supposed to be built on.
// This is the missing step, not new research. No API calls, no new spend.
//
// Apply supabase/migrations/0016_cabin_class_context.sql first. DEV before PROD.

import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DRY = process.argv.includes("--dry");
// --sql writes the whole load out as a .sql file instead of connecting. Useful
// when running somewhere without the service key (the key lives in the shared
// env on the boxes, not on the Mac) — the SQL is then applied through whatever
// channel already has access. SHIPS_JSON supplies cabin_ships so the class
// inheritance can still be resolved offline.
const SQL_OUT = process.argv.includes("--sql");
const OFFLINE = DRY || SQL_OUT;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.CONTEXT_DIR || path.join(HERE, "context");

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!OFFLINE && (!url || !key)) { console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required (or pass --dry / --sql)"); process.exit(1); }

// ── normalisation ────────────────────────────────────────────────────────────
// The grid uses both "fwd"/"forward" and "mid"/"midship"; the research writes
// long form. Collapse both sides to one vocabulary or the join silently misses.
const SECTION = { fwd: "forward", forward: "forward", mid: "mid", midship: "mid", middle: "mid", aft: "aft" };
const normSection = (s) => SECTION[String(s || "").trim().toLowerCase()] ?? null;
const normSide = (s) => {
  const v = String(s || "").trim().toLowerCase();
  return v.startsWith("p") ? "port" : v.startsWith("s") ? "starboard" : null;
};
// "Royal Caribbean" and "Royal Caribbean International" are the same company;
// class names are only unique WITHIN a line (Carnival and NCL both have "Spirit").
const normLine = (l) => String(l || "").toLowerCase()
  .replace(/\b(cruise line|cruises|cruise|international|line)\b/g, "").replace(/[^a-z]/g, "");

/** Pull cabin numbers out of the research's free-text lead field. */
function parseCabinNums(raw) {
  if (!raw) return [];
  // ranges like "6224-6238" are NOT expanded: cabin numbering skips and interleaves
  // sides, so expanding would invent cabins — the exact failure this work is fixing.
  return [...String(raw).matchAll(/\b([A-Z]?\d{3,5}[A-Z]?)\b/g)].map((m) => m[1]);
}

// ── read the research ────────────────────────────────────────────────────────
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
if (!files.length) { console.error(`no research files in ${dir}`); process.exit(1); }

const docs = files.map((f) => {
  const slug = f.replace(/\.json$/, "");
  return { slug, doc: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) };
});

if (!globalThis.WebSocket) globalThis.WebSocket = ws;   // Node < 22
const db = OFFLINE ? null : createClient(url, key, { auth: { persistSession: false } });

// ── resolve which ship uses which research ───────────────────────────────────
let ships = [];
if (OFFLINE) {
  const shipsFile = process.env.SHIPS_JSON;
  if (shipsFile && fs.existsSync(shipsFile)) {
    ships = JSON.parse(fs.readFileSync(shipsFile, "utf8"));
    console.log(`(offline — ${ships.length} ships read from ${path.basename(shipsFile)})\n`);
  } else {
    console.log("(offline — no SHIPS_JSON, so class inheritance is not resolved)\n");
  }
} else {
  const { data, error } = await db.from("cabin_ships").select("slug,ship,line,class");
  if (error) { console.error("could not read cabin_ships —", error.message); process.exit(1); }
  ships = data ?? [];
}

const repByKey = new Map();     // normalised line+class -> rep slug
const shipBySlug = new Map(ships.map((s) => [s.slug, s]));
for (const { slug } of docs) {
  const s = shipBySlug.get(slug);
  if (s) repByKey.set(`${normLine(s.line)}|${String(s.class || "").toLowerCase()}`, slug);
}

const assignments = [];
const orphans = [];
for (const s of ships) {
  const own = docs.find((d) => d.slug === s.slug);
  if (own) { assignments.push({ ship_slug: s.slug, rep_slug: s.slug, inherited: false, note: null }); continue; }
  const rep = repByKey.get(`${normLine(s.line)}|${String(s.class || "").toLowerCase()}`);
  if (rep) {
    assignments.push({
      ship_slug: s.slug, rep_slug: rep, inherited: true,
      note: `same hull class (${s.class}) as ${rep}; research applies to sisters`,
    });
  } else orphans.push(s);
}

// ── build the rows ───────────────────────────────────────────────────────────
const contextRows = [], zoneRows = [], leadRows = [];
let droppedZones = 0;

for (const { slug, doc } of docs) {
  contextRows.push({
    rep_slug: slug,
    class_label: doc.class ?? null,
    line: doc.line ?? null,
    ship_name: doc.ship ?? null,
    sister_ships: doc.sisterShips ?? [],
    total_cabins: doc.totalCabins ?? null,
    cabins_touched: doc.cabinsTouchedByAZone ?? null,
    model: doc.model ?? null,
    web_searches: doc.grounded?.webSearches ?? 0,
    cost_usd: doc.cost ?? null,
    unknowns: doc.unknowns ?? [],
    researched_on: "2026-08-14",
  });

  for (const z of doc.zones ?? []) {
    // A zone with no source is not evidence. The research was told to emit one
    // per zone and did (478/478) — this guard is here so a future run that
    // regresses cannot quietly put unsourced claims in front of a customer.
    if (!z.source || !z.severity || !z.confidence) { droppedZones++; continue; }
    zoneRows.push({
      rep_slug: slug,
      factor: String(z.factor || "other").toLowerCase(),
      decks: (z.decks ?? []).map(Number).filter(Number.isFinite),
      sections: [...new Set((z.sections ?? []).map(normSection).filter(Boolean))],
      sides: [...new Set((z.sides ?? []).map(normSide).filter(Boolean))],
      what: z.what ?? null,
      effect: z.effect ?? null,
      matters_to: z.mattersTo ?? null,
      severity: String(z.severity).toLowerCase(),
      confidence: String(z.confidence).toLowerCase(),
      source: z.source,
    });
  }

  for (const l of doc.leads ?? []) {
    leadRows.push({
      rep_slug: slug,
      cabin_nums: parseCabinNums(l.cabins),
      raw_cabins: l.cabins ?? null,
      claim: l.claim ?? null,
      source: l.source ?? null,
      confidence: (l.confidence ?? "").toLowerCase() || null,
      verified: null,
    });
  }
}

// ── report before writing ────────────────────────────────────────────────────
console.log(`research files      : ${docs.length}`);
console.log(`zones               : ${zoneRows.length}${droppedZones ? `  (${droppedZones} dropped — missing source/severity/confidence)` : ""}`);
console.log(`leads               : ${leadRows.length} (${leadRows.reduce((n, l) => n + l.cabin_nums.length, 0)} cabin numbers named)`);
if (ships.length) {
  const inherited = assignments.filter((a) => a.inherited);
  console.log(`ships covered       : ${assignments.length} of ${ships.length}`);
  if (inherited.length) {
    console.log(`  inheriting a sister's research:`);
    for (const a of inherited) console.log(`    ${a.ship_slug}  <-  ${a.rep_slug}`);
  }
  if (orphans.length) {
    console.log(`  NO RESEARCH (and no sister to inherit from):`);
    for (const o of orphans) console.log(`    ${o.slug}  [${o.line} / ${o.class}]`);
  }
}
const bySeverity = zoneRows.reduce((m, z) => ((m[z.severity] = (m[z.severity] ?? 0) + 1), m), {});
console.log(`severity            :`, bySeverity);
const noSection = zoneRows.filter((z) => !z.sections.length).length;
if (noSection) console.log(`⚠ zones with no usable section: ${noSection} — these apply to the whole deck`);

if (SQL_OUT) {
  const q = (v) => v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
  const arr = (a, cast) => a?.length ? `ARRAY[${a.map((x) => cast === "int" ? Number(x) : q(x)).join(",")}]::${cast === "int" ? "integer" : "text"}[]` : `'{}'::${cast === "int" ? "integer" : "text"}[]`;
  const num = (v) => v === null || v === undefined || !Number.isFinite(Number(v)) ? "NULL" : Number(v);
  const L = [];
  L.push("BEGIN;");
  L.push("DELETE FROM public.cabin_context_leads; DELETE FROM public.cabin_context_zones;");
  L.push("DELETE FROM public.cabin_context_ships; DELETE FROM public.cabin_class_context;");
  for (const c of contextRows)
    L.push(`INSERT INTO public.cabin_class_context (rep_slug,class_label,line,ship_name,sister_ships,total_cabins,cabins_touched,model,web_searches,cost_usd,unknowns,researched_on) VALUES (${q(c.rep_slug)},${q(c.class_label)},${q(c.line)},${q(c.ship_name)},${arr(c.sister_ships)},${num(c.total_cabins)},${num(c.cabins_touched)},${q(c.model)},${num(c.web_searches)},${num(c.cost_usd)},${q(JSON.stringify(c.unknowns))}::jsonb,${q(c.researched_on)}::date);`);
  for (const a of assignments)
    L.push(`INSERT INTO public.cabin_context_ships (ship_slug,rep_slug,inherited,note) VALUES (${q(a.ship_slug)},${q(a.rep_slug)},${a.inherited},${q(a.note)});`);
  for (const z of zoneRows)
    L.push(`INSERT INTO public.cabin_context_zones (rep_slug,factor,decks,sections,sides,what,effect,matters_to,severity,confidence,source) VALUES (${q(z.rep_slug)},${q(z.factor)},${arr(z.decks, "int")},${arr(z.sections)},${arr(z.sides)},${q(z.what)},${q(z.effect)},${q(z.matters_to)},${q(z.severity)},${q(z.confidence)},${q(z.source)});`);
  for (const l of leadRows)
    L.push(`INSERT INTO public.cabin_context_leads (rep_slug,cabin_nums,raw_cabins,claim,source,confidence) VALUES (${q(l.rep_slug)},${arr(l.cabin_nums)},${q(l.raw_cabins)},${q(l.claim)},${q(l.source)},${q(l.confidence)});`);
  L.push("COMMIT;");
  const out = process.env.SQL_OUT_PATH || path.join(HERE, "context-load.sql");
  fs.writeFileSync(out, L.join("\n"));
  console.log(`\nwrote ${L.length} statements to ${out}`);
  process.exit(0);
}

if (DRY) { console.log("\n(dry run — nothing written)"); process.exit(0); }

// ── write ────────────────────────────────────────────────────────────────────
const step = async (label, fn) => {
  const { error } = await fn();
  if (error) { console.error(`\n${label} failed — ${error.message}`); process.exit(1); }
  console.log(`  ${label} ok`);
};

console.log("\nwriting:");
await step("cabin_class_context", () => db.from("cabin_class_context").upsert(contextRows, { onConflict: "rep_slug" }));
await step("cabin_context_ships", () => db.from("cabin_context_ships").upsert(assignments, { onConflict: "ship_slug" }));
// zones/leads have no natural key — replace wholesale so a re-run can't duplicate
await step("clear zones", () => db.from("cabin_context_zones").delete().neq("id", -1));
await step("clear leads", () => db.from("cabin_context_leads").delete().neq("id", -1));
for (let i = 0; i < zoneRows.length; i += 500)
  await step(`zones ${i + 1}-${Math.min(i + 500, zoneRows.length)}`, () => db.from("cabin_context_zones").insert(zoneRows.slice(i, i + 500)));
for (let i = 0; i < leadRows.length; i += 500)
  await step(`leads ${i + 1}-${Math.min(i + 500, leadRows.length)}`, () => db.from("cabin_context_leads").insert(leadRows.slice(i, i + 500)));

console.log(`\nloaded ${zoneRows.length} zones and ${leadRows.length} leads across ${contextRows.length} hull classes.`);
