// zone-polarity.mjs — audit the 478 research zones for claims filed under the wrong sign.
//
// FOUND 2026-08-19 by the e2e sweep: msc-poesia carries a `motion` zone whose text is
// "Deck 5 is a low, mostly-midship deck close to the waterline" — a description of the
// STEADIEST place on the hull, filed under the factor that means "this area moves". The
// advisor picks 5063 correctly and is then marked wrong by its own research.
//
// This is the same fault as the hump (a factor meaning "the balcony is BETTER here" listed
// beside lifeboats) and the same fault the named-cabin leads had. A zone whose prose praises
// an area, or names it as the EXCEPTION to a problem, must not be scored as a penalty.
//
// Reports only. Nothing is written — the fix for a mis-signed zone is a judgement call.
//
// ~40 calls: over the bulk-run line, so they go through the Message Batches API and need
// --approved-cost (Mark's quoted yes); --no-batch "<reason>" runs them one at a time.
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { bulkFlags, runBulk, messageText, MODELS } from "../server/src/lib/claude-core.mjs";

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error("need SUPABASE_URL + SUPABASE_SERVICE_KEY (and ANTHROPIC_API_KEY)"); process.exit(1); }
const sb = createClient(url, key, { realtime: { transport: ws }, auth: { persistSession: false } });

const SYS = `Each numbered item is a research note about an AREA of a cruise ship, already filed
under a FACTOR that is meant to describe a DOWNSIDE (lifeboat = blocked view, motion = moves
more, above/below/engine/elevator/i95 = noise, taper = narrowed view).

For each, return:
  id      the number given
  sign    "penalty"  the text really does describe a downside for that area
          "benefit"  the text describes an ADVANTAGE — a steadier spot, a better view, a
                     quieter stretch — or names the area as an EXCEPTION to a problem
          "neutral"  the text states a fact with no verdict either way
  why     at most 12 words, quoting the words that decide it

Judge ONLY the text. "Low and close to the waterline" is a BENEFIT for motion. "Midship" is a
BENEFIT for motion. "The hull steps out here so the balcony sees past the lifeboats" is a
BENEFIT for view. Return ONLY a minified JSON array.`;

const { data: zones } = await sb.from("cabin_context_zones")
  .select("id,rep_slug,factor,decks,sections,severity,confidence,what,effect").order("id");
const PENALTY_FACTORS = ["lifeboat", "motion", "above", "below", "engine", "elevator", "i95", "taper"];
const subject = zones.filter((z) => PENALTY_FACTORS.includes(z.factor));
console.log(`${zones.length} zones, ${subject.length} filed under a downside factor`);

function askParams(batch) {
  return { model: MODELS.DEFAULT, max_tokens: 4000, system: SYS,
    messages: [{ role: "user", content: batch.map((z, i) =>
      `${i + 1}. [factor=${z.factor}] ${(z.what || "") + " " + (z.effect || "")}`.slice(0, 900)).join("\n\n") }] };
}

const groups = [];
for (let i = 0; i < subject.length; i += 12) groups.push(subject.slice(i, i + 12));
let results;
try {
  ({ results } = await runBulk({
    job: "cabin.zone-polarity",
    requests: groups.map((g, gi) => ({ custom_id: `zones-${gi}`, params: askParams(g) })),
    expectedOutputTokens: 1200,
    ...bulkFlags(),
  }));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

const flagged = [];
groups.forEach((batch, gi) => {
  const r = results.get(`zones-${gi}`);
  let out = null;
  try { out = r?.ok ? JSON.parse(messageText(r.message).match(/\[[\s\S]*\]/)[0]) : null; }
  catch (e) { console.error(`  group ${gi} unparseable: ${e.message}`); }
  if (!r?.ok) console.error(`  group ${gi} failed: ${r?.error ?? "no result"}`);
  if (out) for (const v of out) {
    const z = batch[(v.id ?? 0) - 1];
    if (z && v.sign !== "penalty") flagged.push({ ...z, sign: v.sign, why: v.why });
  }
});

const byFactor = {};
for (const f of flagged) byFactor[`${f.factor}/${f.sign}`] = (byFactor[`${f.factor}/${f.sign}`] ?? 0) + 1;
console.log(`\n${flagged.length} of ${subject.length} zones are NOT the downside their factor claims:`);
for (const [k, n] of Object.entries(byFactor).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${n}`);

console.log(`\nrooms affected by each mis-signed zone:`);
for (const f of flagged.filter((x) => x.sign === "benefit")) {
  const { count } = await sb.from("cabins").select("id", { count: "exact", head: true })
    .eq("ship_slug", f.rep_slug).in("deck", f.decks);
  console.log(`  id=${f.id} ${f.rep_slug} ${f.factor} decks[${f.decks}] ~${count ?? "?"} rooms/hull — ${f.why}`);
}
