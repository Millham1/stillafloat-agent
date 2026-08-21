// apply-leads.mjs — put the per-cabin research in cabin_context_leads onto the rooms.
//
// WHY: 330 leads naming 1,159 cabins across 41 hulls (4,209 rooms once sisters are expanded)
// have sat in the table since they were harvested, with `verified` NULL on every row. Nothing
// has ever read them. Mark, 2026-08-19: "what happened to all of the data we pulled".
//
// WHY NOT A REGEX: the claims are NOT all negative. "one detailed review of neighbouring suite
// 9212 found it very quiet" is a room being PRAISED; "named as THE EXCEPTION to the deck 8
// lifeboat obstruction" is a room being cleared. Pattern-matching these marks good rooms as
// bad — the same polarity inversion that forced the 31 named-view zones to be hand-reviewed.
// So each claim's polarity is read, and only negative ones are applied.
//
// WHAT IT WILL NOT DO
//   * never overwrite a value that is already there (fill-if-null, so it is idempotent)
//   * never invent a room — cabin numbers are intersected with the real grid
//   * never apply a low-confidence lead unless --include-low is passed
//
// Usage (on a box, so the keys stay there):
//   node apply-leads.mjs [--write] [--include-low]
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const WRITE = process.argv.includes("--write");
const INCLUDE_LOW = process.argv.includes("--include-low");
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
const AK = process.env.ANTHROPIC_API_KEY;
if (!url || !key || !AK) { console.error("SUPABASE_URL + SUPABASE_SERVICE_KEY + ANTHROPIC_API_KEY required"); process.exit(1); }
if (url.includes("gbjfrnrkkjnutmogdzln") && process.env.ALLOW_PROD !== "1") {
  console.error("PROD project detected and ALLOW_PROD!=1 — aborting."); process.exit(1);
}
const sb = createClient(url, key, { realtime: { transport: ws }, auth: { persistSession: false } });

const SYS = `You classify short research claims about specific cruise-ship cabins.

For EACH numbered claim return one object:
  id       the number given
  kind     "view"   the claim is about what can be SEEN from the room (lifeboats, structure, hull)
           "noise"  about what is HEARD (venues, elevators, crew areas, machinery)
           "motion" about how much the room MOVES
           "layout" about the room itself (a pillar, a shape, a smaller balcony, connecting)
           "other"  anything else
  polarity "negative" the claim is a WARNING about these cabins
           "positive" the claim says these cabins are GOOD, or names them as an EXCEPTION to
                      a problem described elsewhere
           "neutral"  a question, an unresolved rumour, or a statement carrying no verdict
  severity "heavy" | "partial" | "mild"   how bad, if negative; "mild" otherwise
  summary  ONE short guest-facing clause, lower case, no trailing period, describing what is
           there — e.g. "a lifeboat sits directly outside the window". Never mention the cruise
           line, never say "reportedly", never name a source.

POLARITY IS THE POINT. A claim that these particular cabins ESCAPE a problem is "positive".
A claim that someone ASKED whether there is a problem, with no answer, is "neutral".
Only mark "negative" when the claim asserts a downside for the cabins it names.

Return ONLY a JSON array, minified, one object per claim.`;

async function classify(batch) {
  const body = {
    model: "claude-sonnet-5", max_tokens: 4000, system: SYS,
    messages: [{ role: "user", content: batch.map((l, i) => `${i + 1}. ${l.claim}`).join("\n\n") }],
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": AK, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      const txt = j.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      const m = txt.match(/\[[\s\S]*\]/);
      if (!m) throw new Error("no JSON array in reply");
      return JSON.parse(m[0]);
    } catch (e) {
      if (attempt === 2) { console.error(`  batch failed: ${e.message}`); return null; }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

const { data: leads, error: le } = await sb.from("cabin_context_leads")
  .select("id,rep_slug,cabin_nums,claim,confidence,verified").order("id");
if (le) { console.error(le.message); process.exit(1); }

const { data: fleet } = await sb.from("cabin_ships").select("slug,derived_from").eq("in_fleet", true);
const family = new Map();
for (const s of fleet) {
  const rep = s.derived_from || s.slug;
  family.set(rep, [...(family.get(rep) ?? []), s.slug]);
}

const usable = leads.filter((l) => (l.cabin_nums ?? []).length);
console.log(`${leads.length} leads, ${usable.length} name cabins`);

const verdicts = new Map();
for (let i = 0; i < usable.length; i += 10) {
  const batch = usable.slice(i, i + 10);
  const out = await classify(batch);
  if (out) for (const v of out) {
    const lead = batch[(v.id ?? 0) - 1];
    if (lead) verdicts.set(lead.id, v);
  }
  console.log(`  classified ${Math.min(i + 10, usable.length)}/${usable.length}`);
}

const tally = {};
for (const v of verdicts.values()) {
  const k = `${v.kind}/${v.polarity}`;
  tally[k] = (tally[k] ?? 0) + 1;
}
console.log("\nclaims by kind/polarity:");
for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${n}`);

let roomsView = 0, roomsNote = 0, applied = 0, skipped = 0, notInGrid = 0;
for (const lead of usable) {
  const v = verdicts.get(lead.id);
  if (!v) { skipped++; continue; }
  const lowOk = INCLUDE_LOW || lead.confidence !== "low";
  const negative = v.polarity === "negative";
  if (!negative || !lowOk) { skipped++; if (WRITE) await sb.from("cabin_context_leads").update({ verified: false }).eq("id", lead.id); continue; }

  const ships = family.get(lead.rep_slug) ?? [lead.rep_slug];
  const nums = lead.cabin_nums.map(String);
  const { data: real } = await sb.from("cabins").select("id,obstruction,note")
    .in("ship_slug", ships).in("cabin_num", nums);
  if (!real?.length) { notInGrid++; continue; }

  const lead9 = v.severity === "heavy" ? "heavy" : v.severity === "partial" ? "partial-side" : "partial-low";
  if (v.kind === "view") {
    const ids = real.filter((r) => r.obstruction === null).map((r) => r.id);
    if (ids.length && WRITE) {
      for (let i = 0; i < ids.length; i += 500) {
        await sb.from("cabins").update({ obstruction: `${lead9}: ${v.summary}` }).in("id", ids.slice(i, i + 500));
      }
    }
    roomsView += ids.length;
  } else {
    const ids = real.filter((r) => r.note === null).map((r) => r.id);
    if (ids.length && WRITE) {
      for (let i = 0; i < ids.length; i += 500) {
        await sb.from("cabins").update({ note: v.summary }).in("id", ids.slice(i, i + 500));
      }
    }
    roomsNote += ids.length;
  }
  applied++;
  if (WRITE) await sb.from("cabin_context_leads").update({ verified: true }).eq("id", lead.id);
}

console.log(`\nleads applied: ${applied}, set aside: ${skipped}, named no room in the grid: ${notInGrid}`);
console.log(`rooms gaining obstruction: ${roomsView.toLocaleString()}`);
console.log(`rooms gaining note       : ${roomsNote.toLocaleString()}`);
console.log(WRITE ? "\nwritten. `verified` now records which leads were applied (true) and which were set aside (false)."
                  : "\n(dry run — pass --write to apply)");
